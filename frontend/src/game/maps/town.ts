import {
  building,
  border,
  createGrid,
  flowerCluster,
  fillRect,
  hLine,
  makeRng,
  pond,
} from './builders';
import { T } from './tiles';
import type { MapDef } from './types';

/**
 * 未白镇（起始镇，32×24）：宝可梦中心（红顶 + 十字）+ 道具店 + 两栋民居 + 水塘，
 * 镇内没有野生宝可梦（`zoneId: 'town'` 安全区）。北出口通往 101 号道路。
 *
 * 布局按原作的小镇习惯来：中轴主街 + 两条横街，两间店铺面南对着主街（门前 1 格门垫），
 * 民居在南半区对称分布，西侧留一口圆润的水塘；四周 2 格厚的树墙围死，只在北面开口。
 */
const W = 32;
const H = 24;

function build(): number[][] {
  const rng = makeRng(20260912);
  const g = createGrid(W, H, T.grass);
  border(g, T.tree, 2);

  // 主街连通南北广场；各户都有独立门前支路，NPC 站在路旁。
  fillRect(g, 15, 0, 2, 22, T.path);
  fillRect(g, 8, 11, 16, 3, T.path);
  fillRect(g, 12, 17, 8, 3, T.path);
  fillRect(g, 6, 18, 20, 2, T.path);
  fillRect(g, 9, 7, 3, 4, T.path);
  fillRect(g, 20, 7, 3, 4, T.path);
  building(g, 8, 4, 5, 'roof', 'wall', 2);
  building(g, 19, 4, 5, 'roof', 'wall', 2);
  building(g, 4, 15, 5, 'roof', 'wall', 2);
  building(g, 22, 15, 5, 'roof', 'wall', 2);

  // 水塘限于西侧庭园，与民居门前步道和边界树墙分开。
  pond(g, 5, 12, 1.7, 1.4, rng, { tile: 'sand', onlyOn: 'grass' });
  fillRect(g, 3, 4, 3, 3, T.tree);
  fillRect(g, 26, 4, 3, 3, T.tree);
  fillRect(g, 26, 10, 3, 3, T.tree);
  for (const [x, y] of [[13, 4], [17, 4], [9, 9], [23, 9], [11, 15], [20, 15], [5, 21], [24, 21]]) {
    flowerCluster(g, x, y, rng, 4);
  }
  // 南广场两侧保留花圃，中轴与住宅入口不放阻挡物。
  hLine(g, 11, 13, 21, T.flower);
  hLine(g, 18, 20, 21, T.flower);
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
  spawn: { x: 15, y: 17 },
  intro: '宝可梦中心与道具店都在这条街上，北面是 101 号道路。',
  warps: [
    { x: 15, y: 0, to: { mapId: 'route-grass', x: 16, y: 23 }, kind: 'edge' },
    { x: 16, y: 0, to: { mapId: 'route-grass', x: 17, y: 23 }, kind: 'edge' },
  ],
  objects: [
    {
      kind: 'door',
      x: 10,
      y: 6,
      building: 'center',
      label: '宝可梦中心',
      action: 'heal',
      lines: ['欢迎光临宝可梦中心！要让你的宝可梦恢复活力吗？（每次 10 积分）'],
    },
    {
      kind: 'door',
      x: 21,
      y: 6,
      building: 'shop',
      label: '道具店',
      action: 'shop',
      lines: ['这里是道具店——要看看货架吗？'],
    },
    {
      kind: 'npc',
      x: 11,
      y: 8,
      sprite: 'nurse',
      name: '护士',
      lines: ['宝可梦受伤了就要及时治疗哦。', '全队恢复一次 10 积分，全员满血的话不收费。'],
      action: 'heal',
      facing: 'left',
    },
    {
      kind: 'npc',
      x: 20,
      y: 8,
      sprite: 'clerk',
      name: '店员',
      lines: ['精灵球、伤药、进化石、王冠……道具店应有尽有！'],
      action: 'shop',
      facing: 'right',
    },
    {
      kind: 'npc',
      x: 14,
      y: 14,
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
      x: 17,
      y: 19,
      sprite: 'kid',
      name: '镇上的孩子',
      lines: [
        '听说特殊的洞窟要用钥匙才能进去，钥匙在道具店有卖！',
        '我没钥匙的时候，门口的告示牌会写清楚要哪一把。',
      ],
      facing: 'left',
    },
    {
      // 妈妈（西侧民居路旁，面朝南：从 (9,19) 按空格搭话）：
      // 一次性赠送跑鞋（POST /users/me/running-shoes，幂等；已有则只说关心的话）。
      kind: 'npc',
      x: 9,
      y: 18,
      sprite: 'mom',
      name: '妈妈',
      facing: 'down',
      action: 'talk',
      event: 'running-shoes',
      lines: ['出门啦？等一下，先把跑鞋穿上——按住 Shift 就能跑起来。'],
    },
    {
      kind: 'door',
      x: 6,
      y: 17,
      building: 'house',
      label: '民居',
      action: 'info',
      lines: ['门锁着——主人在宝可梦中心当班，晚点再来吧。'],
    },
    {
      kind: 'door',
      x: 24,
      y: 17,
      building: 'house',
      label: '民居',
      action: 'info',
      lines: ['屋里传来电视的声音："今日天气：晴，101 号道路适合散步。"'],
    },
    { kind: 'sign', x: 14, y: 2 },
    { kind: 'sign', x: 9, y: 7, lines: ['宝可梦中心：全队 HP 恢复，每次 10 积分（全员满血不收费）。'] },
    { kind: 'sign', x: 22, y: 7, lines: ['道具店：精灵球 50 / 超级球 150 / 高级球 400 / 伤药 50 / 进化石 800。'] },
    { kind: 'sign', x: 7, y: 13, lines: ['西侧庭园是镇上的取水处。北面是宝可梦中心，向南走可以回家。'] },
  ],
};
