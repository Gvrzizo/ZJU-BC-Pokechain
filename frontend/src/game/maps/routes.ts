import {
  blob,
  border,
  createGrid,
  flowerCluster,
  fillRect,
  hLine,
  makeRng,
  openEdge,
  pond,
  road,
  setTile,
  vLine,
} from './builders';
import { T } from './tiles';
import type { MapDef } from './types';

/**
 * 七块野外区域。每张图固定一个遇敌 `zoneId`（等级带与野生池由后端决定），
 * 出口靠**边缘行走**或踩门口/楼梯完成；传说区入口（古代遗迹 / 天空之柱 / 熔岩洞窟）
 * 带 `requiresItem`，没钥匙会被对话拦住。
 *
 * 布局一律按原作野外的习惯：2 格厚的树墙/岩壁围边（出入口开在边中段）、2-3 格宽的折线主路
 * （先铺地形再压路，草丛自然被路切开）、圆润的草丛簇（森林最密、草原最疏）、
 * 闭合的水面、嵌在岩壁里的洞口（下方留 1-2 格地面）。
 * T.tree 预留林地以隔开遇敌区；normalizeMap 最后按 trees.ts 的整棵位置重新布置。
 */

// ─────────────────────────────────────────────── 101 号道路（草原）

function buildRouteGrass(): number[][] {
  const rng = makeRng(101);
  const g = createGrid(34, 26, T.grass);
  border(g, T.tree, 2);
  // 草丛：圆润的簇，散布在路两侧（避开主路，但堵住抄近道的空地）
  for (const [cx, cy, rx, ry] of [
    [5, 5, 2.6, 2.2],
    [25, 5, 3, 2.4],
    [5, 15, 2.4, 2],
    [28, 18, 2.8, 2.2],
    [12, 22, 2.4, 1.8],
    [24, 22, 2.6, 2],
    [20, 10, 2.2, 1.8],
    [29, 10, 1.8, 1.6],
  ] as const) {
    blob(g, T.tallGrass, cx, cy, rx, ry, rng, { jitter: 0.34, onlyOn: 'grass' });
  }
  // 树林：只在边角成团，别把草原塞满
  blob(g, T.tree, 28, 14, 2.2, 1.8, rng, { onlyOn: 'grass' });
  blob(g, T.tree, 4, 10, 1.8, 1.6, rng, { onlyOn: 'grass' });
  blob(g, T.tree, 20, 16, 1.6, 1.4, rng, { onlyOn: 'grass' });
  // 水塘（岸上留一圈沙）+ 石头 + 花簇
  pond(g, 24, 10, 2.6, 1.6, rng, { tile: 'sand', onlyOn: 'grass' });

  // 主路：南进北出，中途折两个弯（Z 形），东西向岔路通 104 号道路
  road(
    g,
    [
      { x: 16, y: 25 },
      { x: 16, y: 19 },
      { x: 9, y: 19 },
      { x: 9, y: 8 },
      { x: 16, y: 8 },
      { x: 16, y: 2 },
    ],
    T.path,
    2,
  );
  road(g, [{ x: 9, y: 13 }, { x: 33, y: 13 }], T.path, 2);
  // 出入口：南北各 2 格，东面 2 格
  setTile(g, 16, 0, T.path);
  setTile(g, 17, 0, T.path);
  setTile(g, 16, 1, T.path);
  setTile(g, 17, 1, T.path);
  setTile(g, 16, 25, T.path);
  setTile(g, 17, 25, T.path);
  setTile(g, 16, 24, T.path);
  setTile(g, 17, 24, T.path);

  setTile(g, 22, 2, T.tree);
  setTile(g, 12, 5, T.tree);
  setTile(g, 27, 21, T.tree);
  setTile(g, 19, 4, T.rock);
  setTile(g, 7, 21, T.rock);
  setTile(g, 30, 3, T.rock);
  flowerCluster(g, 18, 6, rng, 4);
  flowerCluster(g, 6, 12, rng, 3);
  flowerCluster(g, 21, 20, rng, 4);
  flowerCluster(g, 30, 16, rng, 3);
  return g;
}

export const ROUTE_GRASS: MapDef = {
  id: 'route-grass',
  name: '101 号道路',
  biome: 'grass',
  zoneId: 'route-grass',
  width: 34,
  height: 26,
  grid: buildRouteGrass(),
  spawn: { x: 16, y: 22 },
  intro: '起伏的草原，野生宝可梦的等级最低。北面是橙华森林，东面通往山径。',
  encounter: { tiles: ['tallGrass'], rate: 0.12 },
  warps: [
    { x: 16, y: 0, to: { mapId: 'forest', x: 17, y: 22 }, kind: 'edge' },
    { x: 17, y: 0, to: { mapId: 'forest', x: 18, y: 22 }, kind: 'edge' },
    { x: 16, y: 25, to: { mapId: 'town', x: 15, y: 1 }, kind: 'edge' },
    { x: 17, y: 25, to: { mapId: 'town', x: 16, y: 1 }, kind: 'edge' },
    { x: 33, y: 13, to: { mapId: 'route-mid', x: 1, y: 13 }, kind: 'edge' },
    { x: 33, y: 14, to: { mapId: 'route-mid', x: 1, y: 14 }, kind: 'edge' },
  ],
  objects: [
    { kind: 'sign', x: 15, y: 3 },
    { kind: 'sign', x: 15, y: 21, lines: ['南边是未白镇，北面是橙华森林——草丛里的宝可梦等级只跟区域有关。'] },
    { kind: 'sign', x: 31, y: 12, lines: ['东面是 104 号道路的山径，海边还远着呢。'] },
    {
      kind: 'npc',
      x: 18,
      y: 6,
      sprite: 'bug-catcher',
      name: '捕虫少年',
      lines: ['草丛里有宝可梦出没，走近就会跳出来！', '这里的怪都很温顺，Lv2-6 而已。'],
      facing: 'left',
    },
    {
      kind: 'npc',
      x: 11,
      y: 20,
      sprite: 'kid',
      name: '短裤小子',
      lines: ['我一直在草丛里转悠，就为了碰上稀有的家伙！'],
      facing: 'right',
    },
  ],
};

// ─────────────────────────────────────────────── 橙华森林

function buildForest(): number[][] {
  const rng = makeRng(202);
  const g = createGrid(32, 24, T.grass);
  border(g, T.tree, 2);
  // 密林：成团的树墙夹出走廊（留缝走路），比均匀撒点更像森林
  for (const [cx, cy, rx, ry] of [
    [3.5, 6, 2.4, 4],
    [3.5, 18, 2.2, 3.4],
    [14, 4, 2.6, 1.8],
    [22, 4, 3.4, 2.4],
    [22, 12, 3, 3],
    [28, 18, 3, 3.2],
    [14, 21, 2.6, 2],
    [28, 8, 2.4, 1.8],
    [19, 19, 1.8, 1.6],
    [26, 21, 1.6, 1.4],
    [4, 12, 1.6, 2],
    [20, 20, 1.6, 1.4],
  ] as const) {
    blob(g, T.tree, cx, cy, rx, ry, rng, { jitter: 0.4, onlyOn: 'grass' });
  }
  // 高草：森林里比草原密，成簇贴着林道
  for (const [cx, cy, rx, ry] of [
    [11, 12, 2.6, 2],
    [25, 9, 3, 2.4],
    [13, 17, 2, 1.6],
    [24, 16, 2.4, 1.8],
    [17, 13, 1.8, 1.6],
    [10, 20, 2, 1.6],
    [28, 13, 1.6, 1.6],
  ] as const) {
    blob(g, T.tallGrass, cx, cy, rx, ry, rng, { jitter: 0.36, onlyOn: 'grass' });
  }
  // 林间空地：一处泥土 + 花
  blob(g, T.gravel, 19, 5, 2.4, 1.6, rng, { jitter: 0.4, onlyOn: 'grass' });

  // 蜿蜒的林道：南进北出，中间绕两个弯
  road(
    g,
    [
      { x: 17, y: 23 },
      { x: 17, y: 16 },
      { x: 8, y: 16 },
      { x: 8, y: 8 },
      { x: 12, y: 8 },
      { x: 12, y: 4 },
      { x: 6, y: 4 },
      { x: 6, y: 1 },
    ],
    T.path,
    2,
  );
  setTile(g, 6, 0, T.path);
  setTile(g, 7, 0, T.path);
  setTile(g, 6, 1, T.path);
  setTile(g, 7, 1, T.path);
  setTile(g, 17, 23, T.path);
  setTile(g, 18, 23, T.path);
  setTile(g, 17, 22, T.path);
  setTile(g, 18, 22, T.path);

  // 东侧林间环线连接研究员与深草区，返回主路无需原路折返。
  road(g, [{ x: 17, y: 16 }, { x: 24, y: 16 }, { x: 24, y: 11 }], T.path, 2);
  road(g, [{ x: 24, y: 11 }, { x: 17, y: 11 }, { x: 17, y: 8 }, { x: 12, y: 8 }], T.path, 2);
  flowerCluster(g, 20, 14, rng, 3);
  flowerCluster(g, 10, 18, rng, 3);
  flowerCluster(g, 7, 6, rng, 2);
  setTile(g, 21, 21, T.rock);
  return g;
}

export const FOREST: MapDef = {
  id: 'forest',
  name: '橙华森林',
  biome: 'forest',
  zoneId: 'forest',
  width: 32,
  height: 24,
  grid: buildForest(),
  spawn: { x: 17, y: 20 },
  intro: '树冠遮住了阳光，高草比草原更密。北面出去就是冠军之路。',
  encounter: { tiles: ['tallGrass'], rate: 0.16 },
  warps: [
    { x: 6, y: 0, to: { mapId: 'route-north', x: 6, y: 23 }, kind: 'edge' },
    { x: 7, y: 0, to: { mapId: 'route-north', x: 7, y: 23 }, kind: 'edge' },
    { x: 17, y: 23, to: { mapId: 'route-grass', x: 16, y: 1 }, kind: 'edge' },
    { x: 18, y: 23, to: { mapId: 'route-grass', x: 17, y: 1 }, kind: 'edge' },
  ],
  objects: [
    { kind: 'sign', x: 16, y: 21, lines: ['「橙华森林」 野生 Lv4-10——草丛很密，走两步就可能遇敌。'] },
    {
      kind: 'npc',
      x: 15,
      y: 15,
      sprite: 'scientist',
      name: '研究员',
      lines: ['我在记录森林里的生态。', '同一个区域的野怪等级是固定的，跟你队伍多强没关系。'],
      facing: 'right',
    },
    {
      kind: 'npc',
      x: 7,
      y: 7,
      sprite: 'elder',
      name: '采药老人',
      lines: ['往北走就是高原了，那边的家伙可不好惹。'],
      facing: 'right',
    },
  ],
};

// ─────────────────────────────────────────────── 104 号道路（丘陵）

function buildRouteMid(): number[][] {
  const rng = makeRng(303);
  const g = createGrid(34, 26, T.grass);
  border(g, T.wall, 2);
  // 草丛、碎石与树
  for (const [cx, cy, rx, ry] of [
    [6, 6, 2.6, 2],
    [18, 18, 2.4, 1.8],
    [27, 5, 2.8, 2.2],
    [28, 17, 2.6, 2],
    [15, 23, 2.8, 1.8],
    [5, 22, 2.2, 1.8],
    [24, 11, 2, 1.6],
  ] as const) {
    blob(g, T.tallGrass, cx, cy, rx, ry, rng, { jitter: 0.36, onlyOn: 'grass' });
  }
  for (const [cx, cy, rx, ry] of [
    [3, 4, 2, 2.2],
    [15, 3, 2.2, 1.6],
    [30, 8, 1.8, 1.8],
    [3, 16, 1.6, 3],
    [30, 22, 2.2, 1.8],
    [16, 11, 1.8, 1.4],
    [25, 20, 1.8, 1.4],
  ] as const) {
    blob(g, T.rock, cx, cy, rx, ry, rng, { jitter: 0.42, onlyOn: 'grass' });
  }
  // 山涧：横贯全图的浅溪（2 格宽），只有一座木桥能过
  for (let x = 1; x < 33; x++) {
    const y = 18 + Math.round(Math.sin(x / 5) * 1.5);
    vLine(g, x, y, y + 1, T.water);
  }

  // 折线山道：西进东出，北面接古代遗迹的石门
  road(
    g,
    [
      { x: 0, y: 13 },
      { x: 12, y: 13 },
      { x: 12, y: 7 },
      { x: 8, y: 7 },
      { x: 8, y: 3 },
    ],
    T.path,
    2,
  );
  road(g, [{ x: 8, y: 7 }, { x: 20, y: 7 }], T.path, 2);
  road(g, [{ x: 20, y: 7 }, { x: 20, y: 14 }, { x: 33, y: 14 }], T.path, 2);
  for (let y = 16; y <= 22; y++) {
    setTile(g, 20, y, T.plank);
    setTile(g, 21, y, T.plank);
  }
  // 桥南步道接入草地探索区；桥头保持与北侧主路相连。
  road(g, [{ x: 20, y: 22 }, { x: 12, y: 22 }], T.path, 2);
  fillRect(g, 8, 2, 2, 2, T.path);
  // 北面的遗迹石门：嵌在岩壁里，门口留 2 格地面
  setTile(g, 8, 1, T.door);
  setTile(g, 7, 1, T.wall);
  setTile(g, 9, 1, T.wall);
  setTile(g, 8, 0, T.wall);
  // 东面的洞口：嵌在岩壁中部，下方留 2 格地面
  setTile(g, 33, 14, T.wall);
  setTile(g, 33, 15, T.wall);
  setTile(g, 32, 14, T.door);
  setTile(g, 32, 15, T.door);
  setTile(g, 33, 13, T.wall);
  setTile(g, 33, 16, T.wall);

  flowerCluster(g, 8, 5, rng, 3);
  flowerCluster(g, 22, 15, rng, 3);
  flowerCluster(g, 24, 22, rng, 3);
  return g;
}

export const ROUTE_MID: MapDef = {
  id: 'route-mid',
  name: '104 号道路',
  biome: 'mid',
  zoneId: 'route-mid',
  width: 34,
  height: 26,
  grid: buildRouteMid(),
  spawn: { x: 1, y: 13 },
  intro: '碎石与岩壁夹出的山道。东面是石之洞窟，北面封闭的入口通往古代遗迹。',
  encounter: { tiles: ['tallGrass'], rate: 0.12 },
  warps: [
    { x: 0, y: 13, to: { mapId: 'route-grass', x: 32, y: 13 }, kind: 'edge' },
    { x: 0, y: 14, to: { mapId: 'route-grass', x: 32, y: 14 }, kind: 'edge' },
    { x: 32, y: 14, to: { mapId: 'cave', x: 1, y: 10 }, kind: 'door' },
    { x: 32, y: 15, to: { mapId: 'cave', x: 1, y: 10 }, kind: 'door' },
    {
      x: 8,
      y: 1,
      to: { mapId: 'ruins', x: 10, y: 15 },
      kind: 'door',
      requiresItem: 'ruins-key',
    },
  ],
  objects: [
    { kind: 'sign', x: 1, y: 12 },
    { kind: 'sign', x: 7, y: 3, lines: ['「古代遗迹」 需要 遗迹之钥 才能进入。钥匙在未白镇的道具店有售。'] },
    {
      kind: 'npc',
      x: 13,
      y: 12,
      sprite: 'hiker',
      name: '登山男',
      lines: ['这条山径翻过去就是洞窟。', '洞窟里暗得很，记得先补满血。'],
      facing: 'left',
    },
    {
      kind: 'npc',
      x: 9,
      y: 4,
      sprite: 'scientist',
      name: '遗迹看守',
      lines: ['遗迹里的石像是活的……没有遗迹之钥就不要进去。'],
      facing: 'left',
    },
    {
      kind: 'npc',
      x: 19,
      y: 16,
      sprite: 'hiker',
      name: '旅行者',
      lines: ['这条山涧只有木桥能过，别想着游过去。'],
      facing: 'down',
    },
  ],
};

// ─────────────────────────────────────────────── 石之洞窟

function buildCave(): number[][] {
  const rng = makeRng(404);
  const g = createGrid(24, 20, T.floor);
  border(g, T.wall, 2);
  // 中央岩体：把洞窟分成南北两厅，两侧各留一条通道
  blob(g, T.wall, 12, 9.5, 4.6, 2.4, rng, { jitter: 0.35, onlyOn: 'floor' });
  blob(g, T.wall, 6, 15.5, 2.4, 1.6, rng, { jitter: 0.3, onlyOn: 'floor' });
  blob(g, T.wall, 18.5, 15, 2.6, 1.6, rng, { jitter: 0.3, onlyOn: 'floor' });
  // 碎石地（遇敌区）铺满两厅
  blob(g, T.gravel, 6, 5, 3.6, 2.4, rng, { jitter: 0.4, onlyOn: 'floor', fill: 0.95 });
  blob(g, T.gravel, 18, 5, 3.6, 2.4, rng, { jitter: 0.4, onlyOn: 'floor', fill: 0.95 });
  blob(g, T.gravel, 11, 15, 4.4, 2.2, rng, { jitter: 0.4, onlyOn: 'floor', fill: 0.95 });
  blob(g, T.gravel, 11, 5.5, 2.4, 1.6, rng, { jitter: 0.4, onlyOn: 'floor', fill: 0.95 });
  // 地下水池：圆润闭合，离墙 1 格
  pond(g, 17.5, 11.5, 2.4, 1.6, rng, { tile: 'gravel', onlyOn: 'floor' });
  // 石笋与落石
  for (const [x, y] of [
    [4, 3], [19, 3], [15, 3], [3, 12], [20, 12], [8, 18], [16, 17], [21, 8],
  ] as const) {
    setTile(g, x, y, T.rock);
  }
  // 两厅通过两格宽石道相连，入口与北阶有清晰可辨的安全通路。
  road(g, [{ x: 1, y: 10 }, { x: 4, y: 10 }, { x: 4, y: 7 }, { x: 14, y: 7 }, { x: 14, y: 2 }], T.floor, 2);
  road(g, [{ x: 14, y: 7 }, { x: 14, y: 14 }, { x: 10, y: 14 }], T.floor, 2);
  // 西面的洞口与北面的石阶（都嵌在岩壁里，门口留地面）
  setTile(g, 0, 10, T.door);
  setTile(g, 1, 10, T.floor);
  setTile(g, 14, 1, T.stairs);
  setTile(g, 15, 1, T.stairs);
  setTile(g, 13, 1, T.wall);
  setTile(g, 16, 1, T.wall);
  setTile(g, 14, 2, T.floor);
  setTile(g, 15, 2, T.floor);
  return g;
}

export const CAVE: MapDef = {
  id: 'cave',
  name: '石之洞窟',
  biome: 'cave',
  zoneId: 'cave',
  width: 24,
  height: 20,
  grid: buildCave(),
  ambient: { color: 0x0a0e22, alpha: 0.32 },
  spawn: { x: 1, y: 10 },
  intro: '岩壁挡住了光线，只有洞口透进来一点亮。北面的石阶通向海边。',
  encounter: { tiles: ['gravel'], rate: 0.14 },
  warps: [
    { x: 0, y: 10, to: { mapId: 'route-mid', x: 31, y: 14 }, kind: 'door' },
    { x: 14, y: 1, to: { mapId: 'coast', x: 14, y: 2 }, kind: 'stairs' },
    { x: 15, y: 1, to: { mapId: 'coast', x: 15, y: 2 }, kind: 'stairs' },
  ],
  objects: [
    { kind: 'sign', x: 2, y: 9, lines: ['石之洞窟：碎石地上会遇到 Lv12-20 的宝可梦，北面石阶通向 108 号水道的海滨。'] },
    {
      kind: 'npc',
      x: 3,
      y: 13,
      sprite: 'scientist',
      name: '考古学家',
      lines: ['这洞里的壁画讲的是大地与海洋的争斗……', '再往深处的遗迹，据说沉在海里。'],
      facing: 'right',
    },
  ],
};

// ─────────────────────────────────────────────── 108 号水道（海滨）

function buildCoast(): number[][] {
  const rng = makeRng(505);
  const g = createGrid(38, 26, T.grass);
  border(g, T.wall, 2);
  // 岸上的树丛与高草（先铺，路与沙滩后压）
  blob(g, T.tree, 4, 6, 2, 2, rng, { onlyOn: 'grass' });
  blob(g, T.tree, 28, 5, 2.4, 2, rng, { onlyOn: 'grass' });
  blob(g, T.tree, 33, 9, 1.6, 1.8, rng, { onlyOn: 'grass' });
  blob(g, T.tallGrass, 10, 9, 2.2, 1.6, rng, { jitter: 0.36, onlyOn: 'grass' });
  blob(g, T.tallGrass, 26, 10, 2.4, 1.6, rng, { jitter: 0.36, onlyOn: 'grass' });
  blob(g, T.tallGrass, 18, 5, 2, 1.6, rng, { jitter: 0.36, onlyOn: 'grass' });
  setTile(g, 9, 4, T.rock);
  setTile(g, 25, 4, T.rock);

  // 弧形海岸线：草地 → 2-3 格沙滩 → 浅水 → 深水
  const shore = (x: number) => 13 + Math.round(Math.sin(x / 5) * 1.6);
  for (let x = 0; x < 38; x++) {
    const y = shore(x);
    for (let dy = 0; dy < 3; dy++) setTile(g, x, y + dy, T.sand);
    for (let dy = 3; dy < 7; dy++) setTile(g, x, y + dy, T.water);
    for (let dy = 7; dy < 13; dy++) setTile(g, x, y + dy, T.deepWater);
  }
  // 两座木栈桥：从沙滩伸到深水，尽头是去孤岛的船（尽头 1 格宽 = 传送格）
  for (const x of [6, 30]) {
    for (let y = 15; y <= 21; y++) {
      setTile(g, x, y, T.plank);
      setTile(g, x + 1, y, T.plank);
    }
    setTile(g, x, 22, T.plank);
    setTile(g, x + 1, 22, T.plank);
  }
  // 海蚀洞口：岩崖里的一处暗门，门口留 2 格沙地
  fillRect(g, 20, 10, 3, 3, T.wall);
  setTile(g, 21, 12, T.door);
  setTile(g, 20, 12, T.sand);
  setTile(g, 22, 12, T.sand);
  setTile(g, 21, 13, T.sand);
  // 北面岩壁里的石阶（回石之洞窟）
  road(g, [{ x: 14, y: 2 }, { x: 14, y: 9 }], T.path, 2);
  setTile(g, 14, 1, T.stairs);
  setTile(g, 15, 1, T.stairs);
  setTile(g, 13, 1, T.wall);
  setTile(g, 16, 1, T.wall);
  // 滨海步道分别连接两座码头，避免低潮线把桥头与陆地切开。
  road(g, [{ x: 14, y: 9 }, { x: 14, y: 11 }, { x: 6, y: 11 }, { x: 6, y: 14 }], T.path, 2);
  road(g, [{ x: 14, y: 9 }, { x: 30, y: 9 }, { x: 30, y: 14 }], T.path, 2);
  flowerCluster(g, 8, 8, rng, 3);
  flowerCluster(g, 24, 7, rng, 3);
  return g;
}

export const COAST: MapDef = {
  id: 'coast',
  name: '108 号水道',
  biome: 'coast',
  zoneId: 'coast',
  width: 38,
  height: 26,
  grid: buildCoast(),
  spawn: { x: 14, y: 4 },
  intro: '沙滩一直延伸到海边，浪打在栈桥的柱子上。水太深，不能下水。',
  encounter: { tiles: ['sand', 'tallGrass'], rate: 0.12 },
  warps: [
    { x: 14, y: 1, to: { mapId: 'cave', x: 14, y: 2 }, kind: 'stairs' },
    { x: 15, y: 1, to: { mapId: 'cave', x: 15, y: 2 }, kind: 'stairs' },
    {
      x: 6,
      y: 22,
      to: { mapId: 'birth-island', x: 9, y: 13 },
      kind: 'door',
      requiresItem: 'birth-key',
    },
    {
      x: 30,
      y: 22,
      to: { mapId: 'southern-island', x: 10, y: 13 },
      kind: 'door',
      requiresItem: 'island-key',
    },
    {
      x: 21,
      y: 12,
      to: { mapId: 'seafloor', x: 2, y: 14 },
      kind: 'door',
      requiresItem: 'ocean-key',
    },
  ],
  objects: [
    { kind: 'sign', x: 13, y: 3 },
    { kind: 'sign', x: 22, y: 12, lines: ['「海底洞窟」 需要 海洋之钥 才能潜下去。钥匙在未白镇的道具店有售。'] },
    { kind: 'sign', x: 5, y: 14, lines: ['西侧栈桥：诞生岛船票 可乘船前往「诞生岛」。'] },
    { kind: 'sign', x: 29, y: 14, lines: ['东侧栈桥：岛之钥 可乘船前往「南方孤岛」。'] },
    {
      kind: 'npc',
      x: 8,
      y: 14,
      sprite: 'sailor',
      name: '水手',
      lines: ['栈桥尽头有船，不过要带上钥匙才能出海。', '深水区不能游，掉下去就只能游回岸边了。'],
      facing: 'left',
    },
    {
      kind: 'npc',
      x: 19,
      y: 8,
      sprite: 'elder',
      name: '钓鱼老手',
      lines: ['岸边沙地上就能遇到宝可梦，Lv15-25，比洞窟里的强一截。'],
      facing: 'right',
    },
    {
      kind: 'npc',
      x: 34,
      y: 12,
      sprite: 'kid',
      name: '海岛少年',
      lines: ['我爸爸说，海底下睡着一位传说中的宝可梦。'],
      facing: 'left',
    },
  ],
};

// ─────────────────────────────────────────────── 冠军之路（高原）

function buildRouteNorth(): number[][] {
  const rng = makeRng(606);
  const g = createGrid(34, 26, T.grass);
  border(g, T.wall, 2);
  // 高草丛 + 岩块 + 高原水塘
  for (const [cx, cy, rx, ry] of [
    [12, 5, 3.4, 2.4],
    [4, 12, 2.4, 2.4],
    [19, 21, 3.4, 2],
    [29, 20, 2.6, 1.8],
    [30, 8, 2.4, 1.8],
    [8, 21, 2.2, 1.6],
    [17, 3, 2, 1.6],
  ] as const) {
    blob(g, T.tallGrass, cx, cy, rx, ry, rng, { jitter: 0.36, onlyOn: 'grass' });
  }
  for (const [cx, cy, rx, ry] of [
    [20, 5, 2.4, 1.6],
    [3, 21, 1.8, 1.6],
    [27, 13, 2, 1.6],
    [11, 13, 1.8, 1.4],
    [31, 12, 1.6, 1.4],
    [16, 20, 1.4, 1.2],
    [21, 12, 1.4, 1.2],
  ] as const) {
    blob(g, T.rock, cx, cy, rx, ry, rng, { jitter: 0.42, onlyOn: 'grass' });
  }
  pond(g, 19, 15, 2.4, 1.4, rng, { tile: 'rock', onlyOn: 'grass' });
  // 之字形高原路：南进东出，东北角是天空之柱的塔基
  road(
    g,
    [
      { x: 6, y: 25 },
      { x: 6, y: 17 },
      { x: 14, y: 17 },
      { x: 14, y: 10 },
      { x: 24, y: 10 },
      { x: 24, y: 16 },
      { x: 33, y: 16 },
    ],
    T.path,
    2,
  );
  road(g, [{ x: 24, y: 6 }, { x: 24, y: 10 }], T.path, 2);
  // 塔基座：岩台 + 塔门（门口留 2 格路）
  blob(g, T.wall, 24, 3.5, 4.6, 2.2, rng, { jitter: 0.28, onlyOn: 'grass' });
  road(g, [{ x: 24, y: 7 }, { x: 24, y: 9 }], T.path, 2);
  setTile(g, 23, 6, T.wall);
  setTile(g, 25, 6, T.wall);
  setTile(g, 24, 6, T.door);
  setTile(g, 24, 5, T.wall);
  setTile(g, 24, 4, T.wall);
  setTile(g, 6, 25, T.path);
  setTile(g, 7, 25, T.path);
  setTile(g, 32, 16, T.path);
  setTile(g, 32, 17, T.path);
  flowerCluster(g, 10, 18, rng, 3);
  flowerCluster(g, 22, 18, rng, 3);
  flowerCluster(g, 8, 8, rng, 2);
  return g;
}

export const ROUTE_NORTH: MapDef = {
  id: 'route-north',
  name: '冠军之路',
  biome: 'north',
  zoneId: 'route-north',
  width: 34,
  height: 26,
  grid: buildRouteNorth(),
  spawn: { x: 6, y: 22 },
  intro: '风很大，云就在脚下。冠军之路上多是进化型，东面是烟囱山。',
  encounter: { tiles: ['tallGrass'], rate: 0.14 },
  warps: [
    { x: 6, y: 25, to: { mapId: 'forest', x: 6, y: 1 }, kind: 'edge' },
    { x: 7, y: 25, to: { mapId: 'forest', x: 7, y: 1 }, kind: 'edge' },
    { x: 33, y: 16, to: { mapId: 'volcano', x: 1, y: 15 }, kind: 'edge' },
    { x: 33, y: 17, to: { mapId: 'volcano', x: 1, y: 16 }, kind: 'edge' },
    {
      x: 24,
      y: 6,
      to: { mapId: 'sky-pillar-1f', x: 10, y: 15 },
      kind: 'door',
      requiresItem: 'sky-key',
    },
  ],
  objects: [
    { kind: 'sign', x: 5, y: 18 },
    { kind: 'sign', x: 25, y: 7, lines: ['「天空之柱」 需要 天空之钥 才能登塔。钥匙在未白镇的道具店有售。'] },
    {
      kind: 'npc',
      x: 10,
      y: 16,
      sprite: 'hiker',
      name: '登山向导',
      lines: ['高原上 Lv17-28，都是进化过的家伙，队伍没练过就别硬闯。'],
      facing: 'right',
    },
    {
      kind: 'npc',
      x: 22,
      y: 7,
      sprite: 'sailor',
      name: '塔的守卫',
      lines: ['这座塔里住着天空的传说。', '没有天空之钥，塔门是不会开的。'],
      facing: 'right',
    },
  ],
};

// ─────────────────────────────────────────────── 烟囱山（火山）

function buildVolcano(): number[][] {
  const rng = makeRng(707);
  const g = createGrid(34, 26, T.gravel);
  border(g, T.wall, 2);
  // 岩浆池：贴着岩壁，中央留给徒步的灰地
  blob(g, T.lava, 25, 8, 3.4, 2.4, rng, { jitter: 0.26, onlyOn: 'gravel' });
  blob(g, T.lava, 26, 19, 3, 2, rng, { jitter: 0.26, onlyOn: 'gravel' });
  blob(g, T.lava, 15, 22, 2.6, 1.6, rng, { jitter: 0.28, onlyOn: 'gravel' });
  blob(g, T.lava, 17, 11, 2, 1.6, rng, { jitter: 0.28, onlyOn: 'gravel' });
  // 火山灰地（遇敌区）与岩块
  for (const [cx, cy, rx, ry] of [
    [16, 6, 3.4, 2.2],
    [22, 14, 3.2, 2.2],
    [8, 20, 3, 2],
    [29, 13, 2.6, 2],
    [6, 12, 2.2, 1.6],
    [13, 17, 2, 1.6],
  ] as const) {
    blob(g, T.ash, cx, cy, rx, ry, rng, { jitter: 0.4, onlyOn: 'gravel' });
  }
  for (const [cx, cy, rx, ry] of [
    [21, 4, 2, 1.6],
    [29, 4, 1.8, 1.6],
    [3, 20, 1.8, 1.6],
    [30, 22, 2, 1.6],
    [12, 12, 1.6, 1.4],
    [19, 17, 1.6, 1.2],
  ] as const) {
    blob(g, T.rock, cx, cy, rx, ry, rng, { jitter: 0.42, onlyOn: 'gravel' });
  }
  // 折线石道（火山岩铺地）：西进，北面接熔岩洞窟
  road(
    g,
    [
      { x: 0, y: 15 },
      { x: 10, y: 15 },
      { x: 10, y: 8 },
      { x: 4, y: 8 },
      { x: 4, y: 4 },
      { x: 12, y: 4 },
      { x: 12, y: 2 },
    ],
    T.floor,
    2,
  );
  setTile(g, 0, 15, T.floor);
  setTile(g, 1, 15, T.floor);
  setTile(g, 0, 16, T.floor);
  setTile(g, 1, 16, T.floor);
  // 熔岩洞窟的入口嵌在岩壁里，门口留 2 格石地
  setTile(g, 11, 1, T.wall);
  setTile(g, 13, 1, T.wall);
  setTile(g, 12, 1, T.door);
  setTile(g, 11, 2, T.floor);
  setTile(g, 12, 2, T.floor);
  setTile(g, 13, 2, T.floor);
  return g;
}

export const VOLCANO: MapDef = {
  id: 'volcano',
  name: '烟囱山',
  biome: 'volcano',
  zoneId: 'volcano',
  width: 34,
  height: 26,
  grid: buildVolcano(),
  ambient: { color: 0x3a0a06, alpha: 0.16 },
  spawn: { x: 2, y: 15 },
  intro: '熔岩的红光把岩壁染成暗红色，灰烬落在肩上。',
  encounter: { tiles: ['ash'], rate: 0.14 },
  warps: [
    { x: 0, y: 15, to: { mapId: 'route-north', x: 32, y: 16 }, kind: 'edge' },
    { x: 0, y: 16, to: { mapId: 'route-north', x: 32, y: 17 }, kind: 'edge' },
    {
      x: 12,
      y: 1,
      to: { mapId: 'magma', x: 2, y: 15 },
      kind: 'door',
      requiresItem: 'magma-key',
    },
  ],
  objects: [
    { kind: 'sign', x: 2, y: 14 },
    { kind: 'sign', x: 13, y: 2, lines: ['「熔岩洞窟」 需要 熔岩之钥 才能进入。钥匙在未白镇的道具店有售。'] },
    {
      kind: 'npc',
      x: 9,
      y: 14,
      sprite: 'hiker',
      name: '火系训练家',
      lines: ['灰地里会遇到 Lv20-30 的宝可梦，强者才能走到这里。'],
      facing: 'right',
    },
    {
      kind: 'npc',
      x: 16,
      y: 18,
      sprite: 'scientist',
      name: '探险家',
      lines: ['熔岩深处的大地在呼吸——那是固拉多的脉搏。'],
      facing: 'down',
    },
  ],
};
