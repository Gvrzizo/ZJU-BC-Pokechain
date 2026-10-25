import { getItemType } from './items.data';
import { EVOLUTIONS, SpeciesDef, WILD_TABLE, getSpecies } from './species.data';
import { PokeType } from './type-chart';

/**
 * 区域遇敌模型（docs/backend-api.md §2「区域与栖息地野生池」、docs/randomness.md §3 n=0/n=1）：
 *
 * - **普通区**（7 个）：固定的**等级带** + **进化阶段门槛**（`stage ≤ maxStage`）+ **栖息地属性过滤**
 *   （种族属性 ∈ `habitats` 才入池），池内按稀有度加权抽样。野怪等级只由区域决定，与队伍等级脱钩。
 * - **传说区**（6 个）：池是**显式指定**的传说种族（等权）、等级带很窄（或固定等级），
 *   进入需要对应**钥匙道具**（一次性：创建遇敌时消耗 1 把，H11），且**每人每区只能持有一只**（拥有池内任一种族即拒绝，
 *   门控见 capture.service.ts::assertLegendaryAccess），诱饵被拒。
 * - **兼容别名**：旧三区 id `south`/`mid`/`north` 分别指向 `route-grass`/`route-mid`/`route-north`，
 *   输入时归一为规范 id（响应/链上 `Commit.meta.zone` 一律记规范 id）。
 */
export type ZoneId =
  | 'route-grass'
  | 'forest'
  | 'route-mid'
  | 'cave'
  | 'coast'
  | 'route-north'
  | 'volcano'
  | 'sky-pillar'
  | 'seafloor'
  | 'magma'
  | 'ruins'
  | 'southern-island'
  | 'birth-island';

/** 旧三区 id → 规范 id（e2e-smoke / 旧前端仍在用；输入归一，输出恒为规范 id） */
export const ZONE_ALIASES: Readonly<Record<string, ZoneId>> = {
  south: 'route-grass',
  mid: 'route-mid',
  north: 'route-north',
};

export type ZoneAlias = keyof typeof ZONE_ALIASES;

export interface ZoneDef {
  id: ZoneId;
  /** 展示名（游戏 HUD / CaptureOverlay / 图鉴「出现区域」） */
  name: string;
  /** 等级带下界（含） */
  minLevel: number;
  /** 等级带上界（含）；等于 minLevel 即固定等级 */
  maxLevel: number;
  /** 入池门槛：只允许进化阶段 stage ≤ maxStage 的种族（传说区池显式指定，门槛不参与过滤） */
  maxStage: number;
  /** 栖息地属性集：种族属性命中其一才入池（传说区为空数组，池由 poolSpeciesIds 固定） */
  habitats: readonly PokeType[];
  /** 传说区标记：需要钥匙、每人每池仅一只、禁止诱饵（见 capture.service.ts） */
  legendary?: boolean;
  /** 进入该区所需的钥匙 typeId（一次性消耗品，`game-data/items.data.ts` 的 kind='key'） */
  keyTypeId?: string;
  /** 传说区固定池（全国图鉴 id）；普通区不填（由 stage + 栖息地过滤得到） */
  poolSpeciesIds?: readonly number[];
}

/**
 * 区域表：普通区 7 个 + 传说区 6 个。
 *
 * 传说区的池与等级带参考第三世代原作：天空之柱（烈空坐 Lv45-50）、海底洞窟（盖欧卡 Lv45-50）、
 * 熔岩洞窟（固拉多 Lv45-50）、古代遗迹（三神柱 Lv40）、南方孤岛（拉帝亚斯/拉帝欧斯 Lv40）、
 * 诞生之岛（代欧奇希斯 Lv45）。
 */
export const ZONES: readonly ZoneDef[] = [
  {
    id: 'route-grass',
    name: '101 号道路·草丛',
    minLevel: 2,
    maxLevel: 6,
    maxStage: 0,
    habitats: ['normal', 'bug', 'grass', 'electric', 'flying'],
  },
  {
    id: 'forest',
    name: '橙华森林',
    minLevel: 4,
    maxLevel: 10,
    maxStage: 0,
    // fairy：森林妖精（皮皮/胖丁系）
    habitats: ['bug', 'grass', 'flying', 'poison', 'fairy'],
  },
  {
    id: 'route-mid',
    name: '104 号道路·丘陵',
    minLevel: 8,
    maxLevel: 16,
    maxStage: 1,
    habitats: ['normal', 'flying', 'fighting', 'ground'],
  },
  {
    id: 'cave',
    name: '石之洞窟',
    minLevel: 12,
    maxLevel: 20,
    maxStage: 1,
    // ghost/ice：洞窟里的幽灵与冰系（鬼斯系、迷唇姐/白海狮系）
    habitats: ['rock', 'ground', 'poison', 'dark', 'ghost', 'ice'],
  },
  {
    id: 'coast',
    name: '108 号水道·海滨',
    minLevel: 15,
    maxLevel: 25,
    maxStage: 1,
    habitats: ['water'],
  },
  {
    id: 'route-north',
    name: '冠军之路',
    minLevel: 17,
    maxLevel: 28,
    maxStage: 2,
    // psychic：高地上的超能系（凯西系、拉鲁拉丝系）
    habitats: ['flying', 'dragon', 'steel', 'fighting', 'psychic'],
  },
  {
    id: 'volcano',
    name: '烟囱山',
    minLevel: 20,
    maxLevel: 30,
    maxStage: 2,
    habitats: ['fire', 'ground', 'rock'],
  },
  // ---- 传说区（钥匙门控，池内只有传说） ----
  {
    id: 'sky-pillar',
    name: '天空之柱',
    minLevel: 45,
    maxLevel: 50,
    maxStage: 0,
    habitats: [],
    legendary: true,
    keyTypeId: 'sky-key',
    poolSpeciesIds: [384], // 烈空坐
  },
  {
    id: 'seafloor',
    name: '海底洞窟',
    minLevel: 45,
    maxLevel: 50,
    maxStage: 0,
    habitats: [],
    legendary: true,
    keyTypeId: 'ocean-key',
    poolSpeciesIds: [382], // 盖欧卡
  },
  {
    id: 'magma',
    name: '熔岩洞窟',
    minLevel: 45,
    maxLevel: 50,
    maxStage: 0,
    habitats: [],
    legendary: true,
    keyTypeId: 'magma-key',
    poolSpeciesIds: [383], // 固拉多
  },
  {
    id: 'ruins',
    name: '古代遗迹',
    minLevel: 40,
    maxLevel: 40,
    maxStage: 0,
    habitats: [],
    legendary: true,
    keyTypeId: 'ruins-key',
    poolSpeciesIds: [377, 378, 379], // 雷吉洛克 / 雷吉艾斯 / 雷吉斯奇鲁
  },
  {
    id: 'southern-island',
    name: '南方孤岛',
    minLevel: 40,
    maxLevel: 40,
    maxStage: 0,
    habitats: [],
    legendary: true,
    keyTypeId: 'island-key',
    poolSpeciesIds: [380, 381], // 拉帝亚斯 / 拉帝欧斯
  },
  {
    id: 'birth-island',
    name: '诞生之岛',
    minLevel: 45,
    maxLevel: 45,
    maxStage: 0,
    habitats: [],
    legendary: true,
    keyTypeId: 'birth-key',
    poolSpeciesIds: [386], // 代欧奇希斯
  },
];

export const ZONE_IDS: readonly ZoneId[] = ZONES.map((z) => z.id);

/** 普通区 / 传说区 id 列表（前端分区渲染、测试断言用） */
export const NORMAL_ZONE_IDS: readonly ZoneId[] = ZONES.filter((z) => !z.legendary).map((z) => z.id);
export const LEGENDARY_ZONE_IDS: readonly ZoneId[] = ZONES.filter((z) => z.legendary).map((z) => z.id);

/** 缺省区域：101 号道路·草丛（初始区，Lv2-6 只出未进化型） */
export const DEFAULT_ZONE_ID: ZoneId = 'route-grass';

/** 规范化区域 id：接受规范 id 与旧别名，非法返回 undefined */
export function canonicalZoneId(id: string | undefined | null): ZoneId | undefined {
  if (id === undefined || id === null || id === '') return undefined;
  const canonical = (ZONE_ALIASES[id] ?? id) as ZoneId;
  return ZONES.some((z) => z.id === canonical) ? canonical : undefined;
}

export function getZone(id: string | undefined | null): ZoneDef | undefined {
  const canonical = canonicalZoneId(id);
  return canonical === undefined ? undefined : ZONES.find((z) => z.id === canonical);
}

/** 入参 → 区域：未传（undefined/null/空串）回落草丛；别名归一；非法 id 返回 undefined（调用方抛 INVALID_ZONE） */
export function resolveZone(id?: string | null): ZoneDef | undefined {
  if (id === undefined || id === null || id === '') return getZone(DEFAULT_ZONE_ID);
  return getZone(id);
}

// ------------------------------------------------------------ 进化阶段

const INCOMING = new Map<number, number>();
for (const rule of EVOLUTIONS) {
  if (!INCOMING.has(rule.to)) INCOMING.set(rule.to, rule.from);
}

const stageCache = new Map<number, number>();

/**
 * 进化阶段（沿 EVOLUTIONS 回溯，与 `tools/gen-learnsets.mjs` 同一口径）：
 * 0 = 基础形态（无前置进化）、1 = 一段进化、2 = 二段进化。
 */
export function evolutionStage(speciesId: number): number {
  const cached = stageCache.get(speciesId);
  if (cached !== undefined) return cached;
  let stage = 0;
  let cur = speciesId;
  while (INCOMING.has(cur) && stage < 3) {
    cur = INCOMING.get(cur)!;
    stage += 1;
  }
  stageCache.set(speciesId, stage);
  return stage;
}

// ------------------------------------------------------------ 稀有度权重

export const COMMON_CATCH_RATE = 200;
export const UNCOMMON_CATCH_RATE = 80;
export const COMMON_WEIGHT = 60;
export const UNCOMMON_WEIGHT = 30;
export const RARE_WEIGHT = 10;
/** 准神/高种族值（种族值总量 ≥ 该值）在档位权重上再 ×0.3 */
export const RARE_BST = 500;
export const RARE_BST_MULTIPLIER = 0.3;

export type RarityTier = 'common' | 'uncommon' | 'rare';

/** 稀有度档位：按官方捕获率分档（≥200 常见 / 80–199 少见 / <80 稀有） */
export function rarityTier(catchRate: number): RarityTier {
  if (catchRate >= COMMON_CATCH_RATE) return 'common';
  if (catchRate >= UNCOMMON_CATCH_RATE) return 'uncommon';
  return 'rare';
}

export function baseStatTotal(species: SpeciesDef): number {
  const b = species.base;
  return b.hp + b.atk + b.def + b.spatk + b.spdef + b.speed;
}

/** 加权抽样的权重：常见 60 / 少见 30 / 稀有 10，种族值总量 ≥500 再 ×0.3（18/9/3，取整避免浮点尾差） */
export function rarityWeight(species: SpeciesDef): number {
  const tier = rarityTier(species.catchRate);
  const base = tier === 'common' ? COMMON_WEIGHT : tier === 'uncommon' ? UNCOMMON_WEIGHT : RARE_WEIGHT;
  return baseStatTotal(species) >= RARE_BST ? Math.round(base * RARE_BST_MULTIPLIER * 100) / 100 : base;
}

// ------------------------------------------------------------ 分区野生池

export interface ZonePoolEntry {
  species: SpeciesDef;
  /** 进化阶段（0/1/2） */
  stage: number;
  weight: number;
  /** 权重区间上界（前缀和的半开区间 `[上一项 cumulative, 本项 cumulative)`） */
  cumulative: number;
}

const poolCache = new Map<ZoneId, ZonePoolEntry[]>();

/** 传说区权重：池内**等权**——传说之间不按捕获率再分档（"rarity 权重唯一"） */
export const LEGENDARY_WEIGHT = 1;

/**
 * 种族属性集：图鉴数据只存主属性（`tools/gen-pokedex.mjs` 取 PokeAPI 第一属性，战斗也是单属性模型），
 * 故栖息地过滤的实际口径是"主属性 ∈ `zone.habitats`"；日后引入副属性表只需让本函数返回全部属性。
 */
export function speciesTypes(species: SpeciesDef): readonly PokeType[] {
  return [species.type];
}

/**
 * 区域野生池：
 *
 * - **普通区**：`WILD_TABLE`（= 除传说/幻之与手调进化型外的全部种族）里 `stage ≤ maxStage`
 *   **且属性命中 `zone.habitats`** 的种族，按图鉴 id 升序；权重 = `rarityWeight`
 *   （常见 60 / 少见 30 / 稀有 10，种族值总量 ≥500 再 ×0.3）。
 *   **空池兜底**：栖息地过滤后为空时退回"只看门槛"的池，保证遇敌永不空转
 *   （当前数据下不会触发——`test/encounter-zone.spec.ts` 断言每区池非空且属性自洽）。
 * - **传说区**：`poolSpeciesIds` 显式指定的传说种族，等权（`LEGENDARY_WEIGHT`），不受 `maxStage` 过滤。
 *
 * 权重与累计上界一并缓存（确定性，与调用次数无关）。抽选用 `pickZoneSpecies`。
 */
export function zonePool(zone: ZoneId | ZoneDef): ZonePoolEntry[] {
  const def = typeof zone === 'string' ? resolveZone(zone) : zone;
  if (!def) throw new Error(`unknown zone ${String(zone)}`);
  const cached = poolCache.get(def.id);
  if (cached) return cached;

  const entries: ZonePoolEntry[] = [];
  let cumulative = 0;
  const push = (species: SpeciesDef) => {
    const weight = def.legendary ? LEGENDARY_WEIGHT : rarityWeight(species);
    cumulative += weight;
    entries.push({ species, stage: evolutionStage(species.id), weight, cumulative });
  };

  if (def.legendary) {
    for (const id of def.poolSpeciesIds ?? []) {
      const species = getSpecies(id);
      if (!species) throw new Error(`zone ${def.id} references unknown species ${id}`);
      push(species);
    }
  } else {
    const byStage = WILD_TABLE.filter((s) => evolutionStage(s.id) <= def.maxStage);
    const byHabitat = byStage.filter((s) => speciesTypes(s).some((t) => def.habitats.includes(t)));
    for (const species of byHabitat.length > 0 ? byHabitat : byStage) push(species);
  }
  poolCache.set(def.id, entries);
  return entries;
}

/** 池内种族 id（传说门的"是否已拥有"判定用；顺序 = 池内顺序） */
export function zoneSpeciesIds(zone: ZoneId | ZoneDef): number[] {
  return zonePool(zone).map((e) => e.species.id);
}

/** 分区池总权重（= 最后一项的累计上界） */
export function zonePoolWeight(zone: ZoneId | ZoneDef): number {
  const pool = zonePool(zone);
  return pool.length > 0 ? pool[pool.length - 1].cumulative : 0;
}

/**
 * 分区加权抽样（n=0 槽的映射）：`roll ∈ [0,1)` 乘总权重后落入某个种族的权重区间
 * （半开区间 `[上一项 cumulative, 本项 cumulative)`，边界值归属下一个种族）。
 * roll 越界（1 或负值）夹到边界，保证任何派生值都能取到一个合法种族。
 */
export function pickZoneSpecies(roll: number, zone: ZoneId | ZoneDef): SpeciesDef {
  const pool = zonePool(zone);
  if (pool.length === 0) throw new Error(`zone ${typeof zone === 'string' ? zone : zone.id} has an empty wild pool`);
  const r = Math.min(1 - Number.EPSILON, Math.max(0, roll));
  const target = r * pool[pool.length - 1].cumulative;
  for (const entry of pool) {
    if (target < entry.cumulative) return entry.species;
  }
  return pool[pool.length - 1].species;
}

let habitatIndex: Map<number, ZoneId[]> | null = null;

/** 反查索引：某种族在哪些区域出现（图鉴 `habitatOf`；含传说区） */
export function zonesForSpecies(speciesId: number): ZoneId[] {
  if (!habitatIndex) {
    habitatIndex = new Map();
    for (const zone of ZONES) {
      for (const entry of zonePool(zone)) {
        const list = habitatIndex.get(entry.species.id);
        if (list) list.push(zone.id);
        else habitatIndex.set(entry.species.id, [zone.id]);
      }
    }
  }
  return habitatIndex.get(speciesId) ?? [];
}

/** `GET /capture/zones` 的区域表条目（前端渲染 + 调试） */
export interface ZoneInfo {
  id: ZoneId;
  /** 中文展示名 */
  name: string;
  minLevel: number;
  maxLevel: number;
  /** 进化阶段门槛（`stage ≤ maxStage`）；传说区池显式指定，门槛不参与过滤 */
  maxStage: number;
  /** 栖息地属性集（传说区为 []） */
  habitats: PokeType[];
  legendary: boolean;
  /** 进入该区所需的钥匙 typeId（普通区为 null） */
  keyTypeId: string | null;
  /** 钥匙中文名（与 keyTypeId 同源，便于前端直接展示） */
  keyNameZh: string | null;
  /** 是否允许付费诱饵（传说区 false，见 capture.service 的 LURE_NOT_ALLOWED） */
  lureAllowed: boolean;
  /** 该区加权池的种族数 */
  poolSize: number;
}

export function zoneTable(): { default: ZoneId; aliases: Record<ZoneAlias, ZoneId>; zones: ZoneInfo[] } {
  return {
    default: DEFAULT_ZONE_ID,
    aliases: { ...ZONE_ALIASES } as Record<ZoneAlias, ZoneId>,
    zones: ZONES.map((zone) => ({
      id: zone.id,
      name: zone.name,
      minLevel: zone.minLevel,
      maxLevel: zone.maxLevel,
      maxStage: zone.maxStage,
      habitats: [...zone.habitats],
      legendary: zone.legendary === true,
      keyTypeId: zone.keyTypeId ?? null,
      keyNameZh: zone.keyTypeId ? (getItemType(zone.keyTypeId)?.nameZh ?? null) : null,
      lureAllowed: zone.legendary !== true,
      poolSize: zonePool(zone).length,
    })),
  };
}
