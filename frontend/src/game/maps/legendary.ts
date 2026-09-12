import { border, createGrid, fillRect, makeRng, patch, setTile } from './builders';
import { T } from './tiles';
import type { MapDef } from './types';

/**
 * 传说区内部小图（每区一张，天空之柱分两层做"塔内多层感"）。
 * 入口在野外地图的门口，由 `requiresItem` 校验钥匙；内部只有祭坛瓦片会遇敌，
 * 池内固定为对应传说宝可梦（后端保证），等级固定在高段。
 */

/** 石柱阵列（室内装饰，阻挡通行） */
function pillars(g: number[][], coords: readonly (readonly [number, number])[]): void {
  for (const [x, y] of coords) setTile(g, x, y, T.pillar);
}

// ─────────────────────────────────────────────── 天空之柱 1F

function buildSkyPillar1F(): number[][] {
  const g = createGrid(20, 16, T.floor);
  border(g, T.wall);
  pillars(g, [
    [4, 5], [4, 9], [15, 5], [15, 9], [9, 5], [10, 5], [9, 10], [10, 10],
  ]);
  fillRect(g, 9, 6, 2, 4, T.carpet);
  setTile(g, 4, 2, T.stairs);
  setTile(g, 4, 3, T.carpet);
  setTile(g, 10, 15, T.door);
  return g;
}

export const SKY_PILLAR_1F: MapDef = {
  id: 'sky-pillar-1f',
  name: '天空之柱 · 1F',
  biome: 'tower',
  zoneId: 'sky-pillar',
  width: 20,
  height: 16,
  grid: buildSkyPillar1F(),
  ambient: { color: 0x0a0818, alpha: 0.3 },
  spawn: { x: 10, y: 14 },
  intro: '塔里静得能听见风声，石阶向上盘旋。',
  warps: [
    { x: 10, y: 15, to: { mapId: 'route-north', x: 24, y: 5 }, kind: 'door' },
    { x: 4, y: 2, to: { mapId: 'sky-pillar-2f', x: 4, y: 14 }, kind: 'stairs' },
  ],
  objects: [
    {
      kind: 'npc',
      x: 12,
      y: 12,
      sprite: 'sailor',
      name: '塔的守卫',
      lines: ['塔顶的天空是它的领地。', '上去之前，先把队伍治好——传说不会等你。'],
      facing: 'left',
    },
  ],
};

// ─────────────────────────────────────────────── 天空之柱 2F（塔顶）

function buildSkyPillar2F(): number[][] {
  const g = createGrid(18, 18, T.floor);
  border(g, T.wall);
  fillRect(g, 7, 7, 4, 4, T.altar);
  pillars(g, [
    [5, 5], [5, 12], [12, 5], [12, 12], [4, 8], [13, 8], [8, 4], [9, 13],
  ]);
  setTile(g, 4, 16, T.stairs);
  return g;
}

export const SKY_PILLAR_2F: MapDef = {
  id: 'sky-pillar-2f',
  name: '天空之柱 · 塔顶',
  biome: 'tower',
  zoneId: 'sky-pillar',
  width: 18,
  height: 18,
  grid: buildSkyPillar2F(),
  ambient: { color: 0x1a1030, alpha: 0.28 },
  spawn: { x: 4, y: 14 },
  intro: '云在脚下翻涌，祭坛上盘着一条细长的影子。',
  encounter: { tiles: ['altar'], rate: 0.5 },
  warps: [{ x: 4, y: 16, to: { mapId: 'sky-pillar-1f', x: 4, y: 3 }, kind: 'stairs' }],
  objects: [],
};

// ─────────────────────────────────────────────── 海底洞窟

function buildSeafloor(): number[][] {
  const rng = makeRng(1111);
  const g = createGrid(22, 18, T.floor);
  border(g, T.wall);
  patch(g, T.gravel, { x: 1, y: 1, w: 20, h: 16 }, 0.5, rng, 'floor');
  fillRect(g, 2, 3, 4, 3, T.water);
  fillRect(g, 15, 10, 5, 4, T.water);
  fillRect(g, 9, 7, 4, 4, T.altar);
  setTile(g, 2, 15, T.door);
  return g;
}

export const SEAFLOOR: MapDef = {
  id: 'seafloor',
  name: '海底洞窟',
  biome: 'seafloor',
  zoneId: 'seafloor',
  width: 22,
  height: 18,
  grid: buildSeafloor(),
  ambient: { color: 0x08203a, alpha: 0.34 },
  spawn: { x: 3, y: 15 },
  intro: '水流从头顶的裂缝里透下蓝光，深处有什么在游动。',
  encounter: { tiles: ['altar'], rate: 0.5 },
  warps: [{ x: 2, y: 15, to: { mapId: 'coast', x: 24, y: 15 }, kind: 'door' }],
  objects: [],
};

// ─────────────────────────────────────────────── 熔岩洞窟

function buildMagma(): number[][] {
  const rng = makeRng(1212);
  const g = createGrid(22, 18, T.floor);
  border(g, T.wall);
  patch(g, T.ash, { x: 1, y: 1, w: 20, h: 16 }, 0.5, rng, 'floor');
  fillRect(g, 2, 4, 4, 3, T.lava);
  fillRect(g, 16, 4, 4, 3, T.lava);
  fillRect(g, 9, 7, 4, 4, T.altar);
  setTile(g, 2, 16, T.door);
  return g;
}

export const MAGMA: MapDef = {
  id: 'magma',
  name: '熔岩洞窟',
  biome: 'magma',
  zoneId: 'magma',
  width: 22,
  height: 18,
  grid: buildMagma(),
  ambient: { color: 0x4a0a04, alpha: 0.28 },
  spawn: { x: 4, y: 15 },
  intro: '岩壁被烤得发红，脚下的地面在微微震动。',
  encounter: { tiles: ['altar'], rate: 0.5 },
  warps: [{ x: 2, y: 16, to: { mapId: 'volcano', x: 10, y: 2 }, kind: 'door' }],
  objects: [],
};

// ─────────────────────────────────────────────── 古代遗迹

function buildRuins(): number[][] {
  const g = createGrid(22, 18, T.sand);
  border(g, T.wall);
  // 三间石室
  fillRect(g, 3, 3, 5, 4, T.floor);
  fillRect(g, 14, 3, 5, 4, T.floor);
  fillRect(g, 3, 11, 5, 4, T.floor);
  fillRect(g, 14, 11, 5, 4, T.floor);
  pillars(g, [
    [3, 3], [7, 3], [3, 6], [7, 6], [14, 3], [18, 3], [14, 6], [18, 6],
    [3, 11], [7, 11], [3, 14], [7, 14], [14, 11], [18, 11], [14, 14], [18, 14],
  ]);
  fillRect(g, 9, 7, 4, 4, T.altar);
  setTile(g, 10, 17, T.door);
  return g;
}

export const RUINS: MapDef = {
  id: 'ruins',
  name: '古代遗迹',
  biome: 'ruins',
  zoneId: 'ruins',
  width: 22,
  height: 18,
  grid: buildRuins(),
  ambient: { color: 0x2a1c08, alpha: 0.22 },
  spawn: { x: 10, y: 15 },
  intro: '四间石室围着中央的祭坛，石像的眼睛似乎会动。',
  encounter: { tiles: ['altar'], rate: 0.45 },
  warps: [{ x: 10, y: 17, to: { mapId: 'route-mid', x: 7, y: 1 }, kind: 'door' }],
  objects: [
    { kind: 'sign', x: 9, y: 15, lines: ['祭坛上刻着：石之三神各守一间石室，中央的印记会把它们引来。'] },
  ],
};

// ─────────────────────────────────────────────── 南方孤岛

function buildSouthernIsland(): number[][] {
  const rng = makeRng(1313);
  const g = createGrid(20, 16, T.sand);
  border(g, T.water);
  fillRect(g, 5, 5, 10, 6, T.grass);
  patch(g, T.tallGrass, { x: 5, y: 5, w: 10, h: 6 }, 0.4, rng);
  fillRect(g, 8, 7, 4, 4, T.altar);
  setTile(g, 4, 6, T.tree);
  setTile(g, 15, 6, T.tree);
  setTile(g, 4, 10, T.tree);
  setTile(g, 15, 10, T.tree);
  setTile(g, 10, 15, T.plank);
  return g;
}

export const SOUTHERN_ISLAND: MapDef = {
  id: 'southern-island',
  name: '南方孤岛',
  biome: 'island',
  zoneId: 'southern-island',
  width: 20,
  height: 16,
  grid: buildSouthernIsland(),
  spawn: { x: 10, y: 13 },
  intro: '孤岛中央有一片被踩实的空场，空气里有羽毛的味道。',
  encounter: { tiles: ['altar'], rate: 0.5 },
  warps: [{ x: 10, y: 15, to: { mapId: 'coast', x: 29, y: 18 }, kind: 'door' }],
  objects: [],
};

// ─────────────────────────────────────────────── 诞生之岛

function buildBirthIsland(): number[][] {
  const g = createGrid(18, 16, T.gravel);
  border(g, T.water);
  fillRect(g, 4, 4, 10, 8, T.floor);
  pillars(g, [
    [4, 4], [13, 4], [4, 11], [13, 11], [7, 4], [10, 4], [7, 11], [10, 11],
  ]);
  fillRect(g, 7, 6, 4, 4, T.altar);
  setTile(g, 8, 15, T.plank);
  return g;
}

export const BIRTH_ISLAND: MapDef = {
  id: 'birth-island',
  name: '诞生之岛',
  biome: 'birth',
  zoneId: 'birth-island',
  width: 18,
  height: 16,
  grid: buildBirthIsland(),
  ambient: { color: 0x1c0a2e, alpha: 0.24 },
  spawn: { x: 8, y: 13 },
  intro: '岛中央的石台上刻着三角形，空气发出细微的嗡鸣。',
  encounter: { tiles: ['altar'], rate: 0.5 },
  warps: [{ x: 8, y: 15, to: { mapId: 'coast', x: 4, y: 18 }, kind: 'door' }],
  objects: [],
};
