import {
  blob,
  building,
  border,
  createGrid,
  flowerCluster,
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
 * 未白镇（起始镇，32×24）：宝可梦中心（红顶 + 十字）+ 道具店 + 两栋民居 + 水塘，
 * 镇内没有野生宝可梦（`zoneId: 'town'` 安全区）。北出口通往 101 号道路。
 *
 * 布局按原作的小镇习惯来：中轴主街 + 两条横街，两间店铺面南对着主街（门前 1 格门垫），
 * 民居在南半区对称分布，西南角留一口圆润的水塘；四周 2 格厚的树墙围死，只在北面开口。
 */
const W = 32;
const H = 24;

function build(): number[][] {
  const rng = makeRng(20260912);
  const g = createGrid(W, H, T.grass);
  border(g, T.tree, 2);

  // 道路：中轴主街（2 格宽）+ 南北两条横街
  road(g, [{ x: 15, y: 21 }, { x: 15, y: 2 }], T.path, 2);
  hLine(g, 8, 23, 12, T.path);
  hLine(g, 8, 23, 13, T.path);
  hLine(g, 7, 24, 18, T.path);
  // 店铺门前的小径（门垫 → 横街）
  vLine(g, 10, 7, 11, T.path);
  vLine(g, 21, 7, 11, T.path);

  // 北面开口（去 101 号道路）
  openEdge(g, 'north', 15, 2, T.path);
  setTile(g, 15, 1, T.path);
  setTile(g, 16, 1, T.path);

  // 建筑：宝可梦中心 / 道具店（5 宽、两行屋顶）；两栋民居（4 宽）在南半区面对面
  building(g, 8, 4, 5, 'roof', 'wall', 2);
  building(g, 19, 4, 5, 'roof', 'wall', 2);
  building(g, 5, 16, 4, 'roof', 'wall', 1);
  building(g, 23, 16, 4, 'roof', 'wall', 1);

  // 西南角的水塘：圆润闭合，岸边留一圈土路色浅滩
  pond(g, 7, 20, 3.2, 1.8, rng, { tile: 'sand' });

  // 绿化：成团的树丛 + 花簇 + 零星石头
  blob(g, T.tree, 27, 9, 2.4, 2.2, rng);
  blob(g, T.tree, 4, 9, 2, 2.2, rng);
  blob(g, T.tree, 28, 14, 1.8, 1.6, rng);
  setTile(g, 2, 4, T.tree);
  setTile(g, 29, 4, T.tree);
  setTile(g, 3, 14, T.tree);
  setTile(g, 28, 21, T.tree);
  flowerCluster(g, 14, 4, rng, 3);
  flowerCluster(g, 20, 9, rng, 4);
  flowerCluster(g, 4, 19, rng, 3);
  flowerCluster(g, 26, 12, rng, 4);
  flowerCluster(g, 12, 20, rng, 3);
  setTile(g, 24, 20, T.rock);
  setTile(g, 11, 15, T.rock);
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
      // 妈妈（西侧民居门口，面朝北：从 (6,19) 按空格搭话）：
      // 一次性赠送跑鞋（POST /users/me/running-shoes，幂等；已有则只说关心的话）。
      kind: 'npc',
      x: 6,
      y: 18,
      sprite: 'mom',
      name: '妈妈',
      facing: 'up',
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
    { kind: 'sign', x: 12, y: 19, lines: ['南边水塘是镇上的取水处，别把宝可梦放进去。'] },
  ],
};
