import { defineStore } from 'pinia';

/**
 * 遇敌区域表（前端镜像 `backend/src/game-data/encounter.data.ts` 的 `ZONES`；改表要两边同步）。
 *
 * - **7 块普通区**（route-grass / forest / route-mid / cave / coast / route-north / volcano）：
 *   固定等级带 + 进化阶段门槛（`stage ≤ maxStage`）+ 栖息地属性过滤，池内按稀有度加权；
 * - **6 个传说区**（legendary）：池内只有指定传说种族、等级固定在高段、**禁止诱饵**、
 *   进入需要对应钥匙道具（`keyTypeId`，非消耗品）、每人每池只能持有一只；
 * - **缺省区** = `route-grass`（旧口径的南部出生区）；旧 id 兼容别名 `south/mid/north`。
 *
 * `town` 是**前端专有的安全区伪区域**（后端没有这个 id，镇内不会触发遇敌，永远不会发给后端），
 * 只用于 HUD 展示。
 */
export type ZoneId =
  | 'town'
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

/** 旧区域 id（y 带口径），仅用于兼容外部调用 */
export type ZoneAlias = 'south' | 'mid' | 'north';

export const ZONE_ALIASES: Record<ZoneAlias, ZoneId> = {
  south: 'route-grass',
  mid: 'route-mid',
  north: 'route-north',
};

/** 传说区：池内只有 `speciesIds` 这些传说宝可梦，进入需要 `keyTypeId` 钥匙 */
export interface LegendaryZoneDef {
  /** HUD 展示的传说名（多个用「/」分隔） */
  name: string;
  speciesIds: number[];
  /** 入场钥匙 typeId（非消耗品，商店有售） */
  keyTypeId: string;
}

export interface ZoneDef {
  id: ZoneId;
  name: string;
  /** 等级带下界（含） */
  minLevel?: number;
  /** 等级带上界（含）；等于下界即固定等级 */
  maxLevel?: number;
  /** 入池门槛：只允许进化阶段 stage ≤ maxStage 的种族（0 = 只出未进化型） */
  maxStage?: number;
  /** 安全区（镇内）：没有野生宝可梦 */
  safe?: boolean;
  legendary?: LegendaryZoneDef;
}

export const ZONES: readonly ZoneDef[] = [
  { id: 'town', name: '未白镇', safe: true },
  { id: 'route-grass', name: '101 号道路·草丛', minLevel: 2, maxLevel: 6, maxStage: 0 },
  { id: 'forest', name: '橙华森林', minLevel: 4, maxLevel: 10, maxStage: 0 },
  { id: 'route-mid', name: '104 号道路·丘陵', minLevel: 8, maxLevel: 16, maxStage: 1 },
  { id: 'cave', name: '石之洞窟', minLevel: 12, maxLevel: 20, maxStage: 1 },
  { id: 'coast', name: '108 号水道·海滨', minLevel: 15, maxLevel: 25, maxStage: 1 },
  { id: 'route-north', name: '冠军之路', minLevel: 17, maxLevel: 28, maxStage: 2 },
  { id: 'volcano', name: '烟囱山', minLevel: 20, maxLevel: 30, maxStage: 2 },
  {
    id: 'sky-pillar',
    name: '天空之柱',
    minLevel: 45,
    maxLevel: 50,
    maxStage: 0,
    legendary: { name: '烈空坐', speciesIds: [384], keyTypeId: 'sky-key' },
  },
  {
    id: 'seafloor',
    name: '海底洞窟',
    minLevel: 45,
    maxLevel: 50,
    maxStage: 0,
    legendary: { name: '盖欧卡', speciesIds: [382], keyTypeId: 'ocean-key' },
  },
  {
    id: 'magma',
    name: '熔岩洞窟',
    minLevel: 45,
    maxLevel: 50,
    maxStage: 0,
    legendary: { name: '固拉多', speciesIds: [383], keyTypeId: 'magma-key' },
  },
  {
    id: 'ruins',
    name: '古代遗迹',
    minLevel: 40,
    maxLevel: 40,
    maxStage: 0,
    legendary: { name: '雷吉洛克/雷吉艾斯/雷吉斯奇鲁', speciesIds: [377, 378, 379], keyTypeId: 'ruins-key' },
  },
  {
    id: 'southern-island',
    name: '南方孤岛',
    minLevel: 40,
    maxLevel: 40,
    maxStage: 0,
    legendary: { name: '拉帝亚斯/拉帝欧斯', speciesIds: [380, 381], keyTypeId: 'island-key' },
  },
  {
    id: 'birth-island',
    name: '诞生之岛',
    minLevel: 45,
    maxLevel: 45,
    maxStage: 0,
    legendary: { name: '代欧奇希斯', speciesIds: [386], keyTypeId: 'birth-key' },
  },
];

/** 缺省区域：101 号道路·草丛（初始区，Lv2-6 只出未进化型） */
export const DEFAULT_ZONE_ID: ZoneId = 'route-grass';

const BY_ID = new Map<string, ZoneDef>(ZONES.map((z) => [z.id, z]));

export function isAlias(value: string): value is ZoneAlias {
  return value in ZONE_ALIASES;
}

/** 区域 id（含旧别名）→ 新 id；未收录返回 undefined */
export function resolveZoneId(id: unknown): ZoneId | undefined {
  if (typeof id !== 'string') return undefined;
  if (isAlias(id)) return ZONE_ALIASES[id];
  return BY_ID.has(id) ? (id as ZoneId) : undefined;
}

/** 区域定义；接受新 id 与旧别名，未收录回退缺省区域（草丛） */
export function zoneById(id: string): ZoneDef {
  const resolved = resolveZoneId(id);
  return (resolved ? BY_ID.get(resolved) : undefined) ?? BY_ID.get(DEFAULT_ZONE_ID)!;
}

/** 等级带文案：`Lv2-6` / 没有等级带（安全区）空串 */
export function zoneLevelText(zone: ZoneDef): string {
  if (zone.minLevel === undefined || zone.maxLevel === undefined) return '';
  return `Lv${zone.minLevel}-${zone.maxLevel}`;
}

/** HUD / 提示文案：`101 号道路·草丛 Lv2-6`、`未白镇`（安全区没有等级带） */
export function zoneLabel(zone: ZoneDef): string {
  const level = zoneLevelText(zone);
  return level ? `${zone.name} ${level}` : zone.name;
}

/** 一句区域说明（阶段门槛 / 传说 / 安全区），无法判断时返回空串 */
export function zoneHint(zone: ZoneDef): string {
  if (zone.legendary) return `传说出没：${zone.legendary.name}`;
  if (zone.safe) return '没有野生宝可梦';
  if (zone.maxStage === 0) return '未进化型出没';
  if (zone.maxStage === 1) return '可见进化型';
  if (zone.maxStage === 2) return '进化型领地';
  return '';
}

/** 传说区禁止诱饵（后端 `LURE_NOT_ALLOWED`），前端据此隐藏付费档位 */
export function lureAllowed(zone: ZoneDef): boolean {
  return !zone.legendary;
}

/** 当前所在区域（OverworldScene 按地图写入，CaptureOverlay 读取）：遇敌时随请求发给后端 */
export const useZoneStore = defineStore('zone', {
  state: () => ({ id: 'town' as ZoneId }),
  getters: {
    zone: (s): ZoneDef => zoneById(s.id),
    label(): string {
      return zoneLabel(this.zone);
    },
  },
  actions: {
    enter(id: string) {
      this.id = resolveZoneId(id) ?? DEFAULT_ZONE_ID;
    },
  },
});
