/**
 * 道具图标约定（public/assets/vendor/items/）。
 * 纯字符串 / 尺寸计算，不依赖 Vue 与 Phaser，供 ItemIcon.vue 与其他视图复用。
 *
 * 普通道具来自 PokeAPI sprites；跑鞋使用 GPT Image 生成图，来源见 frontend/README.md。
 */

/** 仓库内置图标原生边长（PokeAPI 道具图 30×30）；替换素材后按图片实际宽度自适应 */
export const ITEM_ICON_NATIVE = 30;

/** 图标边框宽度（像素风外框，计入盒子尺寸） */
export const ITEM_ICON_BORDER = 2;

const ITEM_ICON_BASE = '/assets/vendor/items';

/** typeId → 静态图标 URL（文件名即 typeId，见 frontend/README.md 素材表） */
export function itemIconUrl(typeId: string): string {
  if (typeId === 'running-shoes') return '/assets/generated/items/running-shoes.png';
  return `${ITEM_ICON_BASE}/${encodeURIComponent(typeId)}.png`;
}

/** 显示边长取原生边长的整数倍（最近邻放大不产生错位），至少 1× */
export function itemIconBox(size: number, native: number = ITEM_ICON_NATIVE): number {
  const unit = native > 0 ? native : ITEM_ICON_NATIVE;
  return Math.max(1, Math.ceil(size / unit)) * unit;
}

export type ItemKind = 'ball' | 'potion' | 'stone' | 'tm' | 'other';

/** typeId → 类别（占位图标配色/字形用），未收录归 other */
export function itemKind(typeId: string): ItemKind {
  if (typeId.endsWith('-ball')) return 'ball';
  if (typeId.includes('potion')) return 'potion';
  if (typeId.endsWith('-stone')) return 'stone';
  if (typeId === 'tm' || typeId.startsWith('tm-')) return 'tm';
  return 'other';
}

/** 图标加载失败时的占位字形 */
export const ITEM_KIND_GLYPH: Record<ItemKind, string> = {
  ball: '◉',
  potion: '✚',
  stone: '◆',
  tm: '▤',
  other: '?',
};

/** 占位图标底色（沿用 GBA 配色：球=红 / 药=绿 / 石=黄 / 技能机=蓝） */
export const ITEM_KIND_COLOR: Record<ItemKind, string> = {
  ball: '#d84040',
  potion: '#70c878',
  stone: '#f8c848',
  tm: '#3878c8',
  other: '#6b4a2f',
};
