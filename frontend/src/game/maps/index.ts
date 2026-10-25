import { BIRTH_ISLAND, MAGMA, RUINS, SEAFLOOR, SKY_PILLAR_1F, SKY_PILLAR_2F, SOUTHERN_ISLAND } from './legendary';
import { CAVE, COAST, FOREST, ROUTE_GRASS, ROUTE_MID, ROUTE_NORTH, VOLCANO } from './routes';
import { T, isBlockedIndex, type TileId } from './tiles';
import { TOWN } from './town';
import { arrangeTrees } from './trees';
import type { BiomeId, MapDef, MapId } from './types';

/** 各生物群系的"地面"瓦片：NPC 脚下被树/岩压住时还原成它 */
const BIOME_GROUND: Record<BiomeId, TileId> = {
  town: 'grass',
  grass: 'grass',
  forest: 'grass',
  mid: 'grass',
  cave: 'floor',
  coast: 'grass',
  north: 'grass',
  volcano: 'ash',
  tower: 'floor',
  seafloor: 'floor',
  magma: 'floor',
  ruins: 'sand',
  island: 'sand',
  birth: 'gravel',
};

const RAW_MAPS: Record<MapId, MapDef> = {
  town: TOWN,
  'route-grass': ROUTE_GRASS,
  forest: FOREST,
  'route-mid': ROUTE_MID,
  cave: CAVE,
  coast: COAST,
  'route-north': ROUTE_NORTH,
  volcano: VOLCANO,
  'sky-pillar-1f': SKY_PILLAR_1F,
  'sky-pillar-2f': SKY_PILLAR_2F,
  seafloor: SEAFLOOR,
  magma: MAGMA,
  ruins: RUINS,
  'southern-island': SOUTHERN_ISLAND,
  'birth-island': BIRTH_ISLAND,
};

/**
 * 让地图数据自洽（顺手挡掉"路牌忘了铺 sign 瓦片""NPC 被随机树压住"这类低级问题）：
 * 路牌 / 建筑门按对象清单铺对应瓦片，NPC 脚下的阻挡瓦片还原成该生物群系的地面。
 * 树木预留掩码最后交给 trees.ts，按完整树形与明确位置同时生成图片占地和碰撞。
 */
function normalizeMap(map: MapDef): MapDef {
  const ground = T[BIOME_GROUND[map.biome]];
  for (const obj of map.objects) {
    if (obj.kind === 'sign') map.grid[obj.y][obj.x] = T.sign;
    else if (obj.kind === 'door') map.grid[obj.y][obj.x] = T.door;
    else if (obj.kind === 'npc' && isBlockedIndex(map.grid[obj.y][obj.x])) {
      map.grid[obj.y][obj.x] = ground;
    }
  }
  arrangeTrees(map);
  return map;
}

/** 地图总表（顺序 = 世界推进顺序：镇 → 草原 → 森林/山径 → 洞窟 → 海岸 → 高原 → 火山 → 传说区） */
export const MAPS: Record<MapId, MapDef> = Object.fromEntries(
  Object.entries(RAW_MAPS).map(([id, map]) => [id, normalizeMap(map)]),
) as Record<MapId, MapDef>;

export const MAP_IDS = Object.keys(MAPS) as MapId[];

/** 出生点：未白镇（/game 默认从镇里开始） */
export const START_MAP_ID: MapId = 'town';

export function getMapDef(id: string | undefined | null): MapDef {
  if (id && id in MAPS) return MAPS[id as MapId];
  return MAPS[START_MAP_ID];
}

/** 生物群系清单（程序化瓦片集与 vendor 瓦片集都按它生成） */
export const BIOMES: readonly BiomeId[] = [
  'town',
  'grass',
  'forest',
  'mid',
  'cave',
  'coast',
  'north',
  'volcano',
  'tower',
  'seafloor',
  'magma',
  'ruins',
  'island',
  'birth',
];

/**
 * 传说区钥匙：进入特殊区的门口要持有对应道具（**一次性**，创建传说区遇敌时消耗，商店有售）。
 * typeId 与后端 `items.data.ts` 的钥匙道具一致（`kind: 'key'`），显示名优先取 locales 的
 * `items[typeId]`（`gates.keyName`），这里的 `name` 只是兜底文案。
 */
export const LEGENDARY_KEYS: Record<string, { name: string; maps: MapId[] }> = {
  'sky-key': { name: '天空之钥', maps: ['sky-pillar-1f'] },
  'ocean-key': { name: '海洋之钥', maps: ['seafloor'] },
  'magma-key': { name: '熔岩之钥', maps: ['magma'] },
  'ruins-key': { name: '遗迹之钥', maps: ['ruins'] },
  'island-key': { name: '岛之钥', maps: ['southern-island'] },
  'birth-key': { name: '诞生岛船票', maps: ['birth-island'] },
};

/** 传说区地图（HUD 用特殊配色 + 进场横幅提示） */
export const LEGENDARY_MAP_IDS: readonly MapId[] = [
  'sky-pillar-1f',
  'sky-pillar-2f',
  'seafloor',
  'magma',
  'ruins',
  'southern-island',
  'birth-island',
];

export function isLegendaryMap(id: MapId): boolean {
  return LEGENDARY_MAP_IDS.includes(id);
}

export * from './tiles';
export * from './types';
export * from './query';
