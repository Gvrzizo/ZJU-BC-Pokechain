import { randomBytes, randomUUID } from 'crypto';
import { HttpStatus, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { AppException } from '../common/utils/errors';
import { DeriveStream, sha256hex } from '../common/utils/crypto.util';
import { ChainAdapter } from '../fabric/chain.adapter';
import { ContractService } from '../fabric/contract.service';
import { ChainIdentity, SYSTEM_IDENTITY } from '../fabric/chain.types';
import { ZONE_IDS, ZoneDef, ZoneId, resolveZone, zoneSpeciesIds } from '../game-data/encounter.data';
import { getItemType } from '../game-data/items.data';
import { getSpecies } from '../game-data/species.data';
import { computeStats, normalizeEvs } from '../game-data/stats';
import { resolveOwnedBall } from './ball';
import { CATCH_REWARD_POINTS, catchRewardReason } from './points-economy';
import { SHINY_CHANCE, computeDnaHash, deriveAttempt, deriveWild, lureSpec } from './capture-derive';
import { grantLegendaryDexReward } from './legendary-reward';
import { loadWildSessionByEvent } from '../wild/wild-session';

/** 遇敌会话（Redis `capture:<eventId>`）：快速捕捉与野怪战斗共用同一事件与投球计数。 */
export interface CaptureSession {
  playerId: string;
  serverSeed: string;
  clientSeed: string;
  attempts: number;
  speciesId: number;
  wildLevel: number;
  /** 遇敌区域（决定野生池与等级带，docs/backend-api.md §2） */
  zoneId?: ZoneId;
  /** 付费诱饵档位（0 免费 / 1 = 50 积分 / 2 = 200 积分）；缺省按 0 */
  lureTier?: number;
  /** 闪光判定阈值：1/4096，诱饵 tier 2 → 1/1024；缺省按基准 */
  shinyChance?: number;
}

export const CAPTURE_SESSION_TTL_SEC = 3600;

/** 定时揭示登记：遭遇时写入到期时间，玩家放弃（会话过期）后由 sweep 揭示，避免事件永久 COMMITTED。 */
const CAPTURE_PENDING_KEY = 'capture:pending';
const CAPTURE_SEED_PREFIX = 'capture:seed:';
const EXPIRY_SWEEP_MS = 5 * 60_000;

export function captureSessionKey(eventId: string): string {
  return `capture:${eventId}`;
}

/** Capture orchestration (docs/backend-api.md §2): Commit-then-derive, consume ball -> judge -> Reveal -> Mint. */
@Injectable()
export class CaptureService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CaptureService.name);
  private sweeper?: NodeJS.Timeout;

  constructor(
    private readonly chain: ChainAdapter,
    private readonly contract: ContractService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit(): void {
    // 玩家放弃的遭遇（会话过期、事件仍 COMMITTED）→ 定时结算后揭示，保证公平性可复核
    this.sweeper = setInterval(() => void this.revealExpired(), EXPIRY_SWEEP_MS);
    this.sweeper.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  private sessionKey(eventId: string): string {
    return captureSessionKey(eventId);
  }

  /** 会话访问器：野怪战斗（wild/）读取种子并推进同一个投球计数。 */
  async loadSession(eventId: string): Promise<CaptureSession | null> {
    return this.redis.getJson<CaptureSession>(this.sessionKey(eventId));
  }

  async saveSession(eventId: string, session: CaptureSession): Promise<void> {
    await this.redis.setJson(this.sessionKey(eventId), session, CAPTURE_SESSION_TTL_SEC);
  }

  async clearSession(eventId: string): Promise<void> {
    await this.redis.del(this.sessionKey(eventId));
  }

  /**
   * 结算后揭示（H9）：只有事件仍为 COMMITTED 才 reveal，已 REVEALED/CONSUMED 直接跳过。
   * 读取失败会向上抛出（调用方保留定时任务，下一轮重试）。
   */
  async revealCommitted(eventId: string, serverSeed: string): Promise<boolean> {
    const random = await this.contract.getRandom(eventId);
    if (random.status !== 'COMMITTED') return false;
    await this.contract.revealAndVerify(SYSTEM_IDENTITY, eventId, serverSeed, {
      idemKey: `${eventId}-reveal`,
    });
    return true;
  }

  /**
   * 事件终态收尾：best-effort reveal（失败只告警并保留定时登记，由 5 分钟 sweep 重试），
   * 然后清理 `capture:pending` 登记。快速捕捉成功、野怪战斗终态都会调用。
   */
  async finalizeEvent(eventId: string, serverSeed: string): Promise<void> {
    try {
      await this.revealCommitted(eventId, serverSeed);
      await this.clearPending(eventId);
    } catch (err) {
      this.logger.warn(`reveal on finalize failed for ${eventId}: ${(err as Error).message}`);
    }
  }

  /**
   * 定时揭示玩家放弃的遭遇：`capture:pending` 的 score = 会话到期时间；
   * 种子另存 `capture:seed:<eventId>`（TTL 2×会话），所以会话过期后仍能 reveal。
   */
  async revealExpired(now = Date.now()): Promise<number> {
    const ids = await this.redis.client.zrangebyscore(CAPTURE_PENDING_KEY, 0, now).catch(() => [] as string[]);
    let revealed = 0;
    for (const eventId of ids) {
      try {
        const audit = await this.redis.getJson<{ serverSeed?: string }>(`${CAPTURE_SEED_PREFIX}${eventId}`);
        if (!audit?.serverSeed) {
          await this.clearPending(eventId);
          continue;
        }
        if (await this.revealCommitted(eventId, audit.serverSeed)) revealed += 1;
        await this.clearPending(eventId);
      } catch (err) {
        // 链暂时不可读：保留 zset 成员，下一轮再试（种子 TTL 过期后自然清理）
        this.logger.warn(`delayed reveal failed for ${eventId}: ${(err as Error).message}`);
      }
    }
    if (revealed > 0) this.logger.log(`revealed ${revealed} abandoned capture event(s)`);
    return revealed;
  }

  private async trackPending(eventId: string, serverSeed: string): Promise<void> {
    await this.redis.client.zadd(CAPTURE_PENDING_KEY, Date.now() + CAPTURE_SESSION_TTL_SEC * 1000, eventId);
    await this.redis.setJson(`${CAPTURE_SEED_PREFIX}${eventId}`, { serverSeed }, CAPTURE_SESSION_TTL_SEC * 2);
  }

  private async clearPending(eventId: string): Promise<void> {
    await this.redis.client.zrem(CAPTURE_PENDING_KEY, eventId).catch(() => undefined);
    await this.redis.del(`${CAPTURE_SEED_PREFIX}${eventId}`);
  }

  async encounter(as: ChainIdentity, clientSeedInput?: string, lureTierInput?: number, zoneIdInput?: string) {
    const tier = lureTierInput ?? 0;
    const lure = lureSpec(tier);
    if (!lure) {
      throw new AppException('INVALID_LURE_TIER', `lureTier must be 0, 1 or 2 (got ${String(lureTierInput)})`, HttpStatus.BAD_REQUEST);
    }
    // 区域（docs/backend-api.md §2「区域与栖息地野生池」）：未传按草丛；别名归一；非法 id 直接拒绝
    const zone = resolveZone(zoneIdInput);
    if (!zone) {
      throw new AppException(
        'INVALID_ZONE',
        `zoneId must be one of ${ZONE_IDS.join('|')} (aliases: south→route-grass, mid→route-mid, north→route-north) (got ${String(zoneIdInput)})`,
        HttpStatus.BAD_REQUEST,
      );
    }
    // 传说区门控（docs/backend-api.md §2「传说区」）：禁止诱饵 + 钥匙 + 每人每池一只。
    // 全部校验先于 Commit 与任何扣费：被拒时链上不留痕、积分不变。
    if (zone.legendary) {
      if (tier > 0) {
        throw new AppException(
          'LURE_NOT_ALLOWED',
          `${zone.name} 是传说区，禁止使用诱饵（lureTier=${tier}）`,
          HttpStatus.BAD_REQUEST,
        );
      }
      await this.assertLegendaryAccess(as, zone);
    }
    const serverSeed = randomBytes(32).toString('hex');
    const clientSeed = clientSeedInput && /^[0-9a-f]{8,64}$/i.test(clientSeedInput)
      ? clientSeedInput.toLowerCase()
      : randomBytes(16).toString('hex');
    const eventId = `ev_${randomUUID()}`;
    const commitHash = sha256hex(serverSeed);
    // 链上留痕：区域（决定 n=0 抽样池与 n=1 等级带）与付费诱饵档位，/fairness 可复核
    const meta = JSON.stringify({
      zone: zone.id,
      ...(lure.cost > 0 ? { lureTier: tier, cost: lure.cost } : {}),
    });

    // 0) paid lure: debit the points first (admin/system identity like /pokemon/:id/train),
    //    then bind {lureTier, cost} into the on-chain Commit meta so /fairness can audit it.
    if (lure.cost > 0) {
      await this.contract.addPoints(SYSTEM_IDENTITY, as.userId, -lure.cost, `lure:tier${tier}`, {
        idemKey: `${eventId}-lure`,
      });
    }

    // 1) commit first (on-chain), 2) derive afterwards from the verified stream
    try {
      await this.contract.commitRandom(as, {
        eventId,
        purpose: 'capture',
        playerId: as.userId,
        commitHash,
        clientSeed,
        meta,
      });
    } catch (err) {
      // 承诺失败（极少见）→ 尽力退还诱饵费用，避免玩家白扣分
      if (lure.cost > 0) {
        await this.contract
          .addPoints(SYSTEM_IDENTITY, as.userId, lure.cost, `lure-refund:tier${tier}`, {
            idemKey: `${eventId}-lure-refund`,
          })
          .catch(() => undefined);
      }
      throw err;
    }

    const stream = new DeriveStream(serverSeed, clientSeed, eventId);
    const { species, level } = deriveWild(stream, zone, lure.levelBonus);
    const shinyChance = SHINY_CHANCE * lure.shinyMultiplier;

    const session: CaptureSession = {
      playerId: as.userId,
      serverSeed,
      clientSeed,
      attempts: 0,
      speciesId: species.id,
      wildLevel: level,
      zoneId: zone.id,
      lureTier: tier,
      shinyChance,
    };
    await this.redis.setJson(this.sessionKey(eventId), session, CAPTURE_SESSION_TTL_SEC);
    await this.trackPending(eventId, serverSeed);

    return {
      eventId,
      zone: {
        id: zone.id,
        name: zone.name,
        minLevel: zone.minLevel,
        maxLevel: zone.maxLevel,
        maxStage: zone.maxStage,
        habitats: [...zone.habitats],
        legendary: zone.legendary === true,
        keyTypeId: zone.keyTypeId ?? null,
        keyNameZh: zone.keyTypeId ? (getItemType(zone.keyTypeId)?.nameZh ?? null) : null,
      },
      wild: {
        speciesId: species.id,
        name: species.name,
        nameZh: species.nameZh,
        level,
        previewSpriteUri: species.spriteUri,
        // 官方种族捕获率（3–255），供无队伍时的降级路径（快速捕捉）前端显示成功率
        catchRate: species.catchRate,
      },
      lure: { tier, cost: lure.cost, levelBonus: lure.levelBonus, shinyMultiplier: lure.shinyMultiplier },
      commitHash,
      clientSeed,
    };
  }

  /**
   * 传说区进入校验（docs/backend-api.md §2「传说区门控」）：
   * ① 背包里有对应钥匙——本人名下 `status=IDLE`、`quantity≥1` 的该 typeId 堆叠，**不消耗**；
   *    没有则 403 `KEY_REQUIRED`（消息同时带 typeId 与中文名）。
   * ② 本人**尚未拥有**该区任一传说种族——`QueryByOwner` 按 speciesId 过滤（含交易/对战锁定中）；
   *    已拥有则 409 `LEGENDARY_OWNED`。放生（ownerId 置空）或交易走后即可再来（每人每池一只）。
   */
  private async assertLegendaryAccess(as: ChainIdentity, zone: ZoneDef): Promise<void> {
    const keyTypeId = zone.keyTypeId;
    const keyType = keyTypeId ? getItemType(keyTypeId) : undefined;
    const stacks = await this.contract.queryItemsByOwner(as.userId);
    const held = stacks.some((item) => item.typeId === keyTypeId && item.status === 'IDLE' && item.quantity >= 1);
    if (!held) {
      throw new AppException(
        'KEY_REQUIRED',
        `${zone.name}需要${keyType?.nameZh ?? ''}（${keyTypeId}）才能进入，背包里没有可用的钥匙`,
        HttpStatus.FORBIDDEN,
      );
    }
    const poolIds = new Set(zoneSpeciesIds(zone));
    const owned = await this.contract.queryPokemonByOwner(as.userId);
    const alreadyOwned = owned.find((p) => poolIds.has(p.speciesId));
    if (alreadyOwned) {
      const species = getSpecies(alreadyOwned.speciesId);
      throw new AppException(
        'LEGENDARY_OWNED',
        `你已经拥有 ${species?.nameZh ?? alreadyOwned.speciesId}，传说仅此一只（放生或交易走后可再来）`,
        HttpStatus.CONFLICT,
      );
    }
  }

  async attempt(as: ChainIdentity, eventId: string, ballItemId: string) {
    const session = await this.redis.getJson<CaptureSession>(this.sessionKey(eventId));
    if (!session || session.playerId !== as.userId) {
      throw new AppException('UNKNOWN_EVENT', `no active capture session for ${eventId}`, HttpStatus.BAD_REQUEST);
    }
    // 同一 eventId 上的野怪战斗已结束（捕捉/击倒/逃跑/超时）：快速捕捉路径同样拒绝，
    // 避免在野怪已倒下或事件已消费后继续投球。
    const wild = await loadWildSessionByEvent(this.redis, eventId).catch(() => null);
    if (wild?.finished) {
      throw new AppException(
        'WILD_BATTLE_FINISHED',
        `wild battle on ${eventId} is ${wild.status}; start a new encounter`,
        HttpStatus.CONFLICT,
      );
    }
    const { item: ballItem, bonus } = await resolveOwnedBall(this.contract, as.userId, ballItemId);

    const attemptNo = session.attempts + 1;
    // 1) consume the ball (idempotent per attempt number)
    await this.contract.consumeItem(as, ballItem.id, 1, 'capture', {
      idemKey: `${eventId}-attempt-${attemptNo}`,
    });

    // 2) deterministic judgement from the stream (H9：判定期间不 reveal，首球不再泄露后续结果)
    const stream = new DeriveStream(session.serverSeed, session.clientSeed, eventId);
    const species = getSpecies(session.speciesId);
    if (!species) {
      throw new AppException('UNKNOWN_SPECIES', `species ${session.speciesId} not in table`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
    const result = deriveAttempt(stream, attemptNo, species.catchRate, bonus, session.shinyChance ?? SHINY_CHANCE);

    if (!result.success) {
      session.attempts = attemptNo;
      await this.redis.setJson(this.sessionKey(eventId), session, CAPTURE_SESSION_TTL_SEC);
      return {
        success: false as const,
        shakes: result.shakes,
        attempt: attemptNo,
        catchRoll: result.catchRoll,
        threshold: result.threshold,
      };
    }

    // 3) 结算后揭示：投中（要铸宝可梦）才 Reveal；失败/放弃仍保持 COMMITTED，/fairness 不返回 serverSeed
    await this.revealCommitted(eventId, session.serverSeed);

    // 4) mint the captured pokemon (consumes the random on-chain)
    const pokemonId = `p_${randomUUID()}`;
    const dnaHash = computeDnaHash(species.id, result.ivs, result.nature, result.shiny, eventId);
    const pokemon = await this.contract.mintFromCapture(
      SYSTEM_IDENTITY,
      {
        id: pokemonId,
        playerId: as.userId,
        speciesId: species.id,
        name: species.name,
        ivs: result.ivs,
        nature: result.nature,
        ability: species.ability,
        shiny: result.shiny,
        moves: species.defaultMoves.slice(0, 4),
        dnaHash,
        eventId,
      },
      { idemKey: `${eventId}-mint` },
    );
    if (session.wildLevel > pokemon.level) {
      await this.contract.applyGrowth(
        SYSTEM_IDENTITY,
        pokemonId,
        { level: session.wildLevel },
        { idemKey: `${eventId}-level` },
      );
      pokemon.level = session.wildLevel;
    }
    // freshly minted: evs all zero, stats derived from base + IV + level + nature
    const evs = normalizeEvs(pokemon.evs);
    pokemon.evs = evs;
    pokemon.stats = computeStats(species.base, result.ivs, evs, pokemon.level, result.nature);
    // 收服奖励：+20 积分（idemKey 用链上归还的 pokemon.id，投球重放不会重复加分）
    await this.contract.addPoints(SYSTEM_IDENTITY, as.userId, CATCH_REWARD_POINTS, catchRewardReason(pokemon.id), {
      idemKey: `${pokemon.id}-reward-catch`,
    });
    // H13：传说图鉴 6/6 → 大师球（幂等；失败只告警，不打断捕捉）
    await grantLegendaryDexReward(this.contract, as.userId, this.logger);
    await this.redis.del(this.sessionKey(eventId));
    await this.clearPending(eventId);
    return { success: true as const, pokemon, catchReward: CATCH_REWARD_POINTS };
  }
}
