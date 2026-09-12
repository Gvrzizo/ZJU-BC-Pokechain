import { DeriveStream } from '../src/common/utils/crypto.util';
import {
  COMMON_CATCH_RATE,
  COMMON_WEIGHT,
  DEFAULT_ZONE_ID,
  LEGENDARY_WEIGHT,
  LEGENDARY_ZONE_IDS,
  NORMAL_ZONE_IDS,
  RARE_BST,
  RARE_WEIGHT,
  UNCOMMON_CATCH_RATE,
  ZONE_ALIASES,
  ZONES,
  ZONE_IDS,
  baseStatTotal,
  canonicalZoneId,
  evolutionStage,
  getZone,
  pickZoneSpecies,
  rarityTier,
  rarityWeight,
  resolveZone,
  speciesTypes,
  zonePool,
  zonePoolWeight,
  zoneSpeciesIds,
  zoneTable,
  zonesForSpecies,
} from '../src/game-data/encounter.data';
import { LEGENDARY_WILD_TABLE, WILD_TABLE, getSpecies } from '../src/game-data/species.data';
import { LURE_TIERS, deriveWildLevel } from '../src/pokemon/capture-derive';
import { CaptureService } from '../src/pokemon/capture.service';
import { makeChain, makePokemonService, makeRedis, registerPlayers, seedPokemon, userIdentity } from './helpers';

const ash = userIdentity('ash');
const SERVER_SEED = 'aa'.repeat(32);

/** 普通区栖息地属性并集（覆盖缺口断言用） */
const NORMAL_HABITAT_TYPES = [...new Set(ZONES.filter((z) => !z.legendary).flatMap((z) => z.habitats))];

/** docs/backend-api.md §2 公示的区域表（id → 等级带 / 门槛 / 池规模） */
const ZONE_SPEC: Record<string, [number, number, number, number]> = {
  'route-grass': [2, 6, 0, 74],
  forest: [4, 10, 0, 42],
  'route-mid': [8, 16, 1, 78],
  cave: [12, 20, 1, 73],
  coast: [15, 25, 1, 59],
  'route-north': [17, 28, 2, 47],
  volcano: [20, 30, 2, 58],
  'sky-pillar': [45, 50, 0, 1],
  seafloor: [45, 50, 0, 1],
  magma: [45, 50, 0, 1],
  ruins: [40, 40, 0, 3],
  'southern-island': [40, 40, 0, 2],
  'birth-island': [45, 45, 0, 1],
};

describe('区域表（docs/backend-api.md §2「区域与栖息地野生池」）', () => {
  it('普通区 7 个 + 传说区 6 个：id/等级带/阶段门槛固定', () => {
    expect(ZONES.map((z) => z.id)).toEqual([
      'route-grass',
      'forest',
      'route-mid',
      'cave',
      'coast',
      'route-north',
      'volcano',
      'sky-pillar',
      'seafloor',
      'magma',
      'ruins',
      'southern-island',
      'birth-island',
    ]);
    expect(ZONE_IDS).toHaveLength(13);
    expect(NORMAL_ZONE_IDS).toEqual(['route-grass', 'forest', 'route-mid', 'cave', 'coast', 'route-north', 'volcano']);
    expect(LEGENDARY_ZONE_IDS).toEqual(['sky-pillar', 'seafloor', 'magma', 'ruins', 'southern-island', 'birth-island']);

    for (const zone of ZONES) {
      const [minLevel, maxLevel, maxStage, poolSize] = ZONE_SPEC[zone.id];
      expect([zone.id, zone.minLevel, zone.maxLevel, zone.maxStage]).toEqual([zone.id, minLevel, maxLevel, maxStage]);
      expect([zone.id, zone.name.length > 0]).toEqual([zone.id, true]);
      expect([zone.id, zone.minLevel]).toEqual([zone.id, Math.min(zone.minLevel, zone.maxLevel)]);
      expect([zone.id, zonePool(zone).length]).toEqual([zone.id, poolSize]);
    }
    // 普通区门槛单调（越靠后的区域允许越高的进化阶段），且等级带逐段上移
    const stageLadder = NORMAL_ZONE_IDS.map((id) => getZone(id)!.maxStage);
    expect(stageLadder).toEqual([...stageLadder].sort((a, b) => a - b));
    const minLadder = NORMAL_ZONE_IDS.map((id) => getZone(id)!.minLevel);
    expect(minLadder).toEqual([...minLadder].sort((a, b) => a - b));
  });

  it('传说区：等级带窄（≤6）且高档、带钥匙、栖息地为空；普通区无钥匙', () => {
    for (const zone of ZONES) {
      if (zone.legendary) {
        expect([zone.id, zone.keyTypeId !== undefined]).toEqual([zone.id, true]);
        expect([zone.id, zone.habitats.length]).toEqual([zone.id, 0]);
        expect([zone.id, zone.minLevel >= 40]).toEqual([zone.id, true]);
        expect([zone.id, zone.maxLevel - zone.minLevel <= 5]).toEqual([zone.id, true]);
        expect([zone.id, zone.poolSpeciesIds!.length > 0]).toEqual([zone.id, true]);
      } else {
        expect([zone.id, zone.keyTypeId]).toEqual([zone.id, undefined]);
        expect([zone.id, zone.legendary]).not.toEqual([zone.id, true]);
        expect([zone.id, zone.habitats.length > 0]).toEqual([zone.id, true]);
      }
    }
  });

  it('resolveZone/canonicalZoneId：缺省回落草丛；别名 south/mid/north 归一；非法 id 返回 undefined', () => {
    expect(DEFAULT_ZONE_ID).toBe('route-grass');
    expect(resolveZone(undefined)?.id).toBe(DEFAULT_ZONE_ID);
    expect(resolveZone(null)?.id).toBe('route-grass');
    expect(resolveZone('')?.id).toBe('route-grass');
    expect(resolveZone('route-north')?.id).toBe('route-north');
    // 兼容别名（e2e-smoke / 旧前端仍按三区 id 传参）
    expect(ZONE_ALIASES).toEqual({ south: 'route-grass', mid: 'route-mid', north: 'route-north' });
    expect(canonicalZoneId('south')).toBe('route-grass');
    expect(canonicalZoneId('mid')).toBe('route-mid');
    expect(canonicalZoneId('north')).toBe('route-north');
    expect(resolveZone('south')?.id).toBe('route-grass');
    expect(resolveZone('mid')?.minLevel).toBe(8);
    expect(resolveZone('north')?.maxStage).toBe(2);
    // 别名不是独立区域：不在 ZONE_IDS 里，仅做输入归一
    expect(ZONE_IDS).not.toContain('south');
    // 非法
    expect(resolveZone('south-2')).toBeUndefined();
    expect(resolveZone('east')).toBeUndefined();
    expect(canonicalZoneId('sky-pillar ')).toBeUndefined();
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
    expect(evolutionStage(384)).toBe(0); // 烈空坐（无进化链）
  });

  it('普通区池内所有种族 stage ≤ 2（区域门槛的分档基础）', () => {
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

  it('每个区域的池都是有限正数、累计上界严格递增；权重 = rarityWeight（传说区 = 等权 1）', () => {
    for (const zone of ZONES) {
      const pool = zonePool(zone);
      expect([zone.id, pool.length > 0]).toEqual([zone.id, true]);
      let previous = 0;
      for (const entry of pool) {
        const expected = zone.legendary ? LEGENDARY_WEIGHT : rarityWeight(entry.species);
        expect([zone.id, entry.species.id, entry.weight]).toEqual([zone.id, entry.species.id, expected]);
        expect(Number.isFinite(entry.weight) && entry.weight > 0).toBe(true);
        expect(entry.cumulative).toBeGreaterThan(previous);
        previous = entry.cumulative;
      }
      expect(zonePoolWeight(zone)).toBe(previous);
    }
  });
});

describe('栖息地过滤（普通区池 = 门槛 + 属性）', () => {
  it('每区池的种族都来自普通野生池、stage ≤ 门槛、属性命中该区栖息地', () => {
    const wildIds = new Set(WILD_TABLE.map((s) => s.id));
    for (const zone of ZONES.filter((z) => !z.legendary)) {
      const pool = zonePool(zone);
      expect([zone.id, pool.length > 0]).toEqual([zone.id, true]);
      for (const entry of pool) {
        expect([zone.id, entry.species.id, wildIds.has(entry.species.id)]).toEqual([zone.id, entry.species.id, true]);
        expect([zone.id, entry.species.id, entry.stage <= zone.maxStage]).toEqual([zone.id, entry.species.id, true]);
        // 属性自洽 ⇒ 栖息地过滤没有退化成"空池兜底全池"
        expect([zone.id, entry.species.id, speciesTypes(entry.species).some((t) => zone.habitats.includes(t))]).toEqual([
          zone.id,
          entry.species.id,
          true,
        ]);
      }
    }
  });

  it('属性分配与文档一致：火→烟囱山、水→海滨、毒→森林/洞窟、格斗→丘陵/冠军之路', () => {
    // 水属性只在 coast（普通区里水属性栖息地只出现在海滨；二段进化的水系种族不进任何池，见下"覆盖缺口"）
    const waterIds = WILD_TABLE.filter((s) => s.type === 'water').map((s) => s.id);
    expect(waterIds.length).toBeGreaterThan(20);
    let coastWater = 0;
    for (const id of waterIds) {
      const zones = zonesForSpecies(id);
      expect([id, zones.length === 0 || (zones.length === 1 && zones[0] === 'coast')]).toEqual([id, true]);
      if (zones[0] === 'coast') coastWater += 1;
    }
    expect(coastWater).toBeGreaterThan(30);
    expect(zonesForSpecies(129)).toEqual(['coast']); // 鲤鱼王
    expect(zonesForSpecies(7)).toEqual(['coast']); // 杰尼龟

    // 代表性种族 → 出现区域（栖息地反查）
    expect(zonesForSpecies(1)).toEqual(['route-grass', 'forest']); // 妙蛙种子（草）
    expect(zonesForSpecies(4)).toEqual(['volcano']); // 小火龙（火，不进草丛）
    expect(zonesForSpecies(16)).toEqual(['route-grass', 'route-mid']); // 波波（一般）
    expect(zonesForSpecies(172)).toEqual(['route-grass']); // 皮丘（电）
    expect(zonesForSpecies(25)).toEqual([]); // 皮卡丘 stage 1 且电属性：只能进化得到
    expect(zonesForSpecies(74)).toEqual(['cave', 'volcano']); // 小拳石（岩）
    expect(zonesForSpecies(66)).toEqual(['route-mid', 'route-north']); // 腕力（格斗）
    expect(zonesForSpecies(41)).toEqual(['forest', 'cave']); // 超音蝠（毒）
    expect(zonesForSpecies(147)).toEqual(['route-north']); // 迷你龙（龙）
    expect(zonesForSpecies(374)).toEqual(['route-north']); // 铁哑铃（钢）
    expect(zonesForSpecies(26)).toEqual([]); // 雷丘（手调进化型）从不出现在野外

    // 2026-09 补全的四个属性：幽灵/冰 → 石之洞窟、妖精 → 橙华森林、超能 → 冠军之路
    expect(zonesForSpecies(92)).toEqual(['cave']); // 鬼斯（幽灵）
    expect(zonesForSpecies(220)).toEqual(['cave']); // 小山猪（冰）
    expect(zonesForSpecies(124)).toEqual(['cave']); // 迷唇姐（冰）
    expect(zonesForSpecies(173)).toEqual(['forest']); // 皮宝宝（妖精，stage 0）
    expect(zonesForSpecies(35)).toEqual([]); // 皮皮（妖精 stage 1）只能由皮宝宝进化
    expect(zonesForSpecies(63)).toEqual(['route-north']); // 凯西（超能）
    expect(zonesForSpecies(280)).toEqual(['route-north']); // 拉鲁拉丝（超能）
    expect(zonesForSpecies(65)).toEqual(['route-north']); // 胡地（超能 stage 2）

    // 反例：属性不在栖息地集合里的种族不进池
    expect(zonePool('route-grass').some((e) => e.species.id === 4)).toBe(false); // 火属性不进草丛
    expect(zonePool('coast').some((e) => e.species.id === 1)).toBe(false); // 草属性不进海滨
    expect(zonePool('forest').some((e) => e.species.id === 133)).toBe(false); // 一般属性不进森林
    expect(zonePool('route-north').some((e) => e.species.id === 4)).toBe(false); // 火属性不进冠军之路
    // 门槛仍在生效：皮卡丘（stage 1）不进只出未进化型的草丛
    expect(zonePool('route-grass').every((e) => e.stage === 0)).toBe(true);
    expect(zonePool('route-grass').some((e) => e.species.id === 172)).toBe(true);
  });

  it('18 属性全覆盖：每个野生种族的主属性都有栖息地，stage 0 的种族都能在某处遇到', () => {
    // 栖息地属性并集 = 18 属性全集
    expect([...NORMAL_HABITAT_TYPES].sort()).toEqual([
      'bug', 'dark', 'dragon', 'electric', 'fairy', 'fighting', 'fire', 'flying', 'ghost', 'grass',
      'ground', 'ice', 'normal', 'poison', 'psychic', 'rock', 'steel', 'water',
    ]);
    for (const species of WILD_TABLE) {
      expect([species.id, species.type, NORMAL_HABITAT_TYPES.includes(species.type)]).toEqual([species.id, species.type, true]);
    }
    // 基础形态（stage 0）必然在某处出现；无出现区域的只有进化型（stage ≥ 1）
    for (const species of WILD_TABLE) {
      const appears = zonesForSpecies(species.id).length > 0;
      expect([species.id, appears || evolutionStage(species.id) > 0]).toEqual([species.id, true]);
    }
    const orphans = WILD_TABLE.filter((s) => zonesForSpecies(s.id).length === 0);
    expect(orphans).toHaveLength(64);
    expect(orphans.every((s) => evolutionStage(s.id) > 0)).toBe(true);
  });

  it('传说种族不进任何普通区池（只经传说区出现）', () => {
    const legendaryIds = new Set(LEGENDARY_WILD_TABLE.map((s) => s.id));
    expect([...legendaryIds].sort((a, b) => a - b)).toEqual([377, 378, 379, 380, 381, 382, 383, 384, 386]);
    for (const zone of ZONES.filter((z) => !z.legendary)) {
      for (const entry of zonePool(zone)) {
        expect([zone.id, entry.species.id, legendaryIds.has(entry.species.id)]).toEqual([zone.id, entry.species.id, false]);
      }
    }
    // 传说种族只出现在自己的传说区
    expect(zonesForSpecies(384)).toEqual(['sky-pillar']);
    expect(zonesForSpecies(385)).toEqual([]); // 基拉祈仍未开放遭遇
  });
});

describe('传说区（pool 固定 / 等权 / 窄等级带）', () => {
  it('池 = poolSpeciesIds 的传说种族，与所需的钥匙 typeId 一一对应', () => {
    expect(zoneSpeciesIds('sky-pillar')).toEqual([384]); // 烈空坐
    expect(zoneSpeciesIds('seafloor')).toEqual([382]); // 盖欧卡
    expect(zoneSpeciesIds('magma')).toEqual([383]); // 固拉多
    expect(zoneSpeciesIds('ruins')).toEqual([377, 378, 379]); // 三神柱
    expect(zoneSpeciesIds('southern-island')).toEqual([380, 381]); // 拉帝亚斯 / 拉帝欧斯
    expect(zoneSpeciesIds('birth-island')).toEqual([386]); // 代欧奇希斯

    const keys: Record<string, string> = {
      'sky-pillar': 'sky-key',
      seafloor: 'ocean-key',
      magma: 'magma-key',
      ruins: 'ruins-key',
      'southern-island': 'island-key',
      'birth-island': 'birth-key',
    };
    for (const zone of ZONES.filter((z) => z.legendary)) {
      expect([zone.id, zone.keyTypeId]).toEqual([zone.id, keys[zone.id]]);
      for (const entry of zonePool(zone)) {
        expect([zone.id, entry.species.id, entry.species.legendary]).toEqual([zone.id, entry.species.id, true]);
        expect([zone.id, entry.species.id, entry.species.inWild]).toEqual([zone.id, entry.species.id, true]);
        expect([zone.id, entry.weight]).toEqual([zone.id, LEGENDARY_WEIGHT]);
      }
    }
  });

  it('等权：古代遗迹三神柱各 1/3（不分捕获率档）', () => {
    const pool = zonePool('ruins');
    expect(pool.map((e) => e.weight)).toEqual([1, 1, 1]);
    expect(zonePoolWeight('ruins')).toBe(3);
    const counts = new Map<number, number>();
    for (let i = 0; i < 3_000; i++) {
      const species = pickZoneSpecies(i / 3_000, 'ruins');
      counts.set(species.id, (counts.get(species.id) ?? 0) + 1);
    }
    for (const id of [377, 378, 379]) {
      expect([id, Math.abs((counts.get(id) ?? 0) / 3_000 - 1 / 3) < 0.02]).toEqual([id, true]);
    }
  });

  it('等级带：固定等级（遗迹/南岛 Lv40、诞生之岛 Lv45）与窄带（天空之柱 Lv45-50）', () => {
    const fixed: Array<[string, number]> = [
      ['ruins', 40],
      ['southern-island', 40],
      ['birth-island', 45],
    ];
    for (const [zoneId, level] of fixed) {
      const zone = getZone(zoneId)!;
      expect([zoneId, zone.minLevel, zone.maxLevel]).toEqual([zoneId, level, level]);
      for (let i = 0; i < 50; i++) {
        const stream = new DeriveStream(SERVER_SEED, i.toString(16).padStart(16, '0'), 'ev_legend_level');
        expect(deriveWildLevel(stream, zone)).toBe(level);
      }
    }
    const pillar = getZone('sky-pillar')!;
    const seen = new Set<number>();
    for (let i = 0; i < 300; i++) {
      const stream = new DeriveStream(SERVER_SEED, i.toString(16).padStart(16, '0'), 'ev_sky_level');
      const level = deriveWildLevel(stream, pillar);
      expect(level).toBeGreaterThanOrEqual(45);
      expect(level).toBeLessThanOrEqual(50);
      seen.add(level);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([45, 46, 47, 48, 49, 50]);
  });
});

describe('分区野生池抽样', () => {
  it('加权抽样的频率与权重成正比（均匀扫 10000 个掷点，覆盖全部 13 区）', () => {
    for (const zone of ZONES) {
      const pool = zonePool(zone);
      const total = zonePoolWeight(zone);
      const counts = new Map<number, number>();
      const samples = 10_000;
      for (let i = 0; i < samples; i++) {
        const species = pickZoneSpecies(i / samples, zone);
        expect(zoneSpeciesIds(zone)).toContain(species.id);
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
    }
    // 常见种（权重 60）比最低权重的种族（3）明显更常出现
    const grassPool = zonePool('route-grass');
    const heaviest = grassPool.reduce((a, b) => (b.weight > a.weight ? b : a));
    const lightest = grassPool.reduce((a, b) => (b.weight < a.weight ? b : a));
    expect(heaviest.weight).toBe(COMMON_WEIGHT);
    expect(lightest.weight).toBeLessThan(heaviest.weight);
    let heavyHits = 0;
    let lightHits = 0;
    for (let i = 0; i < 10_000; i++) {
      const species = pickZoneSpecies(i / 10_000, 'route-grass');
      if (species.id === heaviest.species.id) heavyHits += 1;
      if (species.id === lightest.species.id) lightHits += 1;
    }
    expect(heavyHits).toBeGreaterThan(lightHits * 5);
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
    for (let i = 0; i < 500; i++) {
      const stream = new DeriveStream(SERVER_SEED, i.toString(16).padStart(16, '0'), 'ev_zone_level');
      for (const zone of ZONES.filter((z) => !z.legendary)) {
        const level = deriveWildLevel(stream, zone);
        expect(level).toBeGreaterThanOrEqual(zone.minLevel);
        expect(level).toBeLessThanOrEqual(zone.maxLevel);
      }
    }
    // 500 次抽样下每个普通区都覆盖到带内所有等级（均匀性粗检）
    for (const zone of ZONES.filter((z) => !z.legendary)) {
      const levels = new Set<number>();
      for (let i = 0; i < 500; i++) {
        const stream = new DeriveStream(SERVER_SEED, i.toString(16).padStart(16, '0'), 'ev_zone_level');
        levels.add(deriveWildLevel(stream, zone));
      }
      expect([zone.id, levels.size]).toEqual([zone.id, zone.maxLevel - zone.minLevel + 1]);
    }
  });

  it('诱饵带内 +2/+5 且封顶 zone.maxLevel（普通区）', () => {
    expect(LURE_TIERS[0]).toMatchObject({ cost: 0, levelBonus: 0, shinyMultiplier: 1 });
    expect(LURE_TIERS[1]).toMatchObject({ cost: 50, levelBonus: 2, shinyMultiplier: 1 });
    expect(LURE_TIERS[2]).toMatchObject({ cost: 200, levelBonus: 5, shinyMultiplier: 4 });

    for (const zone of ZONES.filter((z) => !z.legendary)) {
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
    }
  });
});

describe('CaptureService.encounter：区域入参 + 与队伍等级脱钩', () => {
  const build = () => {
    const { chain, contract } = makeChain();
    const redis = makeRedis();
    return { chain, contract, redis, capture: new CaptureService(chain, contract, redis) };
  };

  it('区域决定野生池与等级带：route-grass 只出 stage 0 且 Lv2-6，冠军之路可出二段进化型', async () => {
    const { contract, capture } = build();
    await registerPlayers(contract, 'ash');

    // 200 次真实遇敌（每次一条独立 HMAC 派生流）
    const grassSpecies = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const enc = await capture.encounter(ash, undefined, 0, 'route-grass');
      expect(enc.wild.level).toBeGreaterThanOrEqual(2);
      expect(enc.wild.level).toBeLessThanOrEqual(6);
      expect(evolutionStage(enc.wild.speciesId)).toBe(0);
      grassSpecies.add(enc.wild.speciesId);
    }
    // 加权池确实被用到：200 次里至少出现 5 个不同种族
    expect(grassSpecies.size).toBeGreaterThanOrEqual(5);

    const northStages = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const enc = await capture.encounter(ash, undefined, 0, 'route-north');
      expect(enc.wild.level).toBeGreaterThanOrEqual(17);
      expect(enc.wild.level).toBeLessThanOrEqual(28);
      const stage = evolutionStage(enc.wild.speciesId);
      expect(stage).toBeLessThanOrEqual(2);
      northStages.add(stage);
    }
    // 冠军之路能遇到（含）进化型：200 次里同时出现基础形态与至少一段进化型
    expect(northStages.has(0)).toBe(true);
    expect([...northStages].some((s) => s >= 1)).toBe(true);
  });

  it('回归：队伍 Lv50/Lv80 在 route-grass 仍只遇 Lv2-6（抓高级怪不再滚雪球）', async () => {
    const { chain, contract, capture } = build();
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', { id: 'p_a', level: 50 });
    await seedPokemon(chain, 'ash', { id: 'p_b', level: 80, speciesId: 149 });

    for (let i = 0; i < 30; i++) {
      const enc = await capture.encounter(ash, undefined, 0, 'route-grass');
      expect(enc.wild.level).toBeLessThanOrEqual(6);
      expect(evolutionStage(enc.wild.speciesId)).toBe(0);
    }
    const mid = await capture.encounter(ash, undefined, 0, 'route-mid');
    expect(mid.wild.level).toBeLessThanOrEqual(16);
    // 别名 north 也能用：归一为规范 id 并落在 Lv17-28
    const alias = await capture.encounter(ash, undefined, 0, 'north');
    expect(alias.zone.id).toBe('route-north');
    expect(alias.wild.level).toBeGreaterThanOrEqual(17);
  });

  it('缺省与非法 zoneId：缺省草丛、非法 INVALID_ZONE', async () => {
    const { contract, capture } = build();
    await registerPlayers(contract, 'ash');
    const enc = await capture.encounter(ash);
    expect(enc.zone.id).toBe('route-grass');
    expect(enc.zone.legendary).toBe(false);
    await expect(capture.encounter(ash, undefined, 0, 'nope')).rejects.toThrow(/INVALID_ZONE/);
    await expect(capture.encounter(ash, undefined, 0, 'route-gras')).rejects.toThrow(/INVALID_ZONE/);
  });
});

describe('区域的对外查询（GET /capture/zones 的数据源）', () => {
  it('zoneTable：13 区 + 缺省区 + 别名；传说区带钥匙 / 禁诱饵；普通区带栖息地与池规模', () => {
    const table = zoneTable();
    expect(table.default).toBe('route-grass');
    expect(table.aliases).toEqual({ south: 'route-grass', mid: 'route-mid', north: 'route-north' });
    expect(table.zones.map((z) => z.id)).toEqual([...ZONE_IDS]);

    for (const info of table.zones) {
      const zone = getZone(info.id)!;
      expect(info.name).toBe(zone.name);
      expect(info.minLevel).toBe(zone.minLevel);
      expect(info.maxLevel).toBe(zone.maxLevel);
      expect(info.maxStage).toBe(zone.maxStage);
      expect(info.habitats).toEqual([...zone.habitats]);
      expect(info.poolSize).toBe(zonePool(zone).length);
      if (info.legendary) {
        expect(info.keyTypeId).toBe(zone.keyTypeId);
        expect(info.keyNameZh).toBeTruthy();
        expect(info.lureAllowed).toBe(false);
      } else {
        expect(info.keyTypeId).toBeNull();
        expect(info.keyNameZh).toBeNull();
        expect(info.lureAllowed).toBe(true);
      }
    }
    // 钥匙的中文名取自道具表（前端直接展示，不必再查一次 /items/catalog）
    const keys = Object.fromEntries(table.zones.filter((z) => z.keyTypeId).map((z) => [z.id, z.keyNameZh]));
    expect(keys).toEqual({
      'sky-pillar': '天空之钥',
      seafloor: '海洋之钥',
      magma: '熔岩之钥',
      ruins: '遗迹之钥',
      'southern-island': '岛之钥',
      'birth-island': '诞生岛船票',
    });
  });

  it('图鉴 habitatOf：每只带出现区域列表（传说只列传说区、从不出现的为 []）', async () => {
    const { contract } = makeChain();
    const redis = makeRedis();
    await registerPlayers(contract, 'ash');
    const pokemon = makePokemonService(contract, redis);
    const dex = await pokemon.pokedex('ash');
    expect(dex).toHaveLength(386);
    const byId = new Map(dex.map((d) => [d.speciesId, d]));

    expect(byId.get(16)).toMatchObject({ habitatOf: ['route-grass', 'route-mid'], legendary: false });
    expect(byId.get(4)).toMatchObject({ habitatOf: ['volcano'] });
    expect(byId.get(129)).toMatchObject({ habitatOf: ['coast'] });
    expect(byId.get(26)).toMatchObject({ habitatOf: [], legendary: false }); // 手调进化型
    expect(byId.get(384)).toMatchObject({ habitatOf: ['sky-pillar'], legendary: true }); // 烈空坐
    expect(byId.get(385)).toMatchObject({ habitatOf: [], legendary: true }); // 基拉祈：未开放
    // habitatOf 与区域池一一对应（抽样交叉验证）
    for (const id of [1, 74, 147, 374, 382]) {
      expect(byId.get(id)!.habitatOf).toEqual(zonesForSpecies(id));
    }
    // 从不出现的种族 = 未开放遭遇（手调进化型 / 未开放传说）+ **进化型**（所在区域门槛更低，只能靠进化）
    const orphans = dex.filter((d) => d.habitatOf.length === 0);
    const wildOrphans = orphans.filter((d) => getSpecies(d.speciesId)!.inWild);
    expect(orphans).toHaveLength(80); // 370 个野生种族（361 普通 + 9 传说）里 306 种能遇到
    expect(wildOrphans).toHaveLength(64);
    // 18 属性均有栖息地：没有任何"属性无处可去"的种族，64 只全部是进化型
    const uncovered = wildOrphans.filter((d) => !NORMAL_HABITAT_TYPES.includes(getSpecies(d.speciesId)!.type));
    expect(uncovered).toEqual([]);
    expect(wildOrphans.every((d) => evolutionStage(d.speciesId) > 0)).toBe(true);
    expect(wildOrphans.map((d) => d.speciesId)).toContain(25); // 皮卡丘（皮丘进化）
    for (const d of orphans) {
      const species = getSpecies(d.speciesId)!;
      // 每一个"无出现区域"的种族：要么是进化型，要么本来就没开放遭遇
      expect([d.speciesId, evolutionStage(d.speciesId) > 0 || !species.inWild]).toEqual([d.speciesId, true]);
    }
  });
});
