import {
  hLine,
  border,
  building,
  createGrid,
  fillRect,
  makeRng,
  openEdge,
  scatter,
  setTile,
  vLine,
} from './builders';
import { T } from './tiles';
import type { MapDef } from './types';

/**
 * 未白镇（起始镇，28×20）：宝可梦中心（红顶 + 十字）+ 道具店 + 两栋民居 + 水塘，
 * 镇内没有野生宝可梦（`zoneId: 'town'` 安全区）。北出口通往 101 号道路。
 */
const W = 28;
const H = 20;

function build(): number[][] {
  const rng = makeRng(20260912);
  const g = createGrid(W, H, T.grass);
  border(g, T.tree);

  // 南北主街（2 格宽）+ 东西横街
  vLine(g, 13, 1, 18, T.path);
  vLine(g, 14, 1, 18, T.path);
  hLine(g, 3, 24, 8, T.path);
  // 建筑门前的小径
  vLine(g, 6, 5, 7, T.path);
  vLine(g, 20, 5, 7, T.path);
  vLine(g, 4, 9, 14, T.path);
  vLine(g, 21, 9, 14, T.path);

  // 建筑：宝可梦中心（红顶）/ 道具店（蓝顶）/ 两栋民居
  building(g, 4, 3, 5);
  building(g, 18, 3, 5);
  building(g, 3, 12, 4);
  building(g, 20, 12, 4);

  // 水塘与绿化
  fillRect(g, 2, 16, 5, 3, T.water);
  setTile(g, 6, 17, T.sand);
  scatter(g, T.flower, { x: 2, y: 1, w: W - 4, h: H - 2 }, 0.05, rng);
  scatter(g, T.tree, { x: 9, y: 10, w: 4, h: 8 }, 0.16, rng);
  scatter(g, T.tree, { x: 16, y: 10, w: 7, h: 3 }, 0.12, rng);

  // 北出口（去 101 号道路）
  openEdge(g, 'north', 13, 2);
  return g;
}

export const TOWN: MapDef = {
  id: 'town',
  name: '未白镇',
  biome: 'town',
  zoneId: 'town',
  width: W,
  height: H,
  grid: build(),
  spawn: { x: 13, y: 16 },
  intro: '宝可梦中心与道具店都在这条街上，北面是 101 号道路。',
  warps: [
    { x: 13, y: 0, to: { mapId: 'route-grass', x: 15, y: 22 }, kind: 'edge' },
    { x: 14, y: 0, to: { mapId: 'route-grass', x: 16, y: 22 }, kind: 'edge' },
  ],
  objects: [
    {
      kind: 'door',
      x: 6,
      y: 4,
      building: 'center',
      label: '宝可梦中心',
      action: 'heal',
      lines: ['欢迎光临宝可梦中心！要让你的宝可梦恢复活力吗？（每次 10 积分）'],
    },
    {
      kind: 'door',
      x: 20,
      y: 4,
      building: 'shop',
      label: '道具店',
      action: 'shop',
      lines: ['这里是道具店——要看看货架吗？'],
    },
    {
      kind: 'npc',
      x: 5,
      y: 5,
      sprite: 'nurse',
      name: '护士',
      lines: ['宝可梦受伤了就要及时治疗哦。', '全队恢复一次 10 积分，全员满血的话不收费。'],
      action: 'heal',
      facing: 'down',
    },
    {
      kind: 'npc',
      x: 19,
      y: 5,
      sprite: 'clerk',
      name: '店员',
      lines: ['精灵球、伤药、进化石、王冠……道具店应有尽有！'],
      action: 'shop',
      facing: 'down',
    },
    {
      kind: 'npc',
      x: 12,
      y: 10,
      sprite: 'elder',
      name: '镇上的老人',
      lines: [
        '越往北走，野生的宝可梦就越强：南边 Lv2-6，森林 Lv4-10，高原上是 Lv17-28 的进化型。',
        '队伍等级再高也不会把野怪养肥，想抓低等级的就回南边去。',
      ],
      facing: 'right',
    },
    {
      kind: 'npc',
      x: 15,
      y: 12,
      sprite: 'kid',
      name: '镇上的孩子',
      lines: [
        '听说特殊的洞窟要用钥匙才能进去，钥匙在道具店有卖！',
        '我没钥匙的时候，门口的告示牌会写清楚要哪一把。',
      ],
      facing: 'left',
    },
    { kind: 'door', x: 4, y: 13, building: 'house', label: '民居', action: 'info', lines: ['门锁着——主人在宝可梦中心当班，晚点再来吧。'] },
    { kind: 'door', x: 21, y: 13, building: 'house', label: '民居', action: 'info', lines: ['屋里传来电视的声音："今日天气：晴，101 号道路适合散步。"'] },
    { kind: 'sign', x: 12, y: 2 },
    { kind: 'sign', x: 7, y: 5, lines: ['宝可梦中心：全队 HP 恢复，每次 10 积分（全员满血不收费）。'] },
    { kind: 'sign', x: 22, y: 5, lines: ['道具店：精灵球 50 / 超级球 150 / 高级球 400 / 伤药 50 / 进化石 800。'] },
  ],
};
