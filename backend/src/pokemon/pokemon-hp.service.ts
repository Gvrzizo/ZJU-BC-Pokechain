import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { PokemonState } from '../fabric/chain.types';
import { getSpecies } from '../game-data/species.data';
import { computeStats, normalizeEvs } from '../game-data/stats';

/** 宝可梦中心治疗单价（积分，reason=`heal:center`，docs/backend-api.md §10）。 */
export const CENTER_HEAL_COST = 10;

/** 一只宝可梦的 HP 视图（当前 / 上限 / 是否濒死）。 */
export interface PokemonHpView {
  currentHp: number;
  maxHp: number;
  fainted: boolean;
}

/**
 * 宝可梦当前 HP（**链下 Redis**，docs/backend-api.md §2「伤势持久化」）：
 *
 * - `poke:hp:<pokemonId>` 存当前 HP（整数，无 TTL）；**无键 = 满血**——maxHP 由链上
 *   种族值+IV+EV+等级+性格 经 computeStats 算出，故首次读取无需数据迁移；
 * - 链上**不存 HP**：HP 是每场战斗都在变的高频非关键状态，放链上会让每回合都产生交易；
 *   Redis 丢失只损失"伤势"（全员满血），不损失资产，符合课程环境的取舍；
 * - 越界读取一律夹到 `[0, maxHp]`：等级提升/进化让上限变大时旧值仍合法，上限变小时自动截断；
 * - 写入点只有两处：野怪战斗会话每次落盘、PvP 结束（`BattlesService` 的 `end` 钩子）。
 */
@Injectable()
export class PokemonHpService {
  private readonly logger = new Logger(PokemonHpService.name);

  constructor(private readonly redis: RedisService) {}

  static key(pokemonId: string): string {
    return `poke:hp:${pokemonId}`;
  }

  /** 链上字段算出的 HP 上限（种族值 + IV + EV + 等级 + 性格）。 */
  maxHpOf(pokemon: PokemonState): number {
    const species = getSpecies(pokemon.speciesId);
    if (!species) return 1;
    const stats = computeStats(species.base, pokemon.ivs, normalizeEvs(pokemon.evs), pokemon.level, pokemon.nature);
    return Math.max(1, stats.hp);
  }

  /** 读当前 HP（无键 = 满血；越界夹取）。 */
  async currentHp(pokemon: PokemonState): Promise<number> {
    const maxHp = this.maxHpOf(pokemon);
    const raw = await this.redis.get(PokemonHpService.key(pokemon.id)).catch(() => null);
    const stored = raw === null ? maxHp : Number.parseInt(raw, 10);
    if (!Number.isFinite(stored)) return maxHp;
    return clampHp(stored, maxHp);
  }

  async load(pokemon: PokemonState): Promise<PokemonHpView> {
    const maxHp = this.maxHpOf(pokemon);
    const currentHp = await this.currentHp(pokemon);
    return { currentHp, maxHp, fainted: currentHp <= 0 };
  }

  /** 批量读取（MGET，一只一个键）：列表接口用，避免 N 次往返。 */
  async loadMany(pokemons: PokemonState[]): Promise<Map<string, PokemonHpView>> {
    const out = new Map<string, PokemonHpView>();
    if (pokemons.length === 0) return out;
    const keys = pokemons.map((p) => PokemonHpService.key(p.id));
    const raw = await this.redis.client.mget(...keys).catch(() => null);
    for (const [index, pokemon] of pokemons.entries()) {
      const maxHp = this.maxHpOf(pokemon);
      const text = raw?.[index] ?? null;
      const stored = text === null ? maxHp : Number.parseInt(text, 10);
      const currentHp = clampHp(Number.isFinite(stored) ? stored : maxHp, maxHp);
      out.set(pokemon.id, { currentHp, maxHp, fainted: currentHp <= 0 });
    }
    return out;
  }

  /** 写一只的当前 HP（夹到 `[0, maxHp]`）。 */
  async set(pokemonId: string, hp: number, maxHp: number): Promise<number> {
    const value = clampHp(hp, maxHp);
    await this.redis.set(PokemonHpService.key(pokemonId), String(value));
    return value;
  }

  /** 批量写回（战斗结束）：无 maxHp 的一方按"只夹到 ≥0"处理，调用方负责给出正确上限。 */
  async persistMany(entries: Array<{ pokemonId: string; hp: number; maxHp: number }>): Promise<void> {
    for (const entry of entries) {
      if (!entry.pokemonId) continue;
      await this.redis.client
        .set(PokemonHpService.key(entry.pokemonId), String(clampHp(entry.hp, entry.maxHp)))
        .catch((err: Error) => this.logger.warn(`hp persist failed for ${entry.pokemonId}: ${err.message}`));
    }
  }

  /** 治疗：+amount（不超上限），返回前后值；已满血时 healed=0 且不写键。 */
  async heal(pokemon: PokemonState, amount: number): Promise<{ before: number; after: number; maxHp: number; healed: number }> {
    const maxHp = this.maxHpOf(pokemon);
    const before = await this.currentHp(pokemon);
    const gain = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
    const after = clampHp(before + gain, maxHp);
    if (after !== before) await this.set(pokemon.id, after, maxHp);
    return { before, after, maxHp, healed: after - before };
  }

  /** 回满（宝可梦中心）。 */
  async healFull(pokemon: PokemonState): Promise<{ before: number; after: number; maxHp: number; healed: number }> {
    const maxHp = this.maxHpOf(pokemon);
    const before = await this.currentHp(pokemon);
    if (before !== maxHp) await this.set(pokemon.id, maxHp, maxHp);
    return { before, after: maxHp, maxHp, healed: maxHp - before };
  }

  /** 放生等资产消失时清掉伤势键（避免 Redis 里留下永久孤儿键）。 */
  async clear(pokemonId: string): Promise<void> {
    await this.redis.del(PokemonHpService.key(pokemonId)).catch(() => undefined);
  }
}

function clampHp(hp: number, maxHp: number): number {
  const cap = Math.max(0, Math.floor(maxHp));
  return Math.min(cap, Math.max(0, Math.floor(hp)));
}
