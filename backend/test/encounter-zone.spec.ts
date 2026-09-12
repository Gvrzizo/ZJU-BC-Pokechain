import { DeriveStream } from '../src/common/utils/crypto.util';
import {
  COMMON_CATCH_RATE,
  COMMON_WEIGHT,
  DEFAULT_ZONE_ID,
  RARE_BST,
  RARE_WEIGHT,
  UNCOMMON_CATCH_RATE,
  ZONES,
  ZONE_IDS,
  baseStatTotal,
  evolutionStage,
  getZone,
  pickZoneSpecies,
  rarityTier,
  rarityWeight,
  resolveZone,
  zonePool,
  zonePoolWeight,
} from '../src/game-data/encounter.data';
import { WILD_TABLE, getSpecies } from '../src/game-data/species.data';
import { LURE_TIERS, deriveWildLevel } from '../src/pokemon/capture-derive';
import { CaptureService } from '../src/pokemon/capture.service';
import { makeChain, makeRedis, registerPlayers, seedPokemon, userIdentity } from './helpers';

const ash = userIdentity('ash');
const SERVER_SEED = 'aa'.repeat(32);

describe('区域表（docs/backend-api.md §2「区域等级带」）', () => {
  it('三个区域：id/等级带/阶段门槛固定且互不重叠', () => {
    expect(ZONES.map((z) => z.id)).toEqual(['south', 'mid', 'north']);
    expect(ZONE_IDS).toEqual(['south', 'mid', 'north']);
    expect(ZONES.map((z) => [z.minLevel, z.maxLevel, z.maxStage])).toEqual([
      [2, 6, 0],
      [8, 16, 1],
      [17, 28, 2],
    ]);
    for (const zone of ZONES) {
      expect(zone.name.length).toBeGreaterThan(0);
      expect(zone.minLevel).toBeLessThan(zone.maxLevel);
    }
    // 等级带严格递增且不重叠（南部 < 中部 < 北部）
    for (let i = 1; i < ZONES.length; i++) {
      expect(ZONES[i].minLevel).toBeGreaterThan(ZONES[i - 1].maxLevel);
    }
  });

  it('resolveZone：缺省/空串回落南部，非法 id 返回 undefined（调用方抛 INVALID_ZONE）', () => {
    expect(resolveZone(undefined)?.id).toBe(DEFAULT_ZONE_ID);
    expect(resolveZone(null)?.id).toBe('south');
    expect(resolveZone('')?.id).toBe('south');
    expect(resolveZone('north')?.id).toBe('north');
    expect(resolveZone('south-2')).toBeUndefined();
    expect(resolveZone('east')).toBeUndefined();
  });
});

describe('进化阶段 stage（沿 EVOLUTIONS 回溯）', () => {
  it('基础形态 0 / 一段进化 1 / 二段进化 2', () => {
    expect(evolutionStage(1)).toBe(0); // 妙蛙种子
    expect(evolutionStage(2)).toBe(1); // 妙蛙草
    expect(evolutionStage(3)).toBe(2); // 妙蛙花
    expect(evolutionStage(133)).toBe(0); // 伊布
    expect(evolutionStage(134)).toBe(1); // 水伊布（石头进化同样算一段）
    expect(evolutionStage(172)).toBe(0); // 皮丘（无前置）
    expect(evolutionStage(25)).toBe(1); // 皮卡丘（皮丘的进化型）
    expect(evolutionStage(26)).toBe(2); // 雷丘
    expect(evolutionStage(143)).toBe(0); // 卡比兽（无进化）
  });

  it('野生池内所有种族 stage ≤ 2（区域门槛的分档基础）', () => {
    for (const species of WILD_TABLE) {
      const stage = evolutionStage(species.id);
      expect([species.id, stage >= 0 && stage <= 2]).toEqual([species.id, true]);
    }
  });
});

describe('稀有度权重（按官方捕获率分档 + 高种族值降权）', () => {
  it('档位边界：≥200 常见 / 80–199 少见 / <80 稀有', () => {
    expect(rarityTier(COMMON_CATCH_RATE)).toBe('common');
    expect(rarityTier(255)).toBe('common');
    expect(rarityTier(COMMON_CATCH_RATE - 1)).toBe('uncommon');
    expect(rarityTier(UNCOMMON_CATCH_RATE)).toBe('uncommon');
    expect(rarityTier(UNCOMMON_CATCH_RATE - 1)).toBe('rare');
    expect(rarityTier(3)).toBe('rare');
  });

  it('权重 = 60 / 30 / 10，种族值总量 ≥500 再 ×0.3（18/9/3）', () => {
    const pidgey = getSpecies(16)!; // catchRate 255、BST 251
    expect(pidgey.catchRate).toBe(255);
    expect(baseStatTotal(pidgey)).toBeLessThan(RARE_BST);
    expect(rarityWeight(pidgey)).toBe(COMMON_WEIGHT);

    const snorlax = getSpecies(143)!; // catchRate 25、BST 540 → 稀有 + ×0.3
    expect(snorlax.catchRate).toBeLessThan(UNCOMMON_CATCH_RATE);
    expect(baseStatTotal(snorlax)).toBeGreaterThanOrEqual(RARE_BST);
    expect(rarityWeight(snorlax)).toBe(RARE_WEIGHT * 0.3);

    const venusaur = getSpecies(3)!; // catchRate 45、BST 525 → 稀有 + ×0.3
    expect(rarityWeight(venusaur)).toBe(RARE_WEIGHT * 0.3);
    // 常见未进化型 vs 稀有准神：出率差 20 倍
    expect(rarityWeight(pidgey) / rarityWeight(venusaur)).toBe(20);
  });

  it('每个区域的池权重都是有限正数、累计上界严格递增', () => {
    for (const zone of ZONES) {
      const pool = zonePool(zone);
      expect(pool.length).toBeGreaterThan(50);
      let previous = 0;
      for (const entry of pool) {
        expect(entry.weight).toBeGreaterThan(0);
        expect(Number.isFinite(entry.weight)).toBe(true);
        expect(entry.species.inWild).toBe(true);
        expect(entry.cumulative).toBeGreaterThan(previous);
        previous = entry.cumulative;
      }
      expect(zonePoolWeight(zone)).toBe(previous);
    }
  });
});

describe('分区野生池门槛（stage ≤ zone.maxStage）', () => {
  it('南部只出未进化型；中部可出一段；北部可出二段', () => {
    const south = zonePool('south');
    expect(south.every((e) => e.stage === 0)).toBe(true);
    expect(south.some((e) => e.species.id === 16)).toBe(true); // 波波
    expect(south.some((e) => e.species.id === 2)).toBe(false); // 妙蛙草不在南部

    const mid = zonePool('mid');
    expect(mid.every((e) => e.stage <= 1)).toBe(true);
    expect(mid.some((e) => e.stage === 1)).toBe(true);
    expect(mid.some((e) => e.species.id === 3)).toBe(false); // 妙蛙花（二段）不在中部

    const north = zonePool('north');
    expect(north.every((e) => e.stage <= 2)).toBe(true);
    expect(north.some((e) => e.species.id === 3)).toBe(true); // 妙蛙花
    expect(north.some((e) => e.species.id === 6)).toBe(true); // 喷火龙
    // 池是野生池的子集，且北部包含全部野生种族（无 stage>2）
    const wildIds = new Set(WILD_TABLE.map((s) => s.id));
    expect(north.every((e) => wildIds.has(e.species.id))).toBe(true);
    expect(north.length).toBe(WILD_TABLE.length);

    // 门槛单调：南部 ⊂ 中部 ⊂ 北部
    const ids = (zone: 'south' | 'mid' | 'north') => new Set(zonePool(zone).map((e) => e.species.id));
    const [s, m, n] = [ids('south'), ids('mid'), ids('north')];
    expect([...s].every((id) => m.has(id))).toBe(true);
    expect([...m].every((id) => n.has(id))).toBe(true);
  });

  it('加权抽样的频率与权重成正比（均匀扫 10000 个掷点）', () => {
    for (const zone of ZONES) {
      const pool = zonePool(zone);
      const total = zonePoolWeight(zone);
      const counts = new Map<number, number>();
      const samples = 10_000;
      for (let i = 0; i < samples; i++) {
        const species = pickZoneSpecies(i / samples, zone);
        counts.set(species.id, (counts.get(species.id) ?? 0) + 1);
      }
      // 每个种族占据 [0,1) 上长度 = weight/total 的区间，1/N 采样误差 < 0.001
      for (const entry of pool) {
        const expected = entry.weight / total;
        const actual = (counts.get(entry.species.id) ?? 0) / samples;
        expect([zone.id, entry.species.id, Math.abs(actual - expected) < 0.001]).toEqual([
          zone.id,
          entry.species.id,
          true,
        ]);
      }
      // 常见种（60）出现次数远多于稀有准神（3）
      const pidgey = counts.get(16) ?? 0;
      const venusaur = counts.get(3) ?? 0;
      expect(pidgey).toBeGreaterThan(venusaur * 5);
    }
  });

  it('越界掷点也落在池内（0 / 1 / 1.5 / 负数）', () => {
    for (const roll of [0, 1, 1.5, -1]) {
      for (const zone of ZONES) {
        const species = pickZoneSpecies(roll, zone);
        expect(zonePool(zone).some((e) => e.species.id === species.id)).toBe(true);
      }
    }
  });
});

describe('带内等级推导（n=1 槽）', () => {
  it('level = zone.minLevel + floor(rand × 带宽)，与队伍无关', () => {
    const seen = new Map<string, Set<number>>();
    for (let i = 0; i < 500; i++) {
      const stream = new DeriveStream(SERVER_SEED, i.toString(16).padStart(16, '0'), 'ev_zone_level');
      for (const zone of ZONES) {
        const level = deriveWildLevel(stream, zone);
        expect(level).toBeGreaterThanOrEqual(zone.minLevel);
        expect(level).toBeLessThanOrEqual(zone.maxLevel);
        const key = zone.id;
        if (!seen.has(key)) seen.set(key, new Set());
        seen.get(key)!.add(level);
      }
    }
    // 500 次抽样下每个区域都覆盖到带内所有等级（均匀性粗检）
    for (const zone of ZONES) {
      expect([zone.id, seen.get(zone.id)!.size]).toEqual([zone.id, zone.maxLevel - zone.minLevel + 1]);
    }
  });

  it('诱饵带内 +2/+5 且封顶 zone.maxLevel', () => {
    expect(LURE_TIERS[0]).toMatchObject({ cost: 0, levelBonus: 0, shinyMultiplier: 1 });
    expect(LURE_TIERS[1]).toMatchObject({ cost: 50, levelBonus: 2, shinyMultiplier: 1 });
    expect(LURE_TIERS[2]).toMatchObject({ cost: 200, levelBonus: 5, shinyMultiplier: 4 });

    for (const zone of ZONES) {
      for (let i = 0; i < 200; i++) {
        const stream = new DeriveStream(SERVER_SEED, i.toString(16).padStart(16, '0'), 'ev_zone_lure');
        const base = deriveWildLevel(stream, zone);
        const t1 = deriveWildLevel(stream, zone, LURE_TIERS[1].levelBonus);
        const t2 = deriveWildLevel(stream, zone, LURE_TIERS[2].levelBonus);
        expect(base).toBeGreaterThanOrEqual(zone.minLevel);
        expect(t1).toBe(Math.min(zone.maxLevel, base + 2));
        expect(t2).toBe(Math.min(zone.maxLevel, base + 5));
        expect(t2).toBeLessThanOrEqual(zone.maxLevel);
      }
      // 没有等级从带内溢出：tier 2 的上界就是区域上界
      expect(deriveWildLevel(new DeriveStream(SERVER_SEED, 'ff'.repeat(8), 'ev_cap'), zone, 5)).toBeLessThanOrEqual(
        zone.maxLevel,
      );
    }
  });

  it('抽样分布覆盖带内全部等级（n=1 均匀）', () => {
    const levels = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const stream = new DeriveStream(SERVER_SEED, i.toString(16).padStart(16, '0'), 'ev_band_cover');
      levels.add(deriveWildLevel(stream, getZone('mid')!));
    }
    expect([...levels].sort((a, b) => a - b)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });
});

describe('CaptureService.encounter：区域入参 + 与队伍等级脱钩', () => {
  const build = () => {
    const { chain, contract } = makeChain();
    const redis = makeRedis();
    return { chain, contract, redis, capture: new CaptureService(chain, contract, redis) };
  };

  it('区域决定野生池与等级带：south 只出 stage 0 且 Lv2-6，north 可出二段进化型', async () => {
    const { contract, capture } = build();
    await registerPlayers(contract, 'ash');

    // 200 次真实遇敌（每次一条独立 HMAC 派生流）
    const southSpecies = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const enc = await capture.encounter(ash, undefined, 0, 'south');
      expect(enc.wild.level).toBeGreaterThanOrEqual(2);
      expect(enc.wild.level).toBeLessThanOrEqual(6);
      expect(evolutionStage(enc.wild.speciesId)).toBe(0);
      southSpecies.add(enc.wild.speciesId);
    }
    // 加权池确实被用到：200 次里至少出现 5 个不同种族
    expect(southSpecies.size).toBeGreaterThanOrEqual(5);

    const northSpecies = new Set<number>();
    const northStages = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const enc = await capture.encounter(ash, undefined, 0, 'north');
      expect(enc.wild.level).toBeGreaterThanOrEqual(17);
      expect(enc.wild.level).toBeLessThanOrEqual(28);
      const stage = evolutionStage(enc.wild.speciesId);
      expect(stage).toBeLessThanOrEqual(2);
      northSpecies.add(enc.wild.speciesId);
      northStages.add(stage);
    }
    // 北部能遇到（含）进化型：200 次里同时出现基础形态与至少一段进化型
    expect(northStages.has(0)).toBe(true);
    expect([...northStages].some((s) => s >= 1)).toBe(true);
  });

  it('回归：队伍 Lv50/Lv80 在南部仍只遇 Lv2-6（抓高级怪不再滚雪球）', async () => {
    const { chain, contract, capture } = build();
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', { id: 'p_a', level: 50 });
    await seedPokemon(chain, 'ash', { id: 'p_b', level: 80, speciesId: 149 });

    for (let i = 0; i < 30; i++) {
      const enc = await capture.encounter(ash, undefined, 0, 'south');
      expect(enc.wild.level).toBeLessThanOrEqual(6);
      expect(evolutionStage(enc.wild.speciesId)).toBe(0);
    }
    const mid = await capture.encounter(ash, undefined, 0, 'mid');
    expect(mid.wild.level).toBeLessThanOrEqual(16);
  });

  it('缺省与非法 zoneId：缺省南部、非法 INVALID_ZONE', async () => {
    const { contract, capture } = build();
    await registerPlayers(contract, 'ash');
    const enc = await capture.encounter(ash);
    expect(enc.zone.id).toBe('south');
    await expect(capture.encounter(ash, undefined, 0, 'nope')).rejects.toThrow(/INVALID_ZONE/);
  });
});
