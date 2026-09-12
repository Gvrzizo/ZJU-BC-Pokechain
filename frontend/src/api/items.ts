import { http } from './http';
import type { Item, Pokemon } from '@/types';

/** 王冠要指定升满的个体值维度（与 backend/src/game-data/stats.ts 的 StatKey 对齐）。 */
export type PokemonStatKey = 'hp' | 'atk' | 'def' | 'spatk' | 'spdef' | 'speed';

export interface UseItemOptions {
  targetPokemonId?: string;
  /** 技能机用：满 4 招时替换掉的技能 */
  forgetMoveId?: string;
  /** 银色王冠用：把哪一项个体值升满 31 */
  stat?: PokemonStatKey;
}

/** `POST /items/:id/use` 的响应（按道具类型给不同字段，docs/backend-api.md §3）。 */
export interface UseItemResult {
  used: string;
  /** 成长后的宝可梦（王冠/糖果/技能机/进化石） */
  pokemon?: Pokemon;
  /** 进化石：进化后的宝可梦 */
  evolved?: Pokemon;
  /** 神奇糖果：本次提升的等级数 */
  levelsGained?: number;
  /** 神奇糖果：学会的技能（升级学习表） */
  movesLearned?: string[];
  /** 神奇糖果：结算后是否满足等级进化条件 */
  canEvolve?: boolean;
  /** 界面提示文案（后端给的中文说明） */
  message?: string;
  effect?: { healAmount: number };
  /** 伤药回血结果（链下当前 HP：before → after，不超 maxHp） */
  hp?: { before: number; after: number; maxHp: number; healed: number };
  taught?: string;
  [key: string]: unknown;
}

export async function getMyItems(): Promise<Item[]> {
  const { data } = await http.get<Item[]>('/items', { params: { owner: 'me' } });
  return data;
}

/**
 * 使用道具。第二个参数兼容两种写法：旧的 `targetPokemonId` 字符串（背包视图）
 * 与 {targetPokemonId, forgetMoveId, stat} 选项对象（队伍视图的王冠/糖果）。
 */
export async function useItem(
  id: string,
  target?: string | UseItemOptions,
): Promise<UseItemResult> {
  const options: UseItemOptions = typeof target === 'string' ? { targetPokemonId: target } : target ?? {};
  const { data } = await http.post<UseItemResult>(`/items/${encodeURIComponent(id)}/use`, options);
  return data;
}
