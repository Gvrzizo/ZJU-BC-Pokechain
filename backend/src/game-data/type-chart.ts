/**
 * 18 属性全集（#1–386 图鉴数据用；第三世代实际出现 17 种，fairy 为第六世代新增，仅保留取值）。
 * 说明：属性全集只用于物种/技能的类型标注。
 */
export type PokeType =
  | 'normal'
  | 'fire'
  | 'water'
  | 'electric'
  | 'grass'
  | 'ice'
  | 'fighting'
  | 'poison'
  | 'ground'
  | 'flying'
  | 'psychic'
  | 'bug'
  | 'rock'
  | 'ghost'
  | 'dragon'
  | 'dark'
  | 'steel'
  | 'fairy';

/**
 * 6-type effectiveness chart (fire/water/grass/electric/psychic/dark).
 * Missing entries are neutral (x1) — that includes normal/dragon and every
 * other type (flying/ice/bug/...), which do not appear in the chart.
 */
export const TYPE_CHART: Partial<Record<PokeType, Partial<Record<PokeType, number>>>> = {
  fire: { grass: 2, water: 0.5, fire: 0.5, dragon: 0.5 },
  water: { fire: 2, grass: 0.5, water: 0.5, dragon: 0.5 },
  grass: { water: 2, fire: 0.5, grass: 0.5, dragon: 0.5 },
  electric: { water: 2, grass: 0.5, electric: 0.5, dragon: 0.5 },
  psychic: { psychic: 0.5, dark: 0 },
  dark: { psychic: 2, dark: 0.5 },
};

export function typeEffectiveness(moveType: PokeType, defenderType: PokeType): number {
  return TYPE_CHART[moveType]?.[defenderType] ?? 1;
}
