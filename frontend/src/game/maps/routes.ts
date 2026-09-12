import {
  border,
  createGrid,
  fillRect,
  hLine,
  makeRng,
  openEdge,
  patch,
  scatter,
  setTile,
  vLine,
} from './builders';
import { T } from './tiles';
import type { MapDef } from './types';

/**
 * 七块野外区域。每张图固定一个遇敌 `zoneId`（等级带与野生池由后端决定），
 * 出口靠**边缘行走**或踩门口/楼梯完成；传说区入口（古代遗迹 / 天空之柱 / 熔岩洞窟）
 * 带 `requiresItem`，没钥匙会被对话拦住。
 */

// ─────────────────────────────────────────────── 101 号道路（草原）

function buildRouteGrass(): number[][] {
  const rng = makeRng(101);
  const g = createGrid(32, 24, T.grass);
  border(g, T.tree);
  vLine(g, 15, 1, 22, T.path);
  vLine(g, 16, 1, 22, T.path);
  hLine(g, 15, 31, 12, T.path);
  openEdge(g, 'north', 15, 2);
  openEdge(g, 'south', 15, 2);
  openEdge(g, 'east', 12, 1);
  for (const area of [
    { x: 3, y: 3, w: 9, h: 7 },
    { x: 20, y: 3, w: 9, h: 7 },
    { x: 3, y: 15, w: 10, h: 7 },
    { x: 20, y: 16, w: 9, h: 6 },
  ]) {
    patch(g, T.tallGrass, area, 0.8, rng);
  }
  scatter(g, T.tree, { x: 1, y: 1, w: 30, h: 22 }, 0.05, rng);
  scatter(g, T.flower, { x: 1, y: 1, w: 30, h: 22 }, 0.05, rng);
  fillRect(g, 25, 8, 4, 3, T.water);
  return g;
}

export const ROUTE_GRASS: MapDef = {
  id: 'route-grass',
  name: '101 号道路',
  biome: 'grass',
  zoneId: 'route-grass',
  width: 32,
  height: 24,
  grid: buildRouteGrass(),
  spawn: { x: 15, y: 20 },
  intro: '起伏的草原，野生宝可梦的等级最低。北面是橙华森林，东面通往山径。',
  encounter: { tiles: ['tallGrass'], rate: 0.12 },
  warps: [
    { x: 15, y: 0, to: { mapId: 'forest', x: 17, y: 20 }, kind: 'edge' },
    { x: 16, y: 0, to: { mapId: 'forest', x: 18, y: 20 }, kind: 'edge' },
    { x: 15, y: 23, to: { mapId: 'town', x: 13, y: 1 }, kind: 'edge' },
    { x: 16, y: 23, to: { mapId: 'town', x: 14, y: 1 }, kind: 'edge' },
    { x: 31, y: 12, to: { mapId: 'route-mid', x: 1, y: 12 }, kind: 'edge' },
  ],
  objects: [
    { kind: 'sign', x: 14, y: 2 },
    { kind: 'sign', x: 14, y: 20, lines: ['南边是未白镇，北面是橙华森林——草丛里的宝可梦等级只跟区域有关。'] },
    {
      kind: 'npc',
      x: 14,
      y: 7,
      sprite: 'bug-catcher',
      name: '捕虫少年',
      lines: ['草丛里有宝可梦出没，走近就会跳出来！', '这里的怪都很温顺，Lv2-6 而已。'],
      facing: 'right',
    },
    {
      kind: 'npc',
      x: 17,
      y: 17,
      sprite: 'kid',
      name: '短裤小子',
      lines: ['我一直在草丛里转悠，就为了碰上稀有的家伙！'],
      facing: 'left',
    },
  ],
};

// ─────────────────────────────────────────────── 橙华森林

function buildForest(): number[][] {
  const rng = makeRng(202);
  const g = createGrid(30, 22, T.grass);
  border(g, T.tree);
  // 蜿蜒的林道：南进北出，中间一段东西向
  vLine(g, 17, 11, 20, T.path);
  vLine(g, 18, 11, 20, T.path);
  hLine(g, 6, 18, 11, T.path);
  hLine(g, 6, 18, 12, T.path);
  vLine(g, 6, 1, 12, T.path);
  vLine(g, 7, 1, 12, T.path);
  openEdge(g, 'north', 6, 2);
  openEdge(g, 'south', 17, 2);
  // 深树围合：整片撒树（林道是 path 不会被覆盖）
  scatter(g, T.tree, { x: 1, y: 1, w: 28, h: 20 }, 0.28, rng);
  // 高草比草原更密
  for (const area of [
    { x: 1, y: 2, w: 14, h: 8 },
    { x: 20, y: 1, w: 9, h: 9 },
    { x: 9, y: 14, w: 19, h: 7 },
  ]) {
    patch(g, T.tallGrass, area, 0.85, rng);
  }
  scatter(g, T.flower, { x: 1, y: 1, w: 28, h: 20 }, 0.04, rng);
  return g;
}

export const FOREST: MapDef = {
  id: 'forest',
  name: '橙华森林',
  biome: 'forest',
  zoneId: 'forest',
  width: 30,
  height: 22,
  grid: buildForest(),
  spawn: { x: 17, y: 20 },
  intro: '树冠遮住了阳光，高草比草原更密。北面出去就是冠军之路。',
  encounter: { tiles: ['tallGrass'], rate: 0.16 },
  warps: [
    { x: 6, y: 0, to: { mapId: 'route-north', x: 6, y: 20 }, kind: 'edge' },
    { x: 7, y: 0, to: { mapId: 'route-north', x: 7, y: 20 }, kind: 'edge' },
    { x: 17, y: 21, to: { mapId: 'route-grass', x: 15, y: 1 }, kind: 'edge' },
    { x: 18, y: 21, to: { mapId: 'route-grass', x: 16, y: 1 }, kind: 'edge' },
  ],
  objects: [
    { kind: 'sign', x: 16, y: 20, lines: ['「橙华森林」 野生 Lv4-10——草丛很密，走两步就可能遇敌。'] },
    {
      kind: 'npc',
      x: 16,
      y: 16,
      sprite: 'scientist',
      name: '研究员',
      lines: ['我在记录森林里的生态。', '同一个区域的野怪等级是固定的，跟你队伍多强没关系。'],
      facing: 'right',
    },
    {
      kind: 'npc',
      x: 5,
      y: 8,
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
  const g = createGrid(32, 24, T.grass);
  border(g, T.rock);
  hLine(g, 1, 29, 12, T.path);
  vLine(g, 29, 12, 14, T.path);
  hLine(g, 29, 31, 14, T.path);
  vLine(g, 7, 1, 12, T.path);
  openEdge(g, 'west', 12, 1);
  openEdge(g, 'east', 14, 1);
  setTile(g, 7, 0, T.door);
  // 山涧：横贯全图，只有一座木桥可以过
  fillRect(g, 0, 17, 32, 2, T.water);
  setTile(g, 20, 17, T.plank);
  setTile(g, 20, 18, T.plank);
  scatter(g, T.rock, { x: 1, y: 1, w: 30, h: 15 }, 0.1, rng);
  for (const area of [
    { x: 10, y: 3, w: 9, h: 6 },
    { x: 19, y: 7, w: 9, h: 4 },
    { x: 11, y: 15, w: 8, h: 2 },
    { x: 22, y: 20, w: 8, h: 3 },
  ]) {
    patch(g, T.tallGrass, area, 0.7, rng);
  }
  return g;
}

export const ROUTE_MID: MapDef = {
  id: 'route-mid',
  name: '104 号道路',
  biome: 'mid',
  zoneId: 'route-mid',
  width: 32,
  height: 24,
  grid: buildRouteMid(),
  spawn: { x: 1, y: 12 },
  intro: '碎石与岩壁夹出的山道。东面是石之洞窟，北面封闭的入口通往古代遗迹。',
  encounter: { tiles: ['tallGrass'], rate: 0.12 },
  warps: [
    { x: 0, y: 12, to: { mapId: 'route-grass', x: 30, y: 12 }, kind: 'edge' },
    { x: 31, y: 14, to: { mapId: 'cave', x: 1, y: 10 }, kind: 'edge' },
    {
      x: 7,
      y: 0,
      to: { mapId: 'ruins', x: 10, y: 15 },
      kind: 'door',
      requiresItem: 'ruins-key',
    },
  ],
  objects: [
    { kind: 'sign', x: 1, y: 11 },
    { kind: 'sign', x: 6, y: 2, lines: ['「古代遗迹」 需要 遗迹之钥 才能进入。钥匙在未白镇的道具店有售。'] },
    {
      kind: 'npc',
      x: 8,
      y: 10,
      sprite: 'hiker',
      name: '登山男',
      lines: ['这条山径翻过去就是洞窟。', '洞窟里暗得很，记得先补满血。'],
      facing: 'left',
    },
    {
      kind: 'npc',
      x: 8,
      y: 2,
      sprite: 'scientist',
      name: '遗迹看守',
      lines: ['遗迹里的石像是活的……没有遗迹之钥就不要进去。'],
      facing: 'left',
    },
    {
      kind: 'npc',
      x: 21,
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
  const g = createGrid(28, 20, T.floor);
  border(g, T.rock);
  // 中间一道岩壁，只在 x=14/15 留缺口
  fillRect(g, 1, 10, 26, 1, T.rock);
  setTile(g, 14, 10, T.floor);
  setTile(g, 15, 10, T.floor);
  // 石柱与碎石堆
  for (const [x, y] of [
    [5, 4], [6, 4], [5, 5], [21, 4], [22, 4], [22, 5], [9, 15], [10, 15], [9, 16],
    [18, 14], [19, 14], [12, 7], [17, 6],
  ] as const) {
    setTile(g, x, y, T.rock);
  }
  for (const area of [
    { x: 2, y: 2, w: 11, h: 7 },
    { x: 17, y: 2, w: 8, h: 7 },
    { x: 3, y: 12, w: 8, h: 5 },
  ]) {
    patch(g, T.gravel, area, 0.55, rng, 'floor');
  }
  fillRect(g, 20, 11, 5, 3, T.water);
  setTile(g, 0, 10, T.door);
  setTile(g, 1, 10, T.floor);
  setTile(g, 14, 0, T.stairs);
  setTile(g, 15, 0, T.stairs);
  return g;
}

export const CAVE: MapDef = {
  id: 'cave',
  name: '石之洞窟',
  biome: 'cave',
  zoneId: 'cave',
  width: 28,
  height: 20,
  grid: buildCave(),
  ambient: { color: 0x0a0e22, alpha: 0.32 },
  spawn: { x: 1, y: 10 },
  intro: '岩壁挡住了光线，只有洞口透进来一点亮。北面的石阶通向海边。',
  encounter: { tiles: ['gravel'], rate: 0.14 },
  warps: [
    { x: 0, y: 10, to: { mapId: 'route-mid', x: 30, y: 14 }, kind: 'door' },
    { x: 14, y: 0, to: { mapId: 'coast', x: 14, y: 1 }, kind: 'stairs' },
    { x: 15, y: 0, to: { mapId: 'coast', x: 15, y: 1 }, kind: 'stairs' },
  ],
  objects: [
    { kind: 'sign', x: 1, y: 9, lines: ['石之洞窟：碎石地上会遇到 Lv12-20 的宝可梦，北面石阶通向 108 号水道的海滨。'] },
    {
      kind: 'npc',
      x: 6,
      y: 12,
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
  const g = createGrid(34, 22, T.grass);
  border(g, T.rock);
  fillRect(g, 0, 16, 34, 6, T.water);
  fillRect(g, 0, 19, 34, 3, T.deepWater);
  fillRect(g, 1, 10, 32, 6, T.sand);
  scatter(g, T.rock, { x: 1, y: 1, w: 32, h: 9 }, 0.12, rng);
  scatter(g, T.tree, { x: 1, y: 1, w: 32, h: 9 }, 0.06, rng);
  scatter(g, T.tallGrass, { x: 1, y: 1, w: 32, h: 9 }, 0.06, rng);
  // 栈桥（两座，通向孤岛）
  vLine(g, 4, 15, 19, T.plank);
  vLine(g, 29, 15, 19, T.plank);
  // 海蚀洞口
  fillRect(g, 21, 12, 5, 3, T.rock);
  setTile(g, 23, 15, T.door);
  setTile(g, 14, 0, T.stairs);
  setTile(g, 15, 0, T.stairs);
  // 落点固定为路，避免随机岩石/树挡住入口
  setTile(g, 14, 1, T.path);
  setTile(g, 15, 1, T.path);
  return g;
}

export const COAST: MapDef = {
  id: 'coast',
  name: '108 号水道',
  biome: 'coast',
  zoneId: 'coast',
  width: 34,
  height: 22,
  grid: buildCoast(),
  spawn: { x: 14, y: 2 },
  intro: '沙滩一直延伸到海边，浪打在栈桥的柱子上。水太深，不能下水。',
  encounter: { tiles: ['sand', 'tallGrass'], rate: 0.12 },
  warps: [
    { x: 14, y: 0, to: { mapId: 'cave', x: 14, y: 1 }, kind: 'stairs' },
    { x: 15, y: 0, to: { mapId: 'cave', x: 15, y: 1 }, kind: 'stairs' },
    {
      x: 4,
      y: 19,
      to: { mapId: 'birth-island', x: 8, y: 13 },
      kind: 'door',
      requiresItem: 'birth-key',
    },
    {
      x: 29,
      y: 19,
      to: { mapId: 'southern-island', x: 10, y: 13 },
      kind: 'door',
      requiresItem: 'island-key',
    },
    {
      x: 23,
      y: 15,
      to: { mapId: 'seafloor', x: 3, y: 15 },
      kind: 'door',
      requiresItem: 'ocean-key',
    },
  ],
  objects: [
    { kind: 'sign', x: 13, y: 2 },
    { kind: 'sign', x: 22, y: 15, lines: ['「海底洞窟」 需要 海洋之钥 才能潜下去。钥匙在未白镇的道具店有售。'] },
    { kind: 'sign', x: 3, y: 15, lines: ['西侧栈桥：诞生岛船票 可乘船前往「诞生岛」。'] },
    { kind: 'sign', x: 30, y: 15, lines: ['东侧栈桥：岛之钥 可乘船前往「南方孤岛」。'] },
    {
      kind: 'npc',
      x: 13,
      y: 14,
      sprite: 'sailor',
      name: '水手',
      lines: ['栈桥尽头有船，不过要带上钥匙才能出海。', '深水区不能游，掉下去就只能游回岸边了。'],
      facing: 'right',
    },
    {
      kind: 'npc',
      x: 20,
      y: 9,
      sprite: 'elder',
      name: '钓鱼老手',
      lines: ['岸边沙地上就能遇到宝可梦，Lv15-25，比洞窟里的强一截。'],
      facing: 'right',
    },
    {
      kind: 'npc',
      x: 28,
      y: 15,
      sprite: 'kid',
      name: '海岛少年',
      lines: ['我爸爸说，海底下睡着一位传说中的宝可梦。'],
      facing: 'right',
    },
  ],
};

// ─────────────────────────────────────────────── 冠军之路（高原）

function buildRouteNorth(): number[][] {
  const rng = makeRng(606);
  const g = createGrid(30, 22, T.grass);
  border(g, T.rock);
  vLine(g, 6, 2, 20, T.path);
  hLine(g, 6, 28, 16, T.path);
  vLine(g, 24, 5, 16, T.path);
  openEdge(g, 'south', 6, 2);
  openEdge(g, 'east', 16, 1);
  for (const area of [
    { x: 1, y: 3, w: 18, h: 11 },
    { x: 9, y: 18, w: 19, h: 3 },
    { x: 19, y: 7, w: 9, h: 8 },
  ]) {
    patch(g, T.tallGrass, area, 0.75, rng);
  }
  fillRect(g, 14, 7, 4, 3, T.water);
  scatter(g, T.rock, { x: 1, y: 1, w: 28, h: 20 }, 0.12, rng);
  // 塔基座：岩台 + 塔门（需要天空之钥）
  fillRect(g, 21, 2, 7, 4, T.rock);
  setTile(g, 24, 4, T.door);
  setTile(g, 24, 5, T.path);
  setTile(g, 25, 5, T.path);
  setTile(g, 25, 4, T.sign);
  setTile(g, 23, 5, T.path);
  // 落点固定为路
  setTile(g, 6, 20, T.path);
  setTile(g, 7, 20, T.path);
  return g;
}

export const ROUTE_NORTH: MapDef = {
  id: 'route-north',
  name: '冠军之路',
  biome: 'north',
  zoneId: 'route-north',
  width: 30,
  height: 22,
  grid: buildRouteNorth(),
  spawn: { x: 6, y: 20 },
  intro: '风很大，云就在脚下。冠军之路上多是进化型，东面是烟囱山。',
  encounter: { tiles: ['tallGrass'], rate: 0.14 },
  warps: [
    { x: 6, y: 21, to: { mapId: 'forest', x: 6, y: 1 }, kind: 'edge' },
    { x: 7, y: 21, to: { mapId: 'forest', x: 7, y: 1 }, kind: 'edge' },
    { x: 29, y: 16, to: { mapId: 'volcano', x: 1, y: 16 }, kind: 'edge' },
    {
      x: 24,
      y: 4,
      to: { mapId: 'sky-pillar-1f', x: 10, y: 14 },
      kind: 'door',
      requiresItem: 'sky-key',
    },
  ],
  objects: [
    { kind: 'sign', x: 5, y: 3 },
    { kind: 'sign', x: 25, y: 4, lines: ['「天空之柱」 需要 天空之钥 才能登塔。钥匙在未白镇的道具店有售。'] },
    {
      kind: 'npc',
      x: 8,
      y: 14,
      sprite: 'hiker',
      name: '登山向导',
      lines: ['高原上 Lv17-28，都是进化过的家伙，队伍没练过就别硬闯。'],
      facing: 'left',
    },
    {
      kind: 'npc',
      x: 23,
      y: 5,
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
  const g = createGrid(30, 22, T.grass);
  border(g, T.rock);
  hLine(g, 1, 28, 16, T.path);
  vLine(g, 10, 2, 16, T.path);
  openEdge(g, 'west', 16, 1);
  for (const area of [
    { x: 1, y: 2, w: 28, h: 12 },
    { x: 1, y: 17, w: 28, h: 3 },
  ]) {
    patch(g, T.ash, area, 0.6, rng);
  }
  fillRect(g, 16, 4, 8, 4, T.lava);
  fillRect(g, 3, 8, 6, 3, T.lava);
  fillRect(g, 20, 18, 6, 2, T.lava);
  scatter(g, T.rock, { x: 1, y: 1, w: 28, h: 20 }, 0.12, rng);
  scatter(g, T.ash, { x: 1, y: 1, w: 28, h: 20 }, 0.12, rng);
  setTile(g, 10, 1, T.door);
  setTile(g, 9, 1, T.sign);
  return g;
}

export const VOLCANO: MapDef = {
  id: 'volcano',
  name: '烟囱山',
  biome: 'volcano',
  zoneId: 'volcano',
  width: 30,
  height: 22,
  grid: buildVolcano(),
  ambient: { color: 0x3a0a06, alpha: 0.16 },
  spawn: { x: 1, y: 16 },
  intro: '熔岩的红光把岩壁染成暗红色，灰烬落在肩上。',
  encounter: { tiles: ['ash'], rate: 0.14 },
  warps: [
    { x: 0, y: 16, to: { mapId: 'route-north', x: 28, y: 16 }, kind: 'edge' },
    {
      x: 10,
      y: 1,
      to: { mapId: 'magma', x: 4, y: 15 },
      kind: 'door',
      requiresItem: 'magma-key',
    },
  ],
  objects: [
    { kind: 'sign', x: 8, y: 15 },
    { kind: 'sign', x: 9, y: 1, lines: ['「熔岩洞窟」 需要 熔岩之钥 才能进入。钥匙在未白镇的道具店有售。'] },
    {
      kind: 'npc',
      x: 11,
      y: 14,
      sprite: 'hiker',
      name: '火系训练家',
      lines: ['灰地里会遇到 Lv20-30 的宝可梦，强者才能走到这里。'],
      facing: 'left',
    },
    {
      kind: 'npc',
      x: 20,
      y: 17,
      sprite: 'scientist',
      name: '探险家',
      lines: ['熔岩深处的大地在呼吸——那是固拉多的脉搏。'],
      facing: 'down',
    },
  ],
};
