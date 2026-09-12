import type { Pokemon } from '@/types';

/**
 * 当前 HP 与濒死判定（伤势持久化，docs/backend-api.md §2）：
 * 后端 `GET /pokemon` 返回 `currentHp`（链下 Redis，缺键 = 满血）与 `fainted`；
 * 前端一律用这两个函数展示，避免各处重复"缺省 = 满血 / 越界夹取"的口径。
 */

/** HP 上限（stats.hp；旧缓存缺 stats 时按 0 处理）。 */
export function maxHpOf(pokemon: Pick<Pokemon, 'stats'>): number {
  return pokemon.stats?.hp ?? 0;
}

/** 当前 HP：字段缺省按满血，越界夹到 [0, maxHp]。 */
export function currentHpOf(pokemon: Pick<Pokemon, 'currentHp' | 'stats'>): number {
  const max = maxHpOf(pokemon);
  if (pokemon.currentHp === undefined) return max;
  return Math.max(0, Math.min(max, pokemon.currentHp));
}

/**
 * 是否濒死（0 HP）：不能出战/进队伍，只能伤药或宝可梦中心治疗。
 * 字段缺省（旧缓存/未知）时**不**判定为濒死——只有后端明确说 `fainted` 或给出 0 点当前 HP 才算。
 */
export function isFainted(pokemon: Pick<Pokemon, 'currentHp' | 'fainted' | 'stats'>): boolean {
  if (pokemon.fainted !== undefined) return pokemon.fainted;
  if (pokemon.currentHp === undefined) return false;
  return currentHpOf(pokemon) <= 0;
}

/** 「HP 当前/最大」文本（满血且未知上限时退化为 `—`）。 */
export function hpText(pokemon: Pick<Pokemon, 'currentHp' | 'stats'>): string {
  const max = maxHpOf(pokemon);
  if (max <= 0) return '—';
  return `${currentHpOf(pokemon)}/${max}`;
}
