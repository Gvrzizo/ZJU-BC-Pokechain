/**
 * 语义瓦片表：**数组下标即瓦片集里的列号**（0 = 第一格）。
 * - 程序化瓦片集（`world-textures.ts`）按同一顺序逐格绘制，按生物群系换配色；
 * - vendor 瓦片集（`public/assets/vendor/world/manifest.json`）用 `tiles: {"grass": 3, ...}`
 *   把语义名映射到实际列号，语义名与本表一致（大小写/连字符写法都接受）。
 *
 * 阻挡 / 遇敌 / 覆盖层等属性集中在这里，地图定义只写语义名，不写数字。
 */
export const TILE_SEMANTICS = [
  'grass', // 0 草地
  'tallGrass', // 1 深草（可遇敌）
  'flower', // 2 花丛（装饰）
  'path', // 3 土路
  'sand', // 4 沙地（海岸遇敌）
  'ash', // 5 火山灰地（火山遇敌）
  'gravel', // 6 碎石地（洞窟遇敌）
  'tree', // 7 树（阻挡）
  'rock', // 8 岩石 / 崖壁（阻挡）
  'water', // 9 浅水（阻挡，不可下水）
  'deepWater', // 10 深水（阻挡）
  'plank', // 11 木栈桥（可走）
  'wall', // 12 建筑墙 / 洞壁（阻挡）
  'roof', // 13 屋顶（阻挡，画在玩家之上）
  'floor', // 14 室内地板
  'carpet', // 15 室内地毯
  'counter', // 16 柜台（阻挡）
  'door', // 17 门（可走，踩上去触发传送 / 进屋）
  'stairs', // 18 楼梯（可走，踩上去换层）
  'sign', // 19 路牌（阻挡，可对话）
  'lava', // 20 岩浆（阻挡）
  'altar', // 21 祭坛 / 巢穴（传说遇敌）
  'pillar', // 22 石柱（阻挡）
] as const;

export type TileId = (typeof TILE_SEMANTICS)[number];

export const TILE_COUNT = TILE_SEMANTICS.length;

/** 语义名 → 瓦片索引（简写 `T.tree`），地图定义里大量使用 */
export const T: Record<TileId, number> = Object.fromEntries(
  TILE_SEMANTICS.map((id, i) => [id, i]),
) as Record<TileId, number>;

/** 阻挡通行的瓦片（NPC 另行判定） */
export const BLOCKED_TILES: readonly TileId[] = [
  'tree',
  'rock',
  'water',
  'deepWater',
  'wall',
  'roof',
  'counter',
  'sign',
  'lava',
  'pillar',
];

const BLOCKED = new Set<number>(BLOCKED_TILES.map((id) => T[id]));

/** 屋顶语义标记（兼容瓦片工具）；当前 world-art 整栋绘制，通行由 BLOCKED_TILES 阻挡 */
export const OVERLAY_TILES: readonly TileId[] = ['roof'];

const OVERLAY = new Set<number>(OVERLAY_TILES.map((id) => T[id]));

export function tileIdOf(index: number): TileId | undefined {
  return TILE_SEMANTICS[index];
}

export function isBlockedIndex(index: number): boolean {
  return BLOCKED.has(index);
}

export function isOverlayIndex(index: number): boolean {
  return OVERLAY.has(index);
}

