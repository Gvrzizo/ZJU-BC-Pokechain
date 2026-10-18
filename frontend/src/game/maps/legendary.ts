import { blob, border, createGrid, fillRect, makeRng, pond, setTile } from './builders';
import { T } from './tiles';
import type { Grid, MapDef } from './types';

/**
 * 传说区内部小图（每区一张，天空之柱分两层做"塔内多层感"）。
 * 入口在野外地图的门口，由 `requiresItem` 校验钥匙；内部只有祭坛瓦片会遇敌，
 * 池内固定为对应传说宝可梦（后端保证），等级固定在高段。
 *
 * 内部布局按原作的仪式感来做：**中轴对称**（石柱成对、走道居中）、
 * 祭坛居中且四周留一圈空地、洞口嵌在墙里且门口留 1-2 格地面。
 */

/** 石柱阵列（室内装饰，阻挡通行） */
function pillars(g: number[][], coords: readonly (readonly [number, number])[]): void {
  for (const [x, y] of coords) setTile(g, x, y, T.pillar);
}

/** 左右对称的一对石柱（以 `cx` 为轴） */
function pillarPair(g: number[][], cx: number, y: number, offset: number): void {
  setTile(g, cx - offset, y, T.pillar);
  setTile(g, cx + offset, y, T.pillar);
}

/** 中央祭坛：`size`×`size` 的方块，四周留 1 格空地环 */
function altar(g: Grid, cx: number, cy: number, size: number): void {
  const half = Math.floor(size / 2);
  fillRect(g, cx - half, cy - half, size, size, T.altar);
}

// ─────────────────────────────────────────────── 天空之柱 1F

function buildSkyPillar1F(): number[][] {
  const g = createGrid(22, 18, T.floor);
  border(g, T.wall, 2);
  // 中央走道（2 格宽）铺碎石，两侧成对的石柱对称排开
  fillRect(g, 9, 3, 2, 13, T.gravel);
  for (let y = 4; y <= 12; y += 2) {
    pillarPair(g, 10, y, 3);
    pillarPair(g, 10, y, 6);
  }
  setTile(g, 4, 3, T.rock);
  setTile(g, 4, 14, T.rock);
  setTile(g, 17, 3, T.rock);
  setTile(g, 17, 14, T.rock);
  // 北面的石阶（上 2F）与南面的塔门（回高原）
  setTile(g, 9, 1, T.stairs);
  setTile(g, 10, 1, T.stairs);
  setTile(g, 8, 1, T.wall);
  setTile(g, 11, 1, T.wall);
  setTile(g, 9, 2, T.gravel);
  setTile(g, 10, 2, T.gravel);
  setTile(g, 10, 16, T.door);
  setTile(g, 9, 16, T.wall);
  setTile(g, 10, 15, T.gravel);
  return g;
}

export const SKY_PILLAR_1F: MapDef = {
  id: 'sky-pillar-1f',
  name: '天空之柱 · 1F',
  biome: 'tower',
  zoneId: 'sky-pillar',
  width: 22,
  height: 18,
  grid: buildSkyPillar1F(),
  ambient: { color: 0x0a0818, alpha: 0.3 },
  spawn: { x: 10, y: 15 },
  intro: '塔里静得能听见风声，石阶向上盘旋。',
  warps: [
    { x: 10, y: 16, to: { mapId: 'route-north', x: 24, y: 7 }, kind: 'door' },
    { x: 9, y: 1, to: { mapId: 'sky-pillar-2f', x: 9, y: 16 }, kind: 'stairs' },
    { x: 10, y: 1, to: { mapId: 'sky-pillar-2f', x: 10, y: 16 }, kind: 'stairs' },
  ],
  objects: [
    {
      kind: 'npc',
      x: 13,
      y: 14,
      sprite: 'sailor',
      name: '塔的守卫',
      lines: ['塔顶的天空是它的领地。', '上去之前，先把队伍治好——传说不会等你。'],
      facing: 'left',
    },
  ],
};

// ─────────────────────────────────────────────── 天空之柱 2F（塔顶）

function buildSkyPillar2F(): number[][] {
  const g = createGrid(20, 20, T.floor);
  border(g, T.wall, 2);
  // 祭坛居中，四周留一圈空地，再外一圈对称石柱
  altar(g, 10, 9, 6);
  fillRect(g, 7, 6, 6, 6, T.gravel);
  altar(g, 10, 9, 4);
  for (const [x, y] of [[5, 4], [14, 4], [5, 14], [14, 14], [4, 9], [15, 9], [10, 3], [10, 15]] as const) {
    setTile(g, x, y, T.rock);
  }
  // 南面的石阶（下 1F）
  setTile(g, 9, 17, T.stairs);
  setTile(g, 10, 17, T.stairs);
  setTile(g, 8, 17, T.wall);
  setTile(g, 11, 17, T.wall);
  setTile(g, 9, 16, T.gravel);
  setTile(g, 10, 16, T.gravel);
  return g;
}

export const SKY_PILLAR_2F: MapDef = {
  id: 'sky-pillar-2f',
  name: '天空之柱 · 塔顶',
  biome: 'tower',
  zoneId: 'sky-pillar',
  width: 20,
  height: 20,
  grid: buildSkyPillar2F(),
  ambient: { color: 0x1a1030, alpha: 0.28 },
  spawn: { x: 9, y: 15 },
  intro: '云在脚下翻涌，祭坛上盘着一条细长的影子。',
  encounter: { tiles: ['altar'], rate: 0.5 },
  warps: [
    { x: 9, y: 17, to: { mapId: 'sky-pillar-1f', x: 9, y: 2 }, kind: 'stairs' },
    { x: 10, y: 17, to: { mapId: 'sky-pillar-1f', x: 10, y: 2 }, kind: 'stairs' },
  ],
  objects: [],
};

// ─────────────────────────────────────────────── 海底洞窟

function buildSeafloor(): number[][] {
  const rng = makeRng(1111);
  const g = createGrid(22, 18, T.floor);
  border(g, T.wall, 2);
  // 两湾月牙形水潭：大水潭里再挖掉一块，剩下的就是弯月
  blob(g, T.water, 6.5, 5.5, 3.4, 2.6, rng, { jitter: 0.2, onlyOn: 'floor' });
  blob(g, T.floor, 7.5, 5.5, 2.6, 2, rng, { jitter: 0.2, onlyOn: 'water' });
  blob(g, T.water, 15.5, 12.5, 3.2, 2.4, rng, { jitter: 0.2, onlyOn: 'floor' });
  blob(g, T.floor, 14.5, 12.5, 2.4, 1.8, rng, { jitter: 0.2, onlyOn: 'water' });
  // 祭坛居中，四周留一圈空地
  altar(g, 11, 9, 4);
  for (const [x, y] of [[3, 8], [3, 10], [18, 8], [18, 10], [11, 3], [11, 15]] as const) {
    setTile(g, x, y, T.rock);
  }
  // 西面的洞口（嵌在岩壁里，门口留 2 格地面）
  setTile(g, 1, 14, T.door);
  setTile(g, 2, 14, T.floor);
  setTile(g, 3, 14, T.floor);
  setTile(g, 1, 13, T.wall);
  setTile(g, 1, 15, T.wall);
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
  spawn: { x: 3, y: 14 },
  intro: '水流从头顶的裂缝里透下蓝光，深处有什么在游动。',
  encounter: { tiles: ['altar'], rate: 0.5 },
  warps: [{ x: 1, y: 14, to: { mapId: 'coast', x: 21, y: 13 }, kind: 'door' }],
  objects: [],
};

// ─────────────────────────────────────────────── 熔岩洞窟

function buildMagma(): number[][] {
  const rng = makeRng(1212);
  const g = createGrid(22, 18, T.gravel);
  border(g, T.wall, 2);
  // 岩浆池贴边（左右各一湾），中央留灰地走道
  blob(g, T.lava, 4, 6, 3, 2.6, rng, { jitter: 0.24, onlyOn: 'gravel' });
  blob(g, T.lava, 18, 12, 3, 2.6, rng, { jitter: 0.24, onlyOn: 'gravel' });
  blob(g, T.lava, 8, 15, 2.4, 1.4, rng, { jitter: 0.26, onlyOn: 'gravel' });
  blob(g, T.ash, 11, 5, 3.4, 2, rng, { jitter: 0.34, onlyOn: 'gravel' });
  blob(g, T.ash, 15, 9, 2.4, 1.8, rng, { jitter: 0.34, onlyOn: 'gravel' });
  // 祭坛居中，四周留一圈空地
  altar(g, 11, 9, 4);
  for (const [x, y] of [[6, 12], [16, 5], [11, 3], [11, 15], [3, 12], [19, 6]] as const) {
    setTile(g, x, y, T.rock);
  }
  // 西面的洞口
  setTile(g, 1, 15, T.door);
  setTile(g, 2, 15, T.gravel);
  setTile(g, 1, 14, T.wall);
  setTile(g, 1, 16, T.wall);
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
  spawn: { x: 3, y: 15 },
  intro: '岩壁被烤得发红，脚下的地面在微微震动。',
  encounter: { tiles: ['altar'], rate: 0.5 },
  warps: [{ x: 1, y: 15, to: { mapId: 'volcano', x: 12, y: 2 }, kind: 'door' }],
  objects: [],
};

// ─────────────────────────────────────────────── 古代遗迹

function buildRuins(): number[][] {
  const rng = makeRng(1313);
  const g = createGrid(22, 18, T.gravel);
  border(g, T.wall, 2);
  // 四间石室对称分布在四角，用 2 格宽的回廊连到中央祭坛
  const rooms: readonly (readonly [number, number])[] = [[3, 3], [14, 3], [3, 11], [14, 11]];
  for (const [rx, ry] of rooms) {
    fillRect(g, rx, ry, 5, 4, T.floor);
    setTile(g, rx, ry, T.rock);
    setTile(g, rx + 4, ry, T.rock);
    setTile(g, rx, ry + 3, T.rock);
    setTile(g, rx + 4, ry + 3, T.rock);
  }
  // 回廊：横竖各两条，交汇处是祭坛广场
  fillRect(g, 2, 8, 18, 2, T.floor);
  fillRect(g, 10, 3, 2, 13, T.floor);
  // 每间石室开一道 1 格宽的门通向回廊（四室对称可达）
  for (const x of [5, 16]) {
    fillRect(g, x, 7, 1, 1, T.floor);
    fillRect(g, x, 10, 1, 1, T.floor);
  }
  blob(g, T.altar, 11, 9, 2.6, 2.6, rng, { jitter: 0.12, onlyOn: 'floor' });
  // 南面的门（嵌在墙里，门口留 2 格地面）
  setTile(g, 10, 16, T.door);
  setTile(g, 11, 16, T.door);
  setTile(g, 10, 15, T.floor);
  setTile(g, 11, 15, T.floor);
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
  spawn: { x: 11, y: 14 },
  intro: '四间石室围着中央的祭坛，石像的眼睛似乎会动。',
  encounter: { tiles: ['altar'], rate: 0.45 },
  warps: [
    { x: 10, y: 16, to: { mapId: 'route-mid', x: 8, y: 2 }, kind: 'door' },
    { x: 11, y: 16, to: { mapId: 'route-mid', x: 9, y: 2 }, kind: 'door' },
  ],
  objects: [
    { kind: 'sign', x: 9, y: 15, lines: ['祭坛上刻着：石之三神各守一间石室，中央的印记会把它们引来。'] },
  ],
};

// ─────────────────────────────────────────────── 南方孤岛

function buildSouthernIsland(): number[][] {
  const rng = makeRng(1414);
  const g = createGrid(20, 16, T.deepWater);
  border(g, T.deepWater, 2);
  // 圆润的小岛：浅水 → 沙滩 → 中央草坪
  blob(g, T.water, 10, 7.5, 8, 5.6, rng, { jitter: 0.12, onlyOn: 'deepWater' });
  blob(g, T.sand, 10, 7.5, 6.4, 4, rng, { jitter: 0.14, onlyOn: 'water' });
  blob(g, T.grass, 10, 7.5, 4.4, 2.6, rng, { jitter: 0.16, onlyOn: 'sand' });
  altar(g, 10, 8, 4);
  for (const [x, y] of [[5, 5], [14, 5], [5, 10], [14, 10], [7, 4], [12, 4], [7, 11], [12, 11]] as const) {
    setTile(g, x, y, T.tree);
  }
  // 连接岛内落点与码头，潮线不会在两者之间留一格水。
  fillRect(g, 9, 10, 2, 3, T.sand);
  // 南面的栈桥（船）
  for (const y of [12, 13, 14, 15]) {
    setTile(g, 9, y, T.plank);
    setTile(g, 10, y, T.plank);
  }
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
  spawn: { x: 10, y: 11 },
  intro: '孤岛中央有一片被踩实的空场，空气里有羽毛的味道。',
  encounter: { tiles: ['altar'], rate: 0.5 },
  warps: [
    { x: 9, y: 15, to: { mapId: 'coast', x: 30, y: 21 }, kind: 'door' },
    { x: 10, y: 15, to: { mapId: 'coast', x: 31, y: 21 }, kind: 'door' },
  ],
  objects: [],
};

// ─────────────────────────────────────────────── 诞生之岛

function buildBirthIsland(): number[][] {
  const rng = makeRng(1515);
  const g = createGrid(18, 16, T.deepWater);
  border(g, T.deepWater, 2);
  blob(g, T.water, 9, 7.5, 7, 5.6, rng, { jitter: 0.12, onlyOn: 'deepWater' });
  blob(g, T.gravel, 9, 7.5, 5.6, 4, rng, { jitter: 0.14, onlyOn: 'water' });
  blob(g, T.floor, 9, 7.5, 3.6, 2.4, rng, { jitter: 0.14, onlyOn: 'gravel' });
  // 中央石台：对称排列的石柱，中间是祭坛
  for (const [x, y] of [[5, 5], [12, 5], [5, 10], [12, 10], [7, 4], [10, 4], [7, 11], [10, 11]] as const) {
    setTile(g, x, y, T.pillar);
  }
  altar(g, 9, 8, 4);
  fillRect(g, 8, 10, 2, 3, T.floor);
  // 南面的栈桥（船）
  for (const y of [12, 13, 14, 15]) {
    setTile(g, 8, y, T.plank);
    setTile(g, 9, y, T.plank);
  }
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
  spawn: { x: 9, y: 12 },
  intro: '岛中央的石台上刻着三角形，空气发出细微的嗡鸣。',
  encounter: { tiles: ['altar'], rate: 0.5 },
  warps: [
    { x: 8, y: 15, to: { mapId: 'coast', x: 6, y: 21 }, kind: 'door' },
    { x: 9, y: 15, to: { mapId: 'coast', x: 7, y: 21 }, kind: 'door' },
  ],
  objects: [],
};
