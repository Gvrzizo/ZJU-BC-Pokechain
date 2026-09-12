/** 支持的语言（默认 zh，localStorage 持久化） */
export type Locale = 'zh' | 'en';

export interface NatureEntry {
  /** 性格名 */
  name: string;
  /** 能力修正说明（+有利 -不利，无修正的性格为中性文案） */
  effect: string;
}

/** 一份语言的完整词典：UI 文案 + 名称表（宝可梦/技能/道具/性格） */
export interface LocaleDictionary {
  /** 通用文案，键名点分层级：nav.* / common.* / bag.* / dex.* / team.* / trade.* */
  ui: Record<string, string>;
  /** 全国图鉴编号 → 宝可梦名 */
  pokemon: Record<number, string>;
  /** 技能 id → 技能名 */
  moves: Record<string, string>;
  /** 道具 typeId → 道具名 */
  items: Record<string, string>;
  /** 性格 id → 名称 + 能力修正 */
  natures: Record<string, NatureEntry>;
}
