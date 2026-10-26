import type { Pokemon } from '@/types';

// --- [FEAT:breeding] begin ---

export type PartnerBlockReason = 'same' | 'locked' | 'fainted' | 'lowLevel' | null;

/** 该宝可梦能否作为第二亲代；null = 可以。 */
export function partnerBlockReason(
  candidate: Pokemon,
  parentAId: string,
  minLevel: number,
): PartnerBlockReason {
  if (candidate.id === parentAId) return 'same';
  if (candidate.status !== 'IDLE') return 'locked';
  if (candidate.fainted) return 'fainted';
  if (candidate.level < minLevel) return 'lowLevel';
  return null;
}

/** 可选亲代列表：保持原顺序（队伍顺序），只筛掉不可用的。 */
export function eligiblePartners(pokemons: Pokemon[], parentAId: string, minLevel: number): Pokemon[] {
  return pokemons.filter((p) => partnerBlockReason(p, parentAId, minLevel) === null);
}

/** 展示用：IV 六项求和，方便在列表里比较。 */
export function ivTotal(pokemon: Pokemon): number {
  return Object.values(pokemon.ivs).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

/** 子代预览说明：从母本取物种（与链码一致），并提示遗传只覆盖 IV/性格/闪光。 */
export function childSpeciesHint(parentB: Pokemon | null): string {
  return parentB ? String(parentB.speciesId) : '';
}

// --- [FEAT:breeding] end ---
