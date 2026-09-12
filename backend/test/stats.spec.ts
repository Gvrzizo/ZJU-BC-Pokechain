import {
  applyTrainingEvs,
  computeStats,
  emptyEvs,
  EV_MAX_PER_STAT,
  EV_MAX_TOTAL,
  evTotal,
  natureMultiplier,
  normalizeEvs,
  offenseStatOf,
  StatBlock,
} from '../src/game-data/stats';
import { NATURES } from '../src/game-data/natures.data';
import { SPECIES } from '../src/game-data/species.data';

const IV31: StatBlock = { hp: 31, atk: 31, def: 31, spatk: 31, spdef: 31, speed: 31 };
const NO_EVS = emptyEvs();

/** 官方第三世代种族值（Bulbapedia），测试用固定基准值，不随 game-data 平衡调整漂移。 */
const PIKACHU_BASE: StatBlock = { hp: 35, atk: 55, def: 40, spatk: 50, spdef: 50, speed: 90 };
const CHARIZARD_BASE: StatBlock = { hp: 78, atk: 84, def: 78, spatk: 109, spdef: 85, speed: 100 };
const GENGAR_BASE: StatBlock = { hp: 60, atk: 65, def: 60, spatk: 130, spdef: 75, speed: 110 };

/**
 * 第三世代官方公式（Bulbapedia "Stat"/"Nature"，2026-09 核实）：
 *   HP       = floor((2*Base + IV + floor(EV/4)) * Level / 100) + Level + 10
 *   其他五项 = floor( ( floor((2*Base + IV + floor(EV/4)) * Level / 100) + 5 ) * 性格 )
 */
describe('computeStats（官方能力值公式）', () => {
  it('黄金值：50 级皮卡丘 31IV/0EV/无修正性格（手算核对）', () => {
    // 2*Base+IV：hp 101 / atk 141 / def 111 / spatk 131 / spdef 131 / speed 211
    // 50 级：floor(x/2)+5（HP 再 +60）
    expect(computeStats(PIKACHU_BASE, IV31, NO_EVS, 50, 'hardy')).toEqual({
      hp: 110,
      atk: 75,
      def: 60,
      spatk: 70,
      spdef: 70,
      speed: 110,
    });
  });

  it('黄金值：100 级 31IV/0EV 无修正性格 = 2×种族值 + 36（HP +46）', () => {
    expect(computeStats(PIKACHU_BASE, IV31, NO_EVS, 100, 'hardy')).toEqual({
      hp: 211,
      atk: 146,
      def: 116,
      spatk: 136,
      spdef: 136,
      speed: 216,
    });
  });

  it('黄金值：Bulbapedia Garchomp 示例（78 级 / 真实 IV / 真实 EV / Adamant 性格）', () => {
    // 官方示例：Base 108/130/95/80/85/102，IV 24/12/30/16/23/5，
    // EV 74/190/91/48/84/23（合计 510），Adamant（+攻击 -特攻）
    // => HP 289、攻击 278、防御 193、特攻 135、特防 171、速度 171
    const base = { hp: 108, atk: 130, def: 95, spatk: 80, spdef: 85, speed: 102 };
    const ivs = { hp: 24, atk: 12, def: 30, spatk: 16, spdef: 23, speed: 5 };
    const evs = { hp: 74, atk: 190, def: 91, spatk: 48, spdef: 84, speed: 23 };
    expect(computeStats(base, ivs, evs, 78, 'adamant')).toEqual({
      hp: 289,
      atk: 278,
      def: 193,
      spatk: 135,
      spdef: 171,
      speed: 171,
    });
  });

  it('性格修正 ±10%：100 级喷火龙 Adamant（+攻击 -特攻）与 Modest（+特攻 -攻击）', () => {
    const evs = { ...NO_EVS, atk: 252, spatk: 252 };
    // 2*Base+IV+EV/4：攻击 262 → floor(262)+5=267，特攻 312 → 317
    // Adamant「攻击 ×1.1 / 特攻 ×0.9」= 293 / 285；Modest 倒置 = 240 / 348
    const adamant = computeStats(CHARIZARD_BASE, IV31, evs, 100, 'adamant');
    const modest = computeStats(CHARIZARD_BASE, IV31, evs, 100, 'modest');
    expect(adamant.atk).toBe(293);
    expect(adamant.spatk).toBe(285);
    expect(modest.atk).toBe(240);
    expect(modest.spatk).toBe(348);
    // 无修正性格即未乘系数：267 / 317
    expect(computeStats(CHARIZARD_BASE, IV31, evs, 100, 'hardy')).toMatchObject({ atk: 267, spatk: 317 });
  });

  it('无修正性格（hardy/docile/serious/bashful/quirky）不影响任何一项', () => {
    const neutral = computeStats(PIKACHU_BASE, IV31, NO_EVS, 50, 'hardy');
    for (const nature of ['hardy', 'docile', 'serious', 'bashful', 'quirky']) {
      expect(computeStats(PIKACHU_BASE, IV31, NO_EVS, 50, nature)).toEqual(neutral);
    }
    expect(natureMultiplier('hardy', 'atk')).toBe(1);
    expect(natureMultiplier('adamant', 'atk')).toBe(1.1);
    expect(natureMultiplier('adamant', 'spatk')).toBe(0.9);
  });

  it('EV 每 4 点加 1：floor(EV/4) 取整（7 EV 与 4 EV 等价，12 EV 才多 1 点）', () => {
    const ev = (hp: number) => ({ ...NO_EVS, hp });
    expect(computeStats(PIKACHU_BASE, IV31, ev(4), 50, 'hardy').hp).toBe(111);
    expect(computeStats(PIKACHU_BASE, IV31, ev(7), 50, 'hardy').hp).toBe(111);
    expect(computeStats(PIKACHU_BASE, IV31, ev(8), 50, 'hardy').hp).toBe(111);
    expect(computeStats(PIKACHU_BASE, IV31, ev(12), 50, 'hardy').hp).toBe(112);
    // 等级 100 时单项满 EV(255/4=63) 恰好 +63 点（官方上限）
    const maxed = computeStats(PIKACHU_BASE, IV31, { ...NO_EVS, atk: EV_MAX_PER_STAT }, 100, 'hardy');
    const bare = computeStats(PIKACHU_BASE, IV31, NO_EVS, 100, 'hardy');
    expect(maxed.atk - bare.atk).toBe(63);
  });

  it('25 种性格修正表覆盖且自洽（有利 1.1 / 不利 0.9 / 无修正 1.0）', () => {
    expect(NATURES).toHaveLength(25);
    for (const nature of NATURES) {
      const multipliers = (['atk', 'def', 'spatk', 'spdef', 'speed'] as const).map((s) =>
        natureMultiplier(nature, s),
      );
      const boosted = multipliers.filter((m) => m === 1.1).length;
      const hindered = multipliers.filter((m) => m === 0.9).length;
      expect([nature, boosted, hindered]).toEqual([
        nature,
        multipliers.every((m) => m === 1) ? 0 : 1,
        multipliers.every((m) => m === 1) ? 0 : 1,
      ]);
    }
    // 代表性性格交错核对（Bulbapedia Nature 表）
    expect(natureMultiplier('lonely', 'atk')).toBe(1.1);
    expect(natureMultiplier('lonely', 'def')).toBe(0.9);
    expect(natureMultiplier('brave', 'speed')).toBe(0.9);
    expect(natureMultiplier('timid', 'speed')).toBe(1.1);
    expect(natureMultiplier('timid', 'atk')).toBe(0.9);
    expect(natureMultiplier('calm', 'spdef')).toBe(1.1);
    expect(natureMultiplier('calm', 'atk')).toBe(0.9);
    expect(natureMultiplier('jolly', 'speed')).toBe(1.1);
    expect(natureMultiplier('jolly', 'spatk')).toBe(0.9);
    expect(natureMultiplier('modest', 'spatk')).toBe(1.1);
    expect(natureMultiplier('naive', 'spdef')).toBe(0.9);
    expect(natureMultiplier('careful', 'spatk')).toBe(0.9);
    expect(natureMultiplier('sassy', 'speed')).toBe(0.9);
    expect(natureMultiplier('lax', 'spdef')).toBe(0.9);
    expect(natureMultiplier('impish', 'spatk')).toBe(0.9);
    expect(natureMultiplier('rash', 'spdef')).toBe(0.9);
    expect(natureMultiplier('mild', 'def')).toBe(0.9);
    expect(natureMultiplier('gentle', 'def')).toBe(0.9);
    expect(natureMultiplier('hasty', 'def')).toBe(0.9);
    expect(natureMultiplier('bold', 'atk')).toBe(0.9);
    expect(natureMultiplier('relaxed', 'speed')).toBe(0.9);
    expect(natureMultiplier('quiet', 'speed')).toBe(0.9);
    expect(natureMultiplier('naughty', 'spdef')).toBe(0.9);
    // 未知性格按无修正处理
    expect(natureMultiplier('not-a-nature', 'atk')).toBe(1);
  });

  it('HP 与等级：1 级 0IV 最低 11 点，HP 不受性格影响（公式无性格乘子）', () => {
    expect(computeStats(PIKACHU_BASE, emptyEvs(), NO_EVS, 1, 'hardy').hp).toBe(11);
    expect(computeStats(PIKACHU_BASE, IV31, NO_EVS, 100, 'adamant').hp).toBe(
      computeStats(PIKACHU_BASE, IV31, NO_EVS, 100, 'modest').hp,
    );
  });

  it('全表冒烟：所有在售 species 的能力值均为正整数（积分/伤害公式依赖）', () => {
    for (const species of Object.values(SPECIES)) {
      const stats = computeStats(species.base, IV31, NO_EVS, 50, 'hardy');
      for (const key of ['hp', 'atk', 'def', 'spatk', 'spdef', 'speed'] as const) {
        expect([species.name, key, stats[key] > 0]).toEqual([species.name, key, true]);
      }
    }
  });
});

describe('normalizeEvs / applyTrainingEvs（EV 规则）', () => {
  it('normalizeEvs：缺失字段按 0，超上限夹取，总和超 510 截断', () => {
    expect(normalizeEvs(null)).toEqual(NO_EVS);
    expect(normalizeEvs({ hp: 8 })).toMatchObject({ hp: 8, atk: 0, speed: 0 });
    expect(normalizeEvs({ ...NO_EVS, hp: 300 }).hp).toBe(EV_MAX_PER_STAT);
    expect(normalizeEvs({ ...NO_EVS, hp: -5, atk: 4.5 }).atk).toBe(0);
    const capped = normalizeEvs({ hp: 255, atk: 255, def: 255, spatk: 0, spdef: 0, speed: 0 });
    expect(evTotal(capped)).toBe(EV_MAX_TOTAL);
    expect(capped.hp).toBe(255);
    expect(capped.atk).toBe(255);
    expect(capped.def).toBe(0);
  });

  it('applyTrainingEvs：主攻项优先、逐项填满、单项 255 / 总和 510 封顶', () => {
    const offense = offenseStatOf(PIKACHU_BASE); // 皮卡丘物攻 55 > 特攻 50 => atk
    expect(offense).toBe('atk');

    const first = applyTrainingEvs(NO_EVS, offense, 40); // 10 点训练 = 40 EV
    expect(first.atk).toBe(40);
    expect(evTotal(first)).toBe(40);

    // 单项填满后溢出到下一优先级（速度）
    const overflow = applyTrainingEvs({ ...NO_EVS, atk: 252 }, 'atk', 40);
    expect(overflow.atk).toBe(EV_MAX_PER_STAT);
    expect(overflow.speed).toBe(37);

    // 已满 510 时不再增加（服务层据此报 EV_MAXED）
    const full = { hp: 255, atk: 255, def: 0, spatk: 0, spdef: 0, speed: 0 };
    expect(applyTrainingEvs(full, 'atk', 40)).toEqual(full);

    // 非整数/非正收益不改变 EV
    expect(applyTrainingEvs(NO_EVS, 'atk', -4)).toEqual(NO_EVS);
    expect(applyTrainingEvs(NO_EVS, 'atk', 2.5)).toEqual(NO_EVS);
  });

  it('applyTrainingEvs：特攻型宝可梦（耿鬼）优先练特攻', () => {
    expect(offenseStatOf(GENGAR_BASE)).toBe('spatk');
    expect(applyTrainingEvs(NO_EVS, offenseStatOf(GENGAR_BASE), 4).spatk).toBe(4);
  });
});
