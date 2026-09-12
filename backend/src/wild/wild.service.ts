import { randomUUID } from 'crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { AppException } from '../common/utils/errors';
import { DeriveStream, sha256hex } from '../common/utils/crypto.util';
import { ContractService } from '../fabric/contract.service';
import { ChainIdentity, PokemonState, SYSTEM_IDENTITY } from '../fabric/chain.types';
import { getItemType } from '../game-data/items.data';
import { getMove, MoveDef } from '../game-data/moves.data';
import { getSpecies, SpeciesDef } from '../game-data/species.data';
import { computeStats, emptyEvs, normalizeEvs } from '../game-data/stats';
import { CaptureService } from '../pokemon/capture.service';
import { CAPTURE_EXP_GAIN, PokemonService } from '../pokemon/pokemon.service';
import { BondService } from '../ranked/bond.service';
import { resolveOwnedBall } from '../pokemon/ball';
import {
  MASTER_BALL_BONUS,
  SHINY_CHANCE,
  captureProbability,
  computeDnaHash,
  deriveCaptureRoll,
  deriveWildDrop,
  deriveWildSpecimen,
  deriveWildTurn,
} from '../pokemon/capture-derive';
import {
  CATCH_REWARD_POINTS,
  WILD_FAINT_POINTS_PER_LEVEL,
  catchRewardReason,
  wildFaintRewardReason,
} from '../pokemon/points-economy';
import { resolveWildAttack, resolveWildTurn, wildExpGain } from './wild-battle';
import {
  WILD_SESSION_TTL_SEC,
  WildBattleEvent,
  WildCombatant,
  WildSession,
  WildStatus,
  activePokemon,
  loadWildSession,
  loadWildSessionByEvent,
  wildEventKey,
  wildSessionKey,
} from './wild-session';

export interface WildAction {
  type: 'move' | 'ball' | 'run' | 'switch';
  moveId?: string;
  ballItemId?: string;
  /** switch 的目标（链上宝可梦 id，须在队伍里且未濒死） */
  targetPokemonId?: string;
}

/**
 * 野怪（PvE）战斗捕捉流程（docs/backend-api.md §2）：
 * `POST /capture/encounter` 的 eventId → `POST /wild/start` 开启服务端权威会话 →
 * `POST /wild/:id/action` 出招/投球/换宠/逃跑。判定全部来自该事件的派生流
 * （capture-derive.ts），会话状态存 Redis wild:<sessionId>，TTL 15 分钟。
 */
@Injectable()
export class WildService {
  private readonly logger = new Logger(WildService.name);

  constructor(
    private readonly contract: ContractService,
    private readonly capture: CaptureService,
    private readonly pokemon: PokemonService,
    private readonly bond: BondService,
    private readonly redis: RedisService,
  ) {}

  private stream(session: WildSession): DeriveStream {
    return new DeriveStream(session.serverSeed, session.clientSeed, session.eventId);
  }

  private async save(session: WildSession): Promise<void> {
    await this.redis.setJson(wildSessionKey(session.sessionId), session, WILD_SESSION_TTL_SEC);
    // plain string, not JSON — loadWildSessionByEvent reads it back with GET
    await this.redis.set(wildEventKey(session.eventId), session.sessionId, WILD_SESSION_TTL_SEC);
    // 伤势持久化（docs/backend-api.md §2）：每次落盘顺带把参战队伍当前 HP 写回 Redis，
    // 会话超时被回收也不会把伤势丢掉
    await this.pokemon.hp.persistMany(
      session.party.map((m) => ({ pokemonId: m.pokemonId, hp: m.hp, maxHp: m.maxHp })),
    );
  }

  /**
   * 开启野怪战斗：要求一个仍然有效的 encounter（`capture:<eventId>` 会话）。
   * 队伍 = 链上 owner 名下 status=IDLE **且非濒死**的宝可梦（等级降序，以链下 Redis 的
   * 当前 HP 出战）；首发默认等级最高者，可用 partyPokemonId 指定（濒死抛 `FAINTED`）。
   * 同一 eventId 幂等：重复 start 返回同一会话与当前状态。
   */
  async start(as: ChainIdentity, eventId: string, partyPokemonId?: string) {
    const existing = await loadWildSessionByEvent(this.redis, eventId);
    if (existing) {
      this.assertOwner(existing, as);
      return this.view(existing);
    }
    const random = await this.contract.getRandom(eventId).catch(() => null);
    if (!random) {
      throw new AppException('UNKNOWN_EVENT', `random event ${eventId} does not exist`, HttpStatus.NOT_FOUND);
    }
    if (random.purpose !== 'capture' || random.playerId !== as.userId) {
      throw new AppException('NOT_OWNER', `capture event ${eventId} is not yours`, HttpStatus.FORBIDDEN);
    }
    if (random.status === 'CONSUMED') {
      throw new AppException('EVENT_CONSUMED', `capture event ${eventId} was already used to mint`, HttpStatus.CONFLICT);
    }
    const captureSession = await this.capture.loadSession(eventId);
    if (!captureSession || captureSession.playerId !== as.userId) {
      throw new AppException(
        'UNKNOWN_EVENT',
        `no active encounter for ${eventId}; call POST /capture/encounter first`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const species = getSpecies(captureSession.speciesId);
    if (!species) {
      throw new AppException('UNKNOWN_SPECIES', `species ${captureSession.speciesId} not in table`, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const stream = new DeriveStream(captureSession.serverSeed, captureSession.clientSeed, eventId);
    const specimen = deriveWildSpecimen(stream, captureSession.shinyChance ?? SHINY_CHANCE);
    const wildStats = computeStats(
      species.base,
      specimen.ivs,
      emptyEvs(),
      captureSession.wildLevel,
      specimen.nature,
    );
    const wild: WildCombatant = {
      pokemonId: '',
      speciesId: species.id,
      name: species.name,
      nameZh: species.nameZh,
      type: species.type,
      level: captureSession.wildLevel,
      shiny: specimen.shiny,
      ivs: specimen.ivs,
      nature: specimen.nature,
      ...wildStats,
      maxHp: wildStats.hp,
      moves: species.defaultMoves.map((id) => getMove(id)).filter((m): m is MoveDef => !!m).slice(0, 4),
      stages: { atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 },
      status: null,
      exp: 0,
      bond: 0,
    };
    const candidates = await this.pickTeam(as.userId);
    // 伤势持久化（docs/backend-api.md §2）：以链下 Redis 的当前 HP 出战，**濒死（0 HP）不能出战**
    const hpViews = await this.pokemon.hp.loadMany(candidates);
    const healthy = candidates.filter((p) => !hpViews.get(p.id)?.fainted);
    if (healthy.length === 0) {
      throw new AppException(
        'FAINTED',
        'all of your pokemon have fainted; heal them at the pokemon center first',
        HttpStatus.CONFLICT,
      );
    }
    const party = healthy.map((p) => this.toCombatant(p, hpViews.get(p.id)?.currentHp));
    let activeIndex = 0;
    if (partyPokemonId) {
      const index = party.findIndex((p) => p.pokemonId === partyPokemonId);
      if (index < 0) {
        const owned = candidates.find((p) => p.id === partyPokemonId);
        if (owned) {
          throw new AppException(
            'FAINTED',
            `${partyPokemonId} has fainted and cannot be sent out`,
            HttpStatus.CONFLICT,
          );
        }
        throw new AppException(
          'INVALID_PARTY_POKEMON',
          `${partyPokemonId} is not an IDLE pokemon of ${as.userId}`,
          HttpStatus.BAD_REQUEST,
        );
      }
      activeIndex = index;
    }

    const now = Date.now();
    const session: WildSession = {
      sessionId: `w_${randomUUID()}`,
      eventId,
      playerId: as.userId,
      serverSeed: captureSession.serverSeed,
      clientSeed: captureSession.clientSeed,
      turn: 1,
      attempts: 0,
      status: 'ACTIVE',
      finished: false,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + WILD_SESSION_TTL_SEC * 1000,
      expGained: 0,
      party,
      activeIndex,
      mustSwitch: false,
      wild,
      log: [{ turn: 0, events: [{ kind: 'encounter', detail: { wildLevel: wild.level, wildSpeciesId: wild.speciesId } }] }],
    };
    await this.save(session);
    return this.view(session);
  }

  /** 当前会话状态（重进战斗界面用；已结束的会话同样返回终态）。 */
  async get(as: ChainIdentity, sessionId: string) {
    const session = await this.mustSession(sessionId);
    this.assertOwner(session, as);
    return this.view(session);
  }

  /**
   * 一个回合：出招（move）/ 投球（ball）/ 换宠（switch）/ 逃跑（run）。已结束或超时的
   * 会话不再推进，直接返回终态（幂等，前端可安全重放请求）。出战宝可梦濒死且还有
   * 可换成员时只接受 switch（MUST_SWITCH）。
   */
  async action(as: ChainIdentity, sessionId: string, action: WildAction) {
    const session = await this.mustSession(sessionId);
    this.assertOwner(session, as);
    if (!session.finished && Date.now() > session.expiresAt) {
      this.finish(session, 'TIMEOUT', [{ kind: 'timeout', detail: { ttlSec: WILD_SESSION_TTL_SEC } }]);
      await this.save(session);
    }
    if (session.finished) return this.view(session);

    if (session.mustSwitch && action.type !== 'switch') {
      throw new AppException(
        'MUST_SWITCH',
        'your pokemon fainted, send out another one first',
        HttpStatus.CONFLICT,
      );
    }

    if (action.type === 'move') await this.doMove(session, action.moveId);
    else if (action.type === 'ball') await this.doThrowBall(as, session, action.ballItemId);
    else if (action.type === 'run') this.doRun(session);
    else if (action.type === 'switch') this.doSwitch(session, action.targetPokemonId);
    else throw new AppException('INVALID_ACTION', `unknown action type ${String(action.type)}`, HttpStatus.BAD_REQUEST);

    await this.save(session);
    return this.view(session);
  }

  // ---------------------------------------------------------------- actions

  private async doMove(session: WildSession, moveId?: string): Promise<void> {
    const active = activePokemon(session);
    const move = active.moves.find((m) => m.id === moveId);
    if (!move) {
      throw new AppException(
        'UNKNOWN_MOVE',
        `${active.name} does not know ${moveId ?? '(missing moveId)'}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const events = resolveWildTurn(
      active,
      session.wild,
      move,
      deriveWildTurn(this.stream(session), session.turn),
    );
    this.record(session, events);
    session.turn += 1;
    await this.resolveFaints(session, active);
  }

  /** 换宠：主动换宠消耗本回合（野怪出招一次，换入者吃当回合伤害）；濒死强制换宠不额外挨打。 */
  private doSwitch(session: WildSession, targetPokemonId?: string): void {
    if (!targetPokemonId) {
      throw new AppException('INVALID_ACTION', 'targetPokemonId is required for a switch action', HttpStatus.BAD_REQUEST);
    }
    const index = session.party.findIndex((p) => p.pokemonId === targetPokemonId);
    if (index < 0) {
      throw new AppException('INVALID_SWITCH', `${targetPokemonId} is not in your party`, HttpStatus.BAD_REQUEST);
    }
    if (index === session.activeIndex) {
      throw new AppException('SWITCH_TO_ACTIVE', 'that pokemon is already on the field', HttpStatus.BAD_REQUEST);
    }
    const target = session.party[index];
    if (target.hp <= 0) {
      throw new AppException('SWITCH_TO_FAINTED', 'that pokemon has fainted', HttpStatus.BAD_REQUEST);
    }

    const forced = session.mustSwitch;
    session.activeIndex = index;
    session.mustSwitch = false;
    this.record(session, [
      { kind: 'switch', side: 'player', detail: { pokemonId: target.pokemonId, forced } },
    ]);
    if (forced) return;

    const events = resolveWildAttack(
      target,
      session.wild,
      deriveWildTurn(this.stream(session), session.turn),
    );
    this.record(session, events);
    session.turn += 1;
    if (target.hp <= 0) this.handlePlayerFaint(session);
  }

  private async doThrowBall(as: ChainIdentity, session: WildSession, ballItemId?: string): Promise<void> {
    if (!ballItemId) {
      throw new AppException('INVALID_ACTION', 'ballItemId is required for a ball action', HttpStatus.BAD_REQUEST);
    }
    const ball = await resolveOwnedBall(this.contract, as.userId, ballItemId);
    const species = getSpecies(session.wild.speciesId);
    if (!species) {
      throw new AppException('UNKNOWN_SPECIES', `species ${session.wild.speciesId} not in table`, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const attemptNo = session.attempts + 1;
    // 1) consume the ball (idempotent per attempt number, shared with the quick path)
    await this.contract.consumeItem(as, ball.item.id, 1, 'capture', {
      idemKey: `${session.eventId}-attempt-${attemptNo}`,
    });
    await this.syncCaptureAttempts(session, attemptNo);
    session.attempts = attemptNo;

    // 2) reveal the committed server seed (only the first attempt transitions COMMITTED -> REVEALED)
    const random = await this.contract.getRandom(session.eventId);
    if (random.status === 'COMMITTED') {
      await this.contract.revealAndVerify(SYSTEM_IDENTITY, session.eventId, session.serverSeed, {
        idemKey: `${session.eventId}-reveal`,
      });
    }

    // 3) official-style catch probability for the wild mon's current HP
    const chance = captureProbability(session.wild.maxHp, session.wild.hp, species.catchRate, ball.bonus);
    const roll = deriveCaptureRoll(this.stream(session), attemptNo, chance);
    const events: WildBattleEvent[] = [
      {
        kind: 'ball',
        side: 'player',
        detail: {
          itemId: ball.item.id,
          typeId: ball.item.typeId,
          attempt: attemptNo,
          chance: roll.threshold,
          catchRoll: roll.catchRoll,
          success: roll.success,
        },
      },
    ];

    if (roll.success) {
      const pokemon = await this.mint(session, as.userId, species);
      events.push({ kind: 'caught', detail: { pokemonId: pokemon.id, shakes: roll.shakes } });
      this.record(session, events);
      this.finish(session, 'CAUGHT', [{ kind: 'end', detail: { reason: 'caught' } }]);
      return;
    }

    events.push({
      kind: 'ball-failed',
      side: 'player',
      detail: { shakes: roll.shakes, catchRoll: roll.catchRoll, threshold: roll.threshold },
    });
    // 4) a failed throw costs the turn: the wild mon answers with its derived move
    const active = activePokemon(session);
    const answer = resolveWildAttack(
      active,
      session.wild,
      deriveWildTurn(this.stream(session), session.turn),
    );
    events.push(...answer);
    this.record(session, events);
    session.turn += 1;

    if (active.hp <= 0) this.handlePlayerFaint(session);
  }

  private doRun(session: WildSession): void {
    this.record(session, [
      { kind: 'run', side: 'player', detail: {} },
      { kind: 'end', detail: { reason: 'run' } },
    ]);
    this.finish(session, 'RAN', []);
  }

  // ---------------------------------------------------------------- helpers

  /** 任意一方倒下后的分支：野怪倒下发经验结束；我方倒下能换则强制换宠，否则结束。 */
  private async resolveFaints(session: WildSession, active: WildCombatant): Promise<void> {
    if (session.wild.hp <= 0) {
      await this.grantExp(session, active);
      this.finish(session, 'WILD_FAINTED', [{ kind: 'end', detail: { reason: 'wild-fainted' } }]);
      return;
    }
    if (active.hp <= 0) this.handlePlayerFaint(session);
  }

  private handlePlayerFaint(session: WildSession): void {
    const alive = session.party.some((p) => p.hp > 0);
    if (!alive) {
      this.finish(session, 'PLAYER_FAINTED', [{ kind: 'end', detail: { reason: 'player-fainted' } }]);
      return;
    }
    session.mustSwitch = true;
  }

  /** 捕捉成功：走既有 Reveal→MintFromCapture 链路（eventId 状态机与 idemKey 保持不变）。 */
  private async mint(session: WildSession, playerId: string, species: SpeciesDef): Promise<PokemonState> {
    const { ivs, nature, shiny } = session.wild;
    const pokemonId = `p_${randomUUID()}`;
    const dnaHash = computeDnaHash(species.id, ivs, nature, shiny, session.eventId);
    const pokemon = await this.contract.mintFromCapture(
      SYSTEM_IDENTITY,
      {
        id: pokemonId,
        playerId,
        speciesId: species.id,
        name: species.name,
        ivs,
        nature,
        ability: species.ability,
        shiny,
        moves: species.defaultMoves.slice(0, 4),
        dnaHash,
        eventId: session.eventId,
      },
      { idemKey: `${session.eventId}-mint` },
    );
    if (session.wild.level > pokemon.level) {
      await this.contract.applyGrowth(
        SYSTEM_IDENTITY,
        pokemonId,
        { level: session.wild.level },
        { idemKey: `${session.eventId}-level` },
      );
      pokemon.level = session.wild.level;
    }
    const evs = normalizeEvs(pokemon.evs);
    pokemon.evs = evs;
    pokemon.stats = computeStats(species.base, ivs, evs, pokemon.level, nature);
    session.captured = pokemon;
    await this.capture.clearSession(session.eventId);
    // 收服奖励：+20 积分（用归还的 pokemon.id 作 idemKey，重放该动作不会重复加分）
    await this.grantCatchReward(session, pokemon.id);
    // 收服成功：出战宝可梦 +20 exp（走集中升级路径，docs/backend-api.md §2）
    await this.grantCaptureExp(session);
    // 收服成功：出战宝可梦羁绊 +1（BondService，每日每宠上限 +6，幂等键 <sessionId>-bond-catch）
    await this.grantBond(session, 'catch');
    // 战斗掉落（40000 区）：收服成功也有概率掉落道具
    await this.grantDrop(session);
    return pokemon;
  }

  /** 收服奖励走链上 AddPoints（system 身份，reason 可审计）。失败直接抛出：投球链路全部幂等，客户端重放即可补齐。 */
  private async grantCatchReward(session: WildSession, pokemonId: string): Promise<void> {
    await this.contract.addPoints(
      SYSTEM_IDENTITY,
      session.playerId,
      CATCH_REWARD_POINTS,
      catchRewardReason(pokemonId),
      { idemKey: `${pokemonId}-reward-catch` },
    );
    session.catchReward = CATCH_REWARD_POINTS;
  }

  /**
   * 战斗掉落（40000 区派生，docs/randomness.md §3）：收服成功或击倒野怪时按 20% 概率
   * 掉落一件道具（60% 伤药 / 30% 精灵球 / 10% 超级球），MintItem 给玩家（同 typeId 自动合并）。
   * idemKey 按会话固定，重放该动作不会重复掉落；失败直接抛出——与收服/击倒奖励同一策略
   * （会话未落盘，客户端重放即可幂等补齐）。
   */
  private async grantDrop(session: WildSession): Promise<void> {
    const drop = deriveWildDrop(this.stream(session));
    if (!drop) return;
    const type = getItemType(drop.typeId);
    const item = await this.contract.mintItem(
      SYSTEM_IDENTITY,
      {
        id: `i_${randomUUID()}`,
        playerId: session.playerId,
        typeId: drop.typeId,
        quantity: drop.quantity,
        uri: type?.uri ?? '',
        metadataHash: sha256hex(`${drop.typeId}|wild-drop`),
      },
      { idemKey: `${session.sessionId}-drop` },
    );
    session.drop = { typeId: drop.typeId, quantity: drop.quantity, itemId: item.id };
  }

  /** 击倒野怪：少量经验走集中升级路径（学技能 + 可进化检查；幂等，失败只记录告警，不影响战斗结算）。 */
  private async grantExp(session: WildSession, active: WildCombatant): Promise<void> {
    const species = getSpecies(session.wild.speciesId);
    if (!species) return;
    // 击倒奖励：野怪等级 × 1 积分。先发积分再走经验——积分失败会抛出，客户端重放该动作即可
    // 幂等补齐（会话未落盘、派生流与两边 idemKey 都不变）；经验仍保持原有的容忍策略。
    await this.grantFaintReward(session);
    const gain = wildExpGain(species.base, session.wild.level);
    const pokemon = await this.contract.getPokemon(active.pokemonId).catch(() => null);
    if (!pokemon) return;
    try {
      const outcome = await this.pokemon.applyExp(pokemon, gain, {
        idemKey: `${session.sessionId}-exp`,
      });
      active.exp = outcome.pokemon.exp;
      active.level = outcome.pokemon.level;
      session.expGained = gain;
      session.expGainedBy = active.pokemonId;
      session.levelsGained = outcome.levelsGained;
      session.movesLearned = outcome.movesLearned;
      session.canEvolve = outcome.canEvolve;
    } catch (err) {
      this.logger.warn(
        `wild exp growth failed for ${active.pokemonId}: ${(err as Error).message}`,
      );
    }
    // 击倒野怪：不再给羁绊（BOND_WILD_FAINT = 0 —— 陪伴只奖励"收服"，不奖励"打倒"）
    await this.grantBond(session, 'faint');
    // 战斗掉落（40000 区）：击倒野怪同样有概率掉落道具
    await this.grantDrop(session);
  }

  /**
   * 野怪战斗羁绊（BondService，docs/backend-api.md §2/§11）：收服成功 +1（每日每宠上限 +6）、击倒不给。
   * 幂等键 `<sessionId>-bond-<kind>`；失败**只记日志**——羁绊是附加奖励，
   * 且会话此刻已结束（重放只返回终态），抛错只会把成功的收服/击倒显示成失败。
   */
  private async grantBond(session: WildSession, kind: 'catch' | 'faint'): Promise<void> {
    const active = activePokemon(session);
    try {
      const granted = await this.bond.grantWildBond({
        sessionId: session.sessionId,
        playerId: session.playerId,
        pokemonId: active.pokemonId,
        kind,
      });
      if (!granted) return;
      active.bond = granted.after;
      session.bondGain = granted.delta;
      session.bondGainBy = granted.pokemonId;
    } catch (err) {
      this.logger.warn(`wild bond ${kind} for ${active.pokemonId} failed: ${(err as Error).message}`);
    }
  }

  /**
   * 收服成功：出战宝可梦 +20 exp（走集中升级路径，能学技能/提示可进化）。
   * 与击倒经验同样容忍失败：会话已经结束、事件已消费，抛错只会让玩家看到"投球失败"的假象。
   */
  private async grantCaptureExp(session: WildSession): Promise<void> {
    const active = activePokemon(session);
    const pokemon = await this.contract.getPokemon(active.pokemonId).catch(() => null);
    if (!pokemon) return;
    try {
      const outcome = await this.pokemon.applyExp(pokemon, CAPTURE_EXP_GAIN, {
        idemKey: `${session.sessionId}-capture-exp`,
      });
      active.exp = outcome.pokemon.exp;
      active.level = outcome.pokemon.level;
      session.expGained = CAPTURE_EXP_GAIN;
      session.expGainedBy = active.pokemonId;
      session.levelsGained = outcome.levelsGained;
      session.movesLearned = outcome.movesLearned;
      session.canEvolve = outcome.canEvolve;
    } catch (err) {
      this.logger.warn(
        `capture exp growth failed for ${active.pokemonId}: ${(err as Error).message}`,
      );
    }
  }

  /** 击倒奖励：野怪等级 × 1 积分（reason=reward:wild-faint:<sessionId>，idemKey 按会话固定）。 */
  private async grantFaintReward(session: WildSession): Promise<void> {
    const points = session.wild.level * WILD_FAINT_POINTS_PER_LEVEL;
    await this.contract.addPoints(
      SYSTEM_IDENTITY,
      session.playerId,
      points,
      wildFaintRewardReason(session.sessionId),
      { idemKey: `${session.sessionId}-reward-faint` },
    );
    session.faintReward = points;
  }

  /** 投球计数写回遇敌会话：快速捕捉与野怪战斗共用同一组 attempt 派生块。 */
  private async syncCaptureAttempts(session: WildSession, attemptNo: number): Promise<void> {
    const captureSession = await this.capture.loadSession(session.eventId);
    if (!captureSession || captureSession.playerId !== session.playerId) return;
    captureSession.attempts = Math.max(captureSession.attempts, attemptNo);
    await this.capture.saveSession(session.eventId, captureSession);
  }

  private record(session: WildSession, events: WildBattleEvent[]): void {
    if (events.length > 0) session.log.push({ turn: session.turn, events });
  }

  private finish(session: WildSession, status: WildStatus, events: WildBattleEvent[]): void {
    session.status = status;
    session.finished = true;
    this.record(session, events);
  }

  private assertOwner(session: WildSession, as: ChainIdentity): void {
    if (session.playerId !== as.userId) {
      throw new AppException('NOT_OWNER', `wild session ${session.sessionId} is not yours`, HttpStatus.FORBIDDEN);
    }
  }

  private async mustSession(sessionId: string): Promise<WildSession> {
    const session = await loadWildSession(this.redis, sessionId);
    if (!session) {
      throw new AppException(
        'WILD_SESSION_NOT_FOUND',
        `wild session ${sessionId} does not exist (finished sessions expire after ${WILD_SESSION_TTL_SEC}s)`,
        HttpStatus.NOT_FOUND,
      );
    }
    return session;
  }

  /** 队伍 = owner 名下 status=IDLE（未在交易/对战锁定、未释放）的宝可梦，按等级降序（并列取最早获得）。 */
  private async pickTeam(playerId: string): Promise<PokemonState[]> {
    const owned = await this.contract.queryPokemonByOwner(playerId);
    const candidates = owned.filter((p) => p.status === 'IDLE');
    if (candidates.length === 0) {
      throw new AppException(
        'NO_TEAM_POKEMON',
        'no IDLE pokemon available for the wild battle',
        HttpStatus.BAD_REQUEST,
      );
    }
    candidates.sort(
      (a, b) =>
        b.level - a.level ||
        (a.createdAt ?? '').localeCompare(b.createdAt ?? '') ||
        a.id.localeCompare(b.id),
    );
    return candidates;
  }

  private toCombatant(p: PokemonState, currentHp?: number): WildCombatant {
    const species = getSpecies(p.speciesId);
    if (!species) {
      throw new AppException('UNKNOWN_SPECIES', `species ${p.speciesId} not in table`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
    const moves = p.moves.map((id) => getMove(id)).filter((m): m is MoveDef => !!m).slice(0, 4);
    if (moves.length === 0) {
      throw new AppException('NO_MOVES', `${p.name} has no usable moves`, HttpStatus.CONFLICT);
    }
    const stats = computeStats(species.base, p.ivs, normalizeEvs(p.evs), p.level, p.nature, p.bond ?? 0);
    return {
      pokemonId: p.id,
      speciesId: species.id,
      name: species.name,
      nameZh: species.nameZh,
      type: species.type,
      level: p.level,
      shiny: p.shiny,
      ivs: p.ivs,
      nature: p.nature,
      ...stats,
      maxHp: stats.hp,
      /** 以链下 Redis 的当前 HP 出战（缺键 = 满血）；上界由 maxHp 保证 */
      hp: Math.min(stats.hp, Math.max(0, Math.floor(currentHp ?? stats.hp))),
      moves,
      stages: { atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 },
      status: null,
      exp: p.exp ?? 0,
      bond: p.bond ?? 0,
    };
  }

  /** 当前各球的捕捉成功率（官方公式，随野怪 HP 变化）——每次状态返回都重算。 */
  private async captureChances(playerId: string, species: SpeciesDef, wild: WildCombatant) {
    const items = await this.contract.queryItemsByOwner(playerId).catch(() => []);
    return items
      .filter((i) => i.status === 'IDLE' && i.quantity > 0 && getItemType(i.typeId)?.kind === 'ball')
      .map((i) => {
        const type = getItemType(i.typeId)!;
        const bonus = type.ballBonus ?? 1;
        return {
          itemId: i.id,
          typeId: i.typeId,
          name: type.name,
          nameZh: type.nameZh,
          quantity: i.quantity,
          ballBonus: bonus,
          chance: captureProbability(wild.maxHp, wild.hp, species.catchRate, bonus),
        };
      })
      .sort((a, b) => a.ballBonus - b.ballBonus);
  }

  private async view(session: WildSession) {
    const species = getSpecies(session.wild.speciesId);
    const active = activePokemon(session);
    return {
      sessionId: session.sessionId,
      eventId: session.eventId,
      turn: session.turn,
      status: session.status,
      finished: session.finished,
      attempts: session.attempts,
      expiresAt: session.expiresAt,
      expGained: session.expGained,
      expGainedBy: session.expGainedBy ?? null,
      /** 升级学习路径的结果（收服 +20 / 击倒经验）：见 docs/backend-api.md §2 */
      levelsGained: session.levelsGained ?? 0,
      movesLearned: session.movesLearned ?? [],
      canEvolve: session.canEvolve ?? false,
      /** 本会话已发放的羁绊（收服 +1，每日每宠上限 +6）与获得者 */
      bondGain: session.bondGain ?? 0,
      bondGainBy: session.bondGainBy ?? null,
      catchReward: session.catchReward ?? 0,
      faintReward: session.faintReward ?? 0,
      drop: session.drop
        ? {
            typeId: session.drop.typeId,
            name: getItemType(session.drop.typeId)?.name ?? session.drop.typeId,
            nameZh: getItemType(session.drop.typeId)?.nameZh ?? session.drop.typeId,
            quantity: session.drop.quantity,
            itemId: session.drop.itemId,
          }
        : null,
      activeIndex: session.activeIndex,
      mustSwitch: session.mustSwitch,
      wild: {
        speciesId: session.wild.speciesId,
        name: session.wild.name,
        nameZh: session.wild.nameZh,
        type: session.wild.type,
        level: session.wild.level,
        shiny: session.wild.shiny,
        hp: session.wild.hp,
        maxHp: session.wild.maxHp,
        moves: session.wild.moves.map((m) => m.id),
        status: session.wild.status,
        stages: session.wild.stages,
        catchRate: species?.catchRate ?? 0,
      },
      mine: {
        pokemonId: active.pokemonId,
        speciesId: active.speciesId,
        name: active.name,
        nameZh: active.nameZh,
        type: active.type,
        level: active.level,
        shiny: active.shiny,
        hp: active.hp,
        maxHp: active.maxHp,
        exp: active.exp,
        bond: active.bond,
        status: active.status,
        stages: active.stages,
        moves: active.moves.map((m) => ({
          id: m.id,
          name: m.name,
          type: m.type,
          power: m.power,
          accuracy: m.accuracy,
          category: m.category,
          effectText: m.effectText,
        })),
      },
      party: session.party.map((m, index) => ({
        pokemonId: m.pokemonId,
        speciesId: m.speciesId,
        name: m.name,
        nameZh: m.nameZh,
        type: m.type,
        level: m.level,
        shiny: m.shiny,
        hp: m.hp,
        maxHp: m.maxHp,
        exp: m.exp,
        status: m.status,
        fainted: m.hp <= 0,
        active: index === session.activeIndex,
      })),
      captureChances: species ? await this.captureChances(session.playerId, species, session.wild) : [],
      masterBallBonus: MASTER_BALL_BONUS,
      log: session.log,
      captured: session.captured ?? null,
    };
  }
}
