import { EVOLUTIONS, SpeciesDef, WILD_TABLE } from './species.data';

/**
 * 区域遇敌模型（docs/backend-api.md §2「区域等级带」、docs/randomness.md §3 n=0/n=1）：
 * 地图按 y 坐标分三个区域，每区固定**等级带**与**野生池门槛**——野怪等级只由区域决定
 * （与玩家队伍等级彻底脱钩），池内只允许进化阶段 `stage ≤ maxStage` 的种族，并按
 * 稀有度权重加权抽样。前端 `frontend/src/stores/zone.ts` 镜像同一份表（含地图 y 带）。
 */
export type ZoneId = 'south' | 'mid' | 'north';

export interface ZoneDef {
  id: ZoneId;
  /** 展示名（游戏 HUD / CaptureOverlay） */
  name: string;
  /** 等级带下界（含） */
  minLevel: number;
  /** 等级带上界（含） */
  maxLevel: number;
  /** 入池门槛：只允许进化阶段 stage ≤ maxStage 的种族（0 = 只出未进化型） */
  maxStage: number;
}

export const ZONES: readonly ZoneDef[] = [
  { id: 'south', name: '101 号道路·南', minLevel: 2, maxLevel: 6, maxStage: 0 },
  { id: 'mid', name: '101 号道路·中', minLevel: 8, maxLevel: 16, maxStage: 1 },
  { id: 'north', name: '101 号道路·北', minLevel: 17, maxLevel: 28, maxStage: 2 },
];

export const ZONE_IDS: readonly ZoneId[] = ZONES.map((z) => z.id);

/** 缺省区域：南部（初始区，Lv2-6 只出未进化型） */
export const DEFAULT_ZONE_ID: ZoneId = 'south';

export function getZone(id: string | undefined | null): ZoneDef | undefined {
  return ZONES.find((z) => z.id === id);
}

/** 入参 → 区域：未传（undefined/null/空串）回落南部；非法 id 返回 undefined（调用方抛 INVALID_ZONE） */
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

/**
 * 区域野生池：全部 `inWild` 种族里 stage ≤ 门槛的那些，按图鉴 id 升序，
 * 权重与累计上界一并缓存（确定性，与调用次数无关）。抽选用 `pickZoneSpecies`。
 */
export function zonePool(zone: ZoneId | ZoneDef): ZonePoolEntry[] {
  const def = typeof zone === 'string' ? getZone(zone) : zone;
  if (!def) throw new Error(`unknown zone ${String(zone)}`);
  const cached = poolCache.get(def.id);
  if (cached) return cached;

  const entries: ZonePoolEntry[] = [];
  let cumulative = 0;
  for (const species of WILD_TABLE) {
    const stage = evolutionStage(species.id);
    if (stage > def.maxStage) continue;
    const weight = rarityWeight(species);
    cumulative += weight;
    entries.push({ species, stage, weight, cumulative });
  }
  poolCache.set(def.id, entries);
  return entries;
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
