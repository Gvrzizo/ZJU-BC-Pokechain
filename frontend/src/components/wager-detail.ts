import type { Stats, WagerPokemonDetail } from '@/types';

/** 能力值展示顺序（与 §2「能力值计算」同口径） */
export const STAT_ROWS: Array<[keyof Stats, string]> = [
  ['hp', 'HP'],
  ['atk', '攻击'],
  ['def', '防御'],
  ['spatk', '特攻'],
  ['spdef', '特防'],
  ['speed', '速度'],
];

/** 押注宝可梦的展示名：后端给的中文名优先，缺失时回退链上英文名 / 资产 id */
export function wagerMonLabel(mon: Pick<WagerPokemonDetail, 'nameZh' | 'name' | 'id'>): string {
  return mon.nameZh ?? mon.name ?? mon.id;
}

/** 能力值一行（如 "HP20 · 攻击11 · 防御9 · 特攻12 · 特防11 · 速度10"）；无能力值时空串 */
export function statsLine(stats: Stats | null): string {
  if (!stats) return '';
  return STAT_ROWS.map(([key, label]) => `${label}${stats[key]}`).join(' · ');
}
