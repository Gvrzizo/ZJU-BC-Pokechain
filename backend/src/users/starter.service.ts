import { randomBytes, randomUUID } from 'crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { AppException } from '../common/utils/errors';
import { DeriveStream, sha256hex } from '../common/utils/crypto.util';
import { ContractService } from '../fabric/contract.service';
import { ChainIdentity, ItemState, PokemonState, SYSTEM_IDENTITY } from '../fabric/chain.types';
import { getItemType } from '../game-data/items.data';
import { getSpecies } from '../game-data/species.data';
import { computeStats, normalizeEvs } from '../game-data/stats';
import { SHINY_CHANCE, computeDnaHash, deriveWildSpecimen } from '../pokemon/capture-derive';

/** 御三家：妙蛙种子 / 小火龙 / 杰尼龟（game-data/species.data；作为新手领取发放，也可在野外遇到）。 */
export const STARTER_SPECIES_IDS: readonly number[] = [1, 4, 7];

/** 新手礼包（链上 MintItem，同 typeId 自动并入已有堆叠）。 */
export const STARTER_GIFT: ReadonlyArray<{ typeId: string; quantity: number }> = [
  { typeId: 'poke-ball', quantity: 5 },
  { typeId: 'potion', quantity: 2 },
];

/** 御三家铸造等级（MintFromCapture 固定 5 级，等级上限由链上 ApplyGrowth 校验）。 */
export const STARTER_LEVEL = 5;

/**
 * 领养事件 id 确定到用户名：整个流程（commit/reveal/mint）都围绕它幂等，
 * 并且 GET /users/me 的 hasStarter 只需读这一个事件的状态。
 */
export function starterEventId(playerId: string): string {
  return `starter-${playerId}`;
}

/** 中途失败重试时复用同一个 serverSeed（否则 RevealAndVerify 会 SEED_MISMATCH）。 */
function pendingSeedKey(playerId: string): string {
  return `starter:pending:${playerId}`;
}
const PENDING_SEED_TTL_SEC = 600;

/** 领取互斥锁：同一次点击/双击并发提交时只有一个请求进入承诺-揭示流程。 */
function claimLockKey(playerId: string): string {
  return `starter:lock:${playerId}`;
}
const CLAIM_LOCK_TTL_SEC = 30;

export interface StarterClaimResult {
  pokemon: PokemonState;
  /** 礼包堆叠（同 typeId 会自动并入已有堆叠，数量即合并后的持有量） */
  items: ItemState[];
  gift: ReadonlyArray<{ typeId: string; quantity: number }>;
}

/**
 * 新手起步流程（docs/backend-api.md §1「新手礼包」）：注册后仅一次，三选一御三家。
 *
 *   Commit(purpose='capture', meta='{"starter":true}')
 *     → RevealAndVerify → 派生流定 IV/性格/闪光
 *     → MintFromCapture(level 5, idemKey=starter-<playerId>) → 发礼包（精灵球×5 + 伤药×2）
 *
 * 每一步都用固定 idemKey（事件 id 确定到用户名），因此重试不会重复铸造：
 * CONSUMED 表示已经领过 → 409；COMMITTED/REVEALED 表示上次中途失败 → 用 Redis 里的
 * pending seed 续跑。
 */
@Injectable()
export class StarterService {
  constructor(
    private readonly contract: ContractService,
    private readonly redis: RedisService,
  ) {}

  /** 是否已领取过御三家（链上事件状态 CONSUMED 即 mint 已上链，与铸造在同一笔交易里）。 */
  async hasStarter(playerId: string): Promise<boolean> {
    const random = await this.contract.getRandom(starterEventId(playerId)).catch(() => null);
    return random?.status === 'CONSUMED';
  }

  async claim(as: ChainIdentity, speciesId: number): Promise<StarterClaimResult> {
    if (!STARTER_SPECIES_IDS.includes(speciesId)) {
      throw new AppException(
        'INVALID_SPECIES',
        `speciesId must be one of ${STARTER_SPECIES_IDS.join('|')} (got ${String(speciesId)})`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const species = getSpecies(speciesId);
    if (!species) {
      throw new AppException('UNKNOWN_SPECIES', `species ${speciesId} not in table`, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const eventId = starterEventId(as.userId);
    const existing = await this.contract.getRandom(eventId).catch(() => null);
    if (existing?.status === 'CONSUMED') {
      // 已领取：按约定重复调用返回 409。礼包用同一批 idemKey 幂等重放
      // （首次已发时是空操作，即使玩家把道具交易掉也不会补发新道具），
      // 这样「铸造成功但礼包那两笔失败」的重试不会让玩家永久少一份礼包。
      await this.grantGift(as.userId);
      throw new AppException(
        'STARTER_ALREADY_CLAIMED',
        `player ${as.userId} already claimed a starter pokemon`,
        HttpStatus.CONFLICT,
      );
    }

    // 并发双击保护：同一玩家的领取流程串行化（Redis TTL 兜底，正常路径在 finally 释放）。
    // 并发只可能造成"某个请求报错"，不会重复铸造——所有链上步骤都用固定 idemKey。
    const locked = await this.redis
      .setNx(claimLockKey(as.userId), '1', CLAIM_LOCK_TTL_SEC)
      .catch(() => true);
    if (!locked) {
      throw new AppException(
        'STARTER_IN_PROGRESS',
        `a starter claim for ${as.userId} is already in progress`,
        HttpStatus.CONFLICT,
      );
    }
    try {
      const pending = await this.loadPendingSeed(as.userId);
      if (existing && (!pending || sha256hex(pending.serverSeed) !== existing.commitHash)) {
        // 承诺已上链但本地 serverSeed 丢了（Redis 被清空）：无法揭示，只能人工介入
        throw new AppException(
          'STARTER_PENDING',
          `starter event ${eventId} is ${existing.status} but its serverSeed is gone; contact the administrator`,
          HttpStatus.CONFLICT,
        );
      }
      const seeds = pending ?? (await this.createPendingSeed(as.userId));

      await this.contract.commitRandom(
        as,
        {
          eventId,
          purpose: 'capture',
          playerId: as.userId,
          commitHash: sha256hex(seeds.serverSeed),
          clientSeed: seeds.clientSeed,
          meta: JSON.stringify({ starter: true }),
        },
        { idemKey: `${eventId}-commit` },
      );
      await this.contract.revealAndVerify(SYSTEM_IDENTITY, eventId, seeds.serverSeed, {
        idemKey: `${eventId}-reveal`,
      });

      // 承诺-揭示完成后才派生个体（IV/性格/闪光），与野怪战斗同一套派生布局
      const stream = new DeriveStream(seeds.serverSeed, seeds.clientSeed, eventId);
      const specimen = deriveWildSpecimen(stream, SHINY_CHANCE);

      const pokemonId = `p_${randomUUID()}`;
      const pokemon = await this.contract.mintFromCapture(
        SYSTEM_IDENTITY,
        {
          id: pokemonId,
          playerId: as.userId,
          speciesId: species.id,
          name: species.name,
          ivs: specimen.ivs,
          nature: specimen.nature,
          ability: species.ability,
          shiny: specimen.shiny,
          moves: species.defaultMoves.slice(0, 4),
          dnaHash: computeDnaHash(species.id, specimen.ivs, specimen.nature, specimen.shiny, eventId),
          eventId,
        },
        { idemKey: `starter-${as.userId}` },
      );

      const items = await this.grantGift(as.userId);
      await this.redis.del(pendingSeedKey(as.userId)).catch(() => undefined);

      const evs = normalizeEvs(pokemon.evs);
      pokemon.evs = evs;
      pokemon.stats = computeStats(species.base, specimen.ivs, evs, pokemon.level, specimen.nature);
      return { pokemon, items, gift: STARTER_GIFT };
    } finally {
      await this.redis.del(claimLockKey(as.userId)).catch(() => undefined);
    }
  }

  /** 礼包：每个 typeId 一个固定 idemKey —— 重复调用只会拿回首次的结果，不会重复铸造。 */
  private async grantGift(playerId: string): Promise<ItemState[]> {
    const granted: ItemState[] = [];
    for (const gift of STARTER_GIFT) {
      const type = getItemType(gift.typeId);
      granted.push(
        await this.contract.mintItem(
          SYSTEM_IDENTITY,
          {
            id: `i_${randomUUID()}`,
            playerId,
            typeId: gift.typeId,
            quantity: gift.quantity,
            uri: type?.uri ?? '',
            metadataHash: sha256hex(`${gift.typeId}|starter-gift`),
          },
          { idemKey: `starter-${playerId}-${gift.typeId}` },
        ),
      );
    }
    return granted;
  }

  private async loadPendingSeed(playerId: string): Promise<{ serverSeed: string; clientSeed: string } | null> {
    return this.redis.getJson<{ serverSeed: string; clientSeed: string }>(pendingSeedKey(playerId)).catch(() => null);
  }

  private async createPendingSeed(playerId: string): Promise<{ serverSeed: string; clientSeed: string }> {
    const seeds = {
      serverSeed: randomBytes(32).toString('hex'),
      clientSeed: randomBytes(16).toString('hex'),
    };
    await this.redis.setJson(pendingSeedKey(playerId), seeds, PENDING_SEED_TTL_SEC).catch(() => undefined);
    return seeds;
  }
}
