import { getLearnset } from '../game-data/learnsets.data';

/** 链码 ApplyGrowth 与官方规则一致：一只宝可梦最多 4 个技能。 */
export const MAX_MOVES = 4;

/**
 * 升级学习表的使用口径（docs/backend-api.md §2「升级学习表」）：
 * 等级跨过学习记录的阈值即学（`fromLevel < level ≤ toLevel`），已会的不再重复学。
 */
export function movesCrossing(
  speciesId: number,
  fromLevel: number,
  toLevel: number,
  known: string[],
): string[] {
  if (toLevel <= fromLevel) return [];
  return getLearnset(speciesId)
    .filter((entry) => entry.level > fromLevel && entry.level <= toLevel && !known.includes(entry.moveId))
    .map((entry) => entry.moveId);
}

/** 进化补学：新种族学习表里等级已经达到的技能（`level ≤ 入参等级`）。 */
export function movesKnownAt(speciesId: number, level: number, known: string[]): string[] {
  return getLearnset(speciesId)
    .filter((entry) => entry.level <= level && !known.includes(entry.moveId))
    .map((entry) => entry.moveId);
}

/**
 * 应用一批新技能，返回实际学会的列表与新的技能数组。
 *
 * - `moves.length < 4`：直接追加；
 * - 已满 4 个：替换「最早学的非最新技能」——`moves` 数组就是学习顺序（新技能一律追加到尾部），
 *   所以队首就是最早学的；本批刚学会的技能不参与替换（一次学两招时不会把刚学的又丢掉）。
 */
export function applyLearned(
  moves: string[],
  candidates: string[],
): { moves: string[]; learned: string[] } {
  const next = [...moves];
  const learned: string[] = [];
  for (const moveId of candidates) {
    if (next.includes(moveId)) continue;
    if (next.length < MAX_MOVES) {
      next.push(moveId);
    } else {
      const index = next.findIndex((known) => !learned.includes(known));
      if (index < 0) continue;
      next.splice(index, 1);
      next.push(moveId);
    }
    learned.push(moveId);
  }
  return { moves: next, learned };
}
