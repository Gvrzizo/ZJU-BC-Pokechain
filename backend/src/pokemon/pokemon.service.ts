import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { RedisService } from '../common/redis/redis.service';
import { AppException } from '../common/utils/errors';
import { ChainEventsService } from '../fabric/chain-events.service';
// --- [FEAT:dex] begin ---
import { DexService } from '../dex/dex.service';
// --- [FEAT:dex] end ---
import { ContractService } from '../fabric/contract.service';
import { ChainIdentity, GrowthPatch, PokemonState, SYSTEM_IDENTITY } from '../fabric/chain.types';
import { zonesForSpecies } from '../game-data/encounter.data';
import { EVOLUTIONS, getSpecies, SPECIES } from '../game-data/species.data';
import { getItemType } from '../game-data/items.data';
import { PokemonRename } from './entities/pokemon-rename.entity';
import { applyLearned, movesCrossing, movesKnownAt } from './learnset';
import { normalizePokemonName } from './pokemon-name';
import {
  EvolutionStep,
  canEvolveNow,
  evolutionSteps,
  levelEvolutionRule,
  stoneEvolutionRule,
} from './evolution';
import {
  RENAME_COST,
  RELEASE_POINTS_PER_LEVEL,
  releaseRewardReason,
  renameChargeIdemKey,
  renameIdemKey,
  renameReason,
} from './points-economy';
import { CENTER_HEAL_COST, PokemonHpService } from './pokemon-hp.service';
import {
  applyTrainingEvs,
  bondBonusPercent,
  computeStats,
  evTotal,
  EV_MAX_TOTAL,
  normalizeEvs,
  offenseStatOf,
} from '../game-data/stats';

const LIST_CACHE_TTL_SEC = 5;

/** 每点训练花费换 4 EV（单项 255 / 总和 510 封顶，见 docs/backend-api.md §2）。 */
const EV_PER_POINT = 4;

/** 等级上限（exp 曲线 level = floor(cbrt(exp))，只升不降）。 */
export const LEVEL_MAX = 100;

/** 收服成功时出战宝可梦获得的经验（wild/ 调用 applyExp 发放）。 */
export const CAPTURE_EXP_GAIN = 20;

/** PvP 胜利时参战队伍每只获得的经验（battles 结算调用 grantBattleWinExp）。 */
export const BATTLE_WIN_EXP_GAIN = 30;

/** 等级 = floor(cbrt(exp))，封顶 100；与链上 ApplyGrowth 的"只升不降"配合使用。 */
export function levelFromExp(exp: number): number {
  return Math.min(LEVEL_MAX, Math.floor(Math.cbrt(Math.max(0, exp))));
}

/** 一次经验结算的结果（升级路径统一从这里返回，见 docs/backend-api.md §2）。 */
export interface ExpOutcome {
  pokemon: PokemonView;
  /** 本次提升的等级数 */
  levelsGained: number;
  /** 本次跨阈值学会的技能（按学习顺序；满 4 招时替换最早学的） */
  movesLearned: string[];
  /** 结算后是否已满足等级进化条件（前端"可以进化！"提示） */
  canEvolve: boolean;
}

/** API 形态的宝可梦：链上字段 + 链下算出的最终能力值与进化信息。 */
export interface PokemonView extends PokemonState {
  /** 默认展示的进化分支（无进化/图鉴外为 null） */
  evolution: EvolutionStep | null;
  /** 全部进化分支（伊布三条石头线等），"可以进化"的分支排在最前 */
  evolutions: EvolutionStep[];
  /** 当前 HP（链下 Redis `poke:hp:<id>`，缺键 = 满血）；上限为 `stats.hp` */
  currentHp: number;
  /** 是否濒死（currentHp = 0，不能出战/进队伍，需伤药或宝可梦中心治疗） */
  fainted: boolean;
  /**
   * 羁绊战斗加成百分比（展示用，两位小数）：非 HP 五项在战斗中 × (1 + bond/255 × 5%)，
   * 满羁绊（255）为 5%、128 为 2.51%（docs/backend-api.md §2「羁绊加成」/ §11）。
   * `stats` 仍是链下基础最终值（不含羁绊），战斗引擎在出战时会把这个加成算进去。
   */
  bondBonus: number;
  /**
   * 改名次数（链下 PG `pokemon_rename`，0/缺省 = 从未改名）。
   * `GET /pokemon` / `GET /pokemon/:id` 附带，用于前端显示"首次免费 / 本次 50P"（docs/backend-api.md §2）。
   */
  renameCount?: number;
}

/** `POST /pokemon/:id/rename` 的响应（docs/backend-api.md §2「改名」）。 */
export interface RenameResult {
  /** 改名后的链上 name（昵称） */
  name: string;
  /** 改名后的累计次数（第一次改名后为 1） */
  renameCount: number;
  /** 本次是否扣费（第一次免费为 false） */
  charged: boolean;
}

/** 读链后的视图：最终能力值 + 进化信息（当前 HP 由 PokemonHpService 在链下附加）。 */
type PokemonBaseView = Omit<PokemonView, 'currentHp' | 'fainted'>;

/** 链上不存最终能力值：读链后按 种族值+IV+EV+等级+性格 计算六项能力值，并附上进化信息。 */
function withComputedStats(pokemon: PokemonState): PokemonBaseView {
  const species = getSpecies(pokemon.speciesId);
  const evs = normalizeEvs(pokemon.evs);
  pokemon.evs = evs;
  if (species) {
    pokemon.stats = computeStats(species.base, pokemon.ivs, evs, pokemon.level, pokemon.nature);
  }
  const evolutions = evolutionSteps(pokemon.speciesId, pokemon.level);
  return {
    ...pokemon,
    evolution: evolutions[0] ?? null,
    evolutions,
    bondBonus: bondBonusPercent(pokemon.bond),
  };
}

@Injectable()
export class PokemonService implements OnModuleInit {
  private readonly logger = new Logger(PokemonService.name);

  constructor(
    private readonly contract: ContractService,
    private readonly redis: RedisService,
    private readonly events: ChainEventsService,
    /** 当前 HP / 治疗（链下 Redis，docs/backend-api.md §2「伤势持久化」） */
    readonly hp: PokemonHpService,
    /** 改名次数（链下 PG，docs/backend-api.md §2「改名」） */
    @InjectRepository(PokemonRename) private readonly renames: Repository<PokemonRename>,
    // --- [FEAT:dex] begin ---
    private readonly dex: DexService,
    // --- [FEAT:dex] end ---
  ) {}

  onModuleInit(): void {
    // chain-event driven cache invalidation (docs/backend-api.md §8)
    this.events.stream$.subscribe(({ name, payload }) => {
      const owner = payload.ownerId ?? payload.toId;
      if (
        ['PokemonMinted', 'PokemonTransferred', 'PokemonGrowth', 'PokemonReleased'].includes(name) &&
        typeof owner === 'string' &&
        owner
      ) {
        void this.redis.del(`cache:pokemon:${owner}`).catch(() => undefined);
      }
    });
  }

  /** 链上视图 + 当前 HP（Redis 缺键 = 满血）。 */
  private async withHp(base: PokemonBaseView): Promise<PokemonView> {
    const view = await this.hp.load(base as unknown as PokemonState);
    return { ...base, currentHp: view.currentHp, fainted: view.fainted };
  }

  /** 改名次数（链下 PG；无记录 = 0，即从未改名）。 */
  private async renameCountOf(pokemonId: string): Promise<number> {
    const row = await this.renames.findOne({ where: { pokemonId } });
    return row?.count ?? 0;
  }

  /** 批量取改名次数（列表用一次查询，避免 N+1）。 */
  private async renameCountsOf(pokemonIds: string[]): Promise<Map<string, number>> {
    if (pokemonIds.length === 0) return new Map();
    const rows = await this.renames.find({ where: { pokemonId: In(pokemonIds) } });
    return new Map(rows.map((row) => [row.pokemonId, row.count]));
  }

  async listMine(username: string): Promise<PokemonView[]> {
    const key = `cache:pokemon:${username}`;
    const cached = await this.redis.getJson<PokemonView[]>(key).catch(() => null);
    if (cached) return cached;
    const bases = (await this.contract.queryPokemonByOwner(username)).map(withComputedStats);
    const counts = await this.renameCountsOf(bases.map((base) => base.id));
    const hp = await this.hp.loadMany(bases as unknown as PokemonState[]);
    const list: PokemonView[] = bases.map((base) => {
      const view = hp.get(base.id);
      return {
        ...base,
        renameCount: counts.get(base.id) ?? 0,
        currentHp: view?.currentHp ?? base.stats?.hp ?? 1,
        fainted: view?.fainted ?? false,
      };
    });
    await this.redis.setJson(key, list, LIST_CACHE_TTL_SEC).catch(() => undefined);
    return list;
  }

  async getOne(id: string): Promise<PokemonView> {
    const base = withComputedStats(await this.contract.getPokemon(id));
    base.renameCount = await this.renameCountOf(id);
    return this.withHp(base);
  }

  /**
   * 详情（H1 / docs/review-2026-10-25.md）：**仅本人可读**。IV/EV/性格/羁绊属于私密养成数据，
   * 非本人一律按「不存在」处理（404），不返回链上完整对象、也不泄露他人资产是否存在。
   */
  async getOneForUser(id: string, requester: string): Promise<PokemonView> {
    // 不存在与「不是本人」返回同一个 404：调用方无法据此枚举他人的资产 id
    const state = await this.contract.getPokemon(id).catch(() => null);
    if (!state || state.ownerId !== requester) {
      throw new AppException('NOT_FOUND', `pokemon ${id} does not exist`, HttpStatus.NOT_FOUND);
    }
    const base = withComputedStats(state);
    base.renameCount = await this.renameCountOf(id);
    return this.withHp(base);
  }

  async pokedex(username: string) {
    const mine = await this.listMine(username);
    const owned = new Map<number, number>();
    for (const p of mine) owned.set(p.speciesId, (owned.get(p.speciesId) ?? 0) + 1);
    // 当前持有的种族补记一笔（覆盖交易/押注赢来的宝可梦），再与历史解锁取并集
    await this.dex.record(username, [...owned.keys()]);
    const unlocked = await this.dex.list(username);
    return Object.values(SPECIES).map((s) => ({
      speciesId: s.id,
      name: s.name,
      nameZh: s.nameZh,
      type: s.type,
      spriteUri: s.spriteUri,
      ownedCount: owned.get(s.id) ?? 0,
      /** 永久解锁：进化后低阶种族仍然显示为已捕获 */
      unlocked: unlocked.has(s.id) || (owned.get(s.id) ?? 0) > 0,
      /**
       * 该种族会出现的区域（栖息地反查，`GET /capture/zones` 提供区域详情）：
       * 普通区按等级带 + 属性栖息地过滤，传说种族只出现在对应的传说区；从不出现的为 []。
       */
      habitatOf: zonesForSpecies(s.id),
      legendary: s.legendary === true,
      /**
       * 该种族的进化分支（图鉴详情展示进化链与条件）；无进化为 []。
       * 图鉴条目不对应具体个体，等级一律按 0 传（levelOk/canEvolveNow 恒 false，只展示条件）。
       */
      evolutions: evolutionSteps(s.id, 0),
    }));
  }

  private async mustOwn(as: ChainIdentity, id: string): Promise<PokemonState> {
    const pokemon = await this.contract.getPokemon(id);
    if (pokemon.ownerId !== as.userId) {
      throw new AppException('NOT_OWNER', `pokemon ${id} is not yours`, HttpStatus.FORBIDDEN);
    }
    // H7：训练/改名/进化/放生等写入必须在消耗道具或扣积分之前拒绝锁定资产
    if (pokemon.status !== 'IDLE') {
      throw new AppException('ASSET_LOCKED', `pokemon ${id} is ${pokemon.status}`, HttpStatus.CONFLICT);
    }
    return pokemon;
  }

  /**
   * 花积分特训：**只加努力值**（1 积分 = 4 EV，单项 255 / 总和 510 封顶）。
   * 升级只走经验（野怪/收服/PvP/神奇糖果），个体值只走王冠类道具——积分不再直接换等级，
   * 否则「花积分直接堆等级」会破坏经济与养成平衡（docs/backend-api.md §2、§10）。
   *
   * 只调用 AddPoints + ApplyGrowth(evs)：不改 exp/level。
   */
  async train(as: ChainIdentity, id: string, costPoints: number): Promise<PokemonView> {
    if (!Number.isSafeInteger(costPoints) || costPoints <= 0) {
      throw new AppException('INVALID_AMOUNT', 'costPoints must be a positive integer', HttpStatus.BAD_REQUEST);
    }
    const pokemon = await this.mustOwn(as, id);
    const species = getSpecies(pokemon.speciesId);
    if (!species) {
      throw new AppException('UNKNOWN_SPECIES', `species ${pokemon.speciesId} not in table`, HttpStatus.BAD_REQUEST);
    }
    const currentEvs = normalizeEvs(pokemon.evs);
    const evs = applyTrainingEvs(currentEvs, offenseStatOf(species.base), costPoints * EV_PER_POINT);
    if (evTotal(evs) === evTotal(currentEvs)) {
      throw new AppException(
        'EV_MAXED',
        `EVs are already at the ${EV_MAX_TOTAL} total cap`,
        HttpStatus.CONFLICT,
      );
    }
    await this.contract.addPoints(SYSTEM_IDENTITY, as.userId, -costPoints, 'train');
    // EVs are applied as a single growth patch: the chain re-validates 255/510.
    const updated = await this.contract.applyGrowth(SYSTEM_IDENTITY, id, { evs });
    return this.withHp(withComputedStats(updated));
  }

  /**
   * 改名（`POST /pokemon/:id/rename`，docs/backend-api.md §2「改名」）：
   * **第一次免费，之后每次 `RENAME_COST`（50P）**，次数存链下 PG `pokemon_rename`。
   *
   * - 校验顺序：昵称格式（trim / 折叠空白 / 1-12 码点 / 拒绝控制字符与 `<>&"'`）→ 归属 → `IDLE`；
   * - `ordinal = 已改名次数 + 1`（第一次改名 ordinal=1 免费，之后 `ordinal > 1` 每次扣 50P）；
   * - 扣费 `AddPoints(-50, reason='rename:<pokemonId>:<ordinal>')` 与链上 `ApplyGrowth({name})`
   *   都用由 `ordinal` 派生的确定性幂等键（**两个键必须不同**，链上幂等记录是全局命名空间）：
   *   中途失败后重试不会重复扣分，也不会"花一次钱改出多个名字"；
   * - 新昵称与当前链上 `name` 相同视为空操作（不扣分、不计数、不发交易）。
   */
  async rename(as: ChainIdentity, id: string, rawName: string): Promise<RenameResult> {
    const name = normalizePokemonName(rawName);
    const pokemon = await this.mustOwn(as, id);
    const record = await this.renames.findOne({ where: { pokemonId: id } });
    const renamed = record?.count ?? 0;
    if (name === pokemon.name) {
      return { name: pokemon.name, renameCount: renamed, charged: false };
    }
    const ordinal = renamed + 1;
    const charged = ordinal > 1;
    if (charged) {
      const player = await this.contract.getPlayer(as.userId);
      if (player.points < RENAME_COST) {
        throw new AppException(
          'INSUFFICIENT_POINTS',
          `rename costs ${RENAME_COST}P, balance ${player.points}`,
          HttpStatus.BAD_REQUEST,
        );
      }
      await this.contract.addPoints(SYSTEM_IDENTITY, as.userId, -RENAME_COST, renameReason(id, ordinal), {
        idemKey: renameChargeIdemKey(id, ordinal),
      });
    }
    const updated = await this.contract.applyGrowth(SYSTEM_IDENTITY, id, { name }, { idemKey: renameIdemKey(id, ordinal) });
    if (record) record.count = ordinal;
    await this.renames.save(record ?? this.renames.create({ pokemonId: id, count: ordinal }));
    await this.redis.del(`cache:pokemon:${as.userId}`).catch(() => undefined);
    this.logger.log(`renamed ${id} to "${name}" (ordinal ${ordinal}, charged=${charged})`);
    return { name: updated.name, renameCount: ordinal, charged };
  }

  /**
   * 集中升级路径（所有经验来源都走这里）：野怪击倒、收服成功、PvP 胜利、神奇糖果。
   *
   * - exp 曲线维持 `level = floor(cbrt(exp))`（只升不降，封顶 100）；
   * - 升级时按该种族学习表学技能（跨过阈值即学；满 4 招替换最早学的非最新技能）；
   * - 返回 {levelsGained, movesLearned, canEvolve}，供战斗结算/道具接口展示。
   */
  async applyExp(
    pokemon: PokemonState,
    gain: number,
    opts: { idemKey?: string } = {},
  ): Promise<ExpOutcome> {
    const safeGain = Number.isFinite(gain) ? Math.max(0, Math.floor(gain)) : 0;
    if (safeGain === 0) {
      return {
        pokemon: await this.withHp(withComputedStats(pokemon)),
        levelsGained: 0,
        movesLearned: [],
        canEvolve: canEvolveNow(pokemon.speciesId, pokemon.level),
      };
    }
    const exp = (pokemon.exp ?? 0) + safeGain;
    const level = Math.min(LEVEL_MAX, Math.max(pokemon.level, levelFromExp(exp)));
    const candidates = movesCrossing(pokemon.speciesId, pokemon.level, level, pokemon.moves);
    const { moves, learned } = applyLearned(pokemon.moves, candidates);
    const patch: GrowthPatch = { exp, level };
    if (learned.length > 0) patch.moves = moves;
    const updated = await this.contract.applyGrowth(
      SYSTEM_IDENTITY,
      pokemon.id,
      patch,
      opts.idemKey ? { idemKey: opts.idemKey } : undefined,
    );
    return {
      pokemon: await this.withHp(withComputedStats(updated)),
      levelsGained: Math.max(0, updated.level - pokemon.level),
      movesLearned: learned,
      canEvolve: canEvolveNow(updated.speciesId, updated.level),
    };
  }

  /**
   * PvP 胜利经验：参战队伍每只 +gain（默认 30），逐只走 applyExp。
   * **接线点**：battles 结算（SETTLED + 有胜者）时调用；`battleId` 作幂等键前缀，
   * 重放同一场战局不会重复加经验。单只失败只记日志，不影响结算。
   */
  async grantBattleWinExp(
    playerId: string,
    pokemonIds: string[],
    battleId: string,
    gain: number = BATTLE_WIN_EXP_GAIN,
  ): Promise<Array<{ pokemonId: string; levelsGained: number; movesLearned: string[] }>> {
    const granted: Array<{ pokemonId: string; levelsGained: number; movesLearned: string[] }> = [];
    for (const pokemonId of pokemonIds) {
      try {
        const pokemon = await this.contract.getPokemon(pokemonId);
        if (pokemon.ownerId !== playerId) continue;
        const outcome = await this.applyExp(pokemon, gain, { idemKey: `${battleId}-exp-${pokemonId}` });
        granted.push({
          pokemonId,
          levelsGained: outcome.levelsGained,
          movesLearned: outcome.movesLearned,
        });
      } catch (err) {
        this.logger.warn(`battle win exp for ${pokemonId} failed: ${(err as Error).message}`);
      }
    }
    return granted;
  }

  /**
   * 进化（docs/backend-api.md §2）：
   * - 不带 `stoneItemId` → **等级进化**（EVOLUTIONS 里纯等级分支且等级达标，不消耗道具）；
   * - 带 `stoneItemId` → 进化石进化（消耗 1 个对应石头，等级条件同样要满足）。
   * 两种路径都走链上 ApplyGrowth(speciesId)，并按**新种族学习表补学**已达等级的技能。
   */
  async evolve(as: ChainIdentity, id: string, stoneItemId?: string): Promise<PokemonView> {
    const pokemon = await this.mustOwn(as, id);
    if (!stoneItemId) return this.evolveByLevel(pokemon);
    return this.evolveWithStone(as, pokemon, stoneItemId);
  }

  private async evolveByLevel(pokemon: PokemonState): Promise<PokemonView> {
    const rule = levelEvolutionRule(pokemon.speciesId, pokemon.level);
    if (!rule) {
      const levelRule = EVOLUTIONS.find((e) => e.from === pokemon.speciesId && !e.stoneTypeId);
      if (levelRule) {
        throw new AppException(
          'LEVEL_TOO_LOW',
          `needs level ${levelRule.minLevel}, is ${pokemon.level}`,
          HttpStatus.BAD_REQUEST,
        );
      }
      throw new AppException(
        'NO_EVOLUTION',
        `${pokemon.name} has no level-up evolution (an evolution stone may be required)`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.applyEvolution(pokemon, rule.to);
  }

  private async evolveWithStone(
    as: ChainIdentity,
    pokemon: PokemonState,
    stoneItemId: string,
  ): Promise<PokemonView> {
    const stone = await this.contract.getItem(stoneItemId).catch(() => null);
    if (!stone || stone.ownerId !== as.userId) {
      throw new AppException('NOT_OWNER', `stone ${stoneItemId} is not yours`, HttpStatus.FORBIDDEN);
    }
    const stoneType = getItemType(stone.typeId);
    if (!stoneType || stoneType.kind !== 'stone') {
      throw new AppException('NOT_A_STONE', `${stone.typeId} is not an evolution stone`, HttpStatus.BAD_REQUEST);
    }
    const rule = stoneEvolutionRule(pokemon.speciesId, stone.typeId);
    if (!rule) {
      throw new AppException('NO_EVOLUTION', `${pokemon.name} cannot evolve with ${stone.typeId}`, HttpStatus.BAD_REQUEST);
    }
    if (pokemon.level < rule.minLevel) {
      throw new AppException('LEVEL_TOO_LOW', `needs level ${rule.minLevel}, is ${pokemon.level}`, HttpStatus.BAD_REQUEST);
    }
    await this.contract.consumeItem(as, stoneItemId, 1, 'evolve');
    return this.applyEvolution(pokemon, rule.to);
  }

  /** 链上换种族（链码 ApplyGrowth speciesId）+ 新学习表补学已达等级的技能。 */
  private async applyEvolution(pokemon: PokemonState, targetSpeciesId: number): Promise<PokemonView> {
    const target = SPECIES[targetSpeciesId];
    const candidates = movesKnownAt(targetSpeciesId, pokemon.level, pokemon.moves);
    const { moves, learned } = applyLearned(pokemon.moves, candidates);
    const patch: GrowthPatch = { speciesId: targetSpeciesId };
    // 改过名（链下 PG 有计数记录）的宝可梦进化后保留昵称，不覆盖成新种族名
    if ((await this.renameCountOf(pokemon.id)) === 0) {
      patch.name = target?.name ?? pokemon.name;
    }
    if (learned.length > 0) patch.moves = moves;
    const updated = await this.contract.applyGrowth(SYSTEM_IDENTITY, pokemon.id, patch);
    // 进化后低阶种族也要留在图鉴里
    await this.dex.record(pokemon.ownerId, [pokemon.speciesId, targetSpeciesId]);
    return this.withHp(withComputedStats(updated));
  }

  async release(as: ChainIdentity, id: string) {
    const pokemon = await this.mustOwn(as, id);
    const released = await this.contract.releasePokemon(as, id);
    await this.grantReleaseReward(as.userId, id, pokemon.level);
    // 资产已放生：清掉伤势键，别在 Redis 里留下永久孤儿
    await this.hp.clear(id);
    return this.withHp(withComputedStats(released));
  }

  /**
   * 放生奖励：等级 × 1 积分（reason=reward:release:<pokemonId>，idemKey 按宝可梦固定）。
   *
   * 顺序固定为「先 Release 再发积分」：链上 Release 不可回滚，若发积分失败，玩家少拿一份奖励
   * （这里只记告警；宝可梦 ownerId 已置空，重试会被 NOT_OWNER 拒绝，无法补发）——但反过来
   * 先发积分再放生会出现「没有放生却拿到积分」的不一致，更严重，所以顺序不可颠倒。
   */
  private async grantReleaseReward(playerId: string, pokemonId: string, level: number): Promise<void> {
    const points = level * RELEASE_POINTS_PER_LEVEL;
    try {
      await this.contract.addPoints(SYSTEM_IDENTITY, playerId, points, releaseRewardReason(pokemonId), {
        idemKey: `${pokemonId}-reward-release`,
      });
    } catch (err) {
      this.logger.warn(`release reward for ${pokemonId} failed: ${(err as Error).message}`);
    }
  }

  /**
   * 宝可梦中心（`POST /pokemon/center/heal`，docs/backend-api.md §10）：**全队回满，每次 10 积分**。
   *
   * - 只治疗本人 `IDLE` 的宝可梦（对战中/交易锁定的资产不参与）；
   * - 全员满血时**不扣费**（`charged=false`），避免误点白花积分；
   * - 扣费走 `AddPoints(-10, reason='heal:center')`，回血是链下 Redis 写入（无链上交易）。
   */
  async centerHeal(as: ChainIdentity): Promise<{
    cost: number;
    charged: boolean;
    points: number;
    healed: Array<{ pokemonId: string; speciesId: number; name: string; before: number; after: number; maxHp: number }>;
  }> {
    const owned = (await this.contract.queryPokemonByOwner(as.userId)).filter((p) => p.status === 'IDLE');
    const injured: Array<{ pokemon: PokemonState; before: number; maxHp: number }> = [];
    for (const pokemon of owned) {
      const maxHp = this.hp.maxHpOf(pokemon);
      const before = await this.hp.currentHp(pokemon);
      if (before < maxHp) injured.push({ pokemon, before, maxHp });
    }
    if (injured.length === 0) {
      const player = await this.contract.getPlayer(as.userId).catch(() => null);
      return { cost: CENTER_HEAL_COST, charged: false, points: player?.points ?? 0, healed: [] };
    }
    const player = await this.contract.addPoints(SYSTEM_IDENTITY, as.userId, -CENTER_HEAL_COST, 'heal:center');
    const healed = [];
    for (const entry of injured) {
      await this.hp.set(entry.pokemon.id, entry.maxHp, entry.maxHp);
      healed.push({
        pokemonId: entry.pokemon.id,
        speciesId: entry.pokemon.speciesId,
        name: entry.pokemon.name,
        before: entry.before,
        after: entry.maxHp,
        maxHp: entry.maxHp,
      });
    }
    await this.redis.del(`cache:pokemon:${as.userId}`).catch(() => undefined);
    this.logger.log(`center heal for ${as.userId}: ${healed.length} pokemon, -${CENTER_HEAL_COST}P`);
    return { cost: CENTER_HEAL_COST, charged: true, points: player.points, healed };
  }
}
