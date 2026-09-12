import { randomBytes, randomUUID } from 'crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { AppException } from '../common/utils/errors';
import { DeriveStream, sha256hex } from '../common/utils/crypto.util';
import { ChainAdapter } from '../fabric/chain.adapter';
import { ContractService } from '../fabric/contract.service';
import { ChainIdentity, SYSTEM_IDENTITY } from '../fabric/chain.types';
import { getSpecies } from '../game-data/species.data';
import { computeStats, normalizeEvs } from '../game-data/stats';
import { resolveOwnedBall } from './ball';
import { CATCH_REWARD_POINTS, catchRewardReason } from './points-economy';
import {
  DEFAULT_TEAM_TOP_LEVEL,
  SHINY_CHANCE,
  computeDnaHash,
  deriveAttempt,
  deriveWild,
  lureSpec,
} from './capture-derive';
import { loadWildSessionByEvent } from '../wild/wild-session';

/** 遇敌会话（Redis `capture:<eventId>`）：快速捕捉与野怪战斗共用同一事件与投球计数。 */
export interface CaptureSession {
  playerId: string;
  serverSeed: string;
  clientSeed: string;
  attempts: number;
  speciesId: number;
  wildLevel: number;
  /** 付费诱饵档位（0 免费 / 1 = 50 积分 / 2 = 200 积分）；缺省按 0 */
  lureTier?: number;
  /** 闪光判定阈值：1/4096，诱饵 tier 2 → 1/1024；缺省按基准 */
  shinyChance?: number;
}

export const CAPTURE_SESSION_TTL_SEC = 3600;

export function captureSessionKey(eventId: string): string {
  return `capture:${eventId}`;
}

/** Capture orchestration (docs/backend-api.md §2): Commit-then-derive, consume ball -> Reveal -> judge -> Mint. */
@Injectable()
export class CaptureService {
  constructor(
    private readonly chain: ChainAdapter,
    private readonly contract: ContractService,
    private readonly redis: RedisService,
  ) {}

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

  async encounter(as: ChainIdentity, clientSeedInput?: string, lureTierInput?: number) {
    const tier = lureTierInput ?? 0;
    const lure = lureSpec(tier);
    if (!lure) {
      throw new AppException('INVALID_LURE_TIER', `lureTier must be 0, 1 or 2 (got ${String(lureTierInput)})`, HttpStatus.BAD_REQUEST);
    }
    const serverSeed = randomBytes(32).toString('hex');
    const clientSeed = clientSeedInput && /^[0-9a-f]{8,64}$/i.test(clientSeedInput)
      ? clientSeedInput.toLowerCase()
      : randomBytes(16).toString('hex');
    const eventId = `ev_${randomUUID()}`;
    const commitHash = sha256hex(serverSeed);

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
        ...(lure.cost > 0 ? { meta: JSON.stringify({ lureTier: tier, cost: lure.cost }) } : {}),
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
    const teamTopLevel = await this.teamTopLevel(as.userId);
    const { species, level } = deriveWild(stream, teamTopLevel, lure.levelBonus);
    const shinyChance = SHINY_CHANCE * lure.shinyMultiplier;

    const session: CaptureSession = {
      playerId: as.userId,
      serverSeed,
      clientSeed,
      attempts: 0,
      speciesId: species.id,
      wildLevel: level,
      lureTier: tier,
      shinyChance,
    };
    await this.redis.setJson(this.sessionKey(eventId), session, CAPTURE_SESSION_TTL_SEC);

    return {
      eventId,
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
      teamTopLevel,
      commitHash,
      clientSeed,
    };
  }

  /** 队伍水平线：owner 名下 IDLE 宝可梦的最高等级；无队伍按 5（新账号第一只也有合理强度）。 */
  private async teamTopLevel(playerId: string): Promise<number> {
    const owned = await this.contract.queryPokemonByOwner(playerId).catch(() => []);
    const levels = owned.filter((p) => p.status === 'IDLE').map((p) => p.level);
    return levels.length > 0 ? Math.max(...levels) : DEFAULT_TEAM_TOP_LEVEL;
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

    // 2) reveal the committed server seed (only the first attempt transitions COMMITTED -> REVEALED)
    const random = await this.contract.getRandom(eventId);
    if (random.status === 'COMMITTED') {
      await this.contract.revealAndVerify(SYSTEM_IDENTITY, eventId, session.serverSeed, {
        idemKey: `${eventId}-reveal`,
      });
    }

    // 3) deterministic judgement from the verified stream
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
    await this.redis.del(this.sessionKey(eventId));
    return { success: true as const, pokemon, catchReward: CATCH_REWARD_POINTS };
  }
}
