import { shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { getZones } from '@/api/capture';
import type { CaptureZoneInfo, CaptureZonesResponse } from '@/types';

/**
 * 遇敌区域表 —— **数据来自后端** `GET /capture/zones`（`backend/src/game-data/encounter.data.ts`），
 * 前端不再镜像整张 14 区表。模块缓存由 `loadZones()` 在启动时填充一次；后端不可达时只用
 * `town` + 最小缺省区占位，保证游戏照常能走、遇敌请求仍带正确的区域 id。
 *
 * - **13 个后端区**：7 个普通区（等级带 + `stage ≤ maxStage` 门槛 + 栖息地属性过滤）
 *   + 6 个传说区（固定池、窄等级带、**禁止诱饵**、进入需钥匙 `keyTypeId`、每人每池限一只）；
 * - **`town` 是前端专有的安全区伪区域**（后端没有这个 id，镇内不会触发遇敌、不会发给后端），
 *   只用于 HUD 展示；
 * - **缺省区** = 后端响应里的 `default`（当前 `route-grass`）；旧 id 别名 `south/mid/north` 仍在前端归一。
 */
export const ZONE_IDS = [
  'town',
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
] as const;

export type ZoneId = (typeof ZONE_IDS)[number];

const KNOWN_ZONE_IDS = new Set<string>(ZONE_IDS);

/** 旧区域 id（y 带口径），仅用于兼容外部调用 */
export type ZoneAlias = 'south' | 'mid' | 'north';

export const ZONE_ALIASES: Record<ZoneAlias, ZoneId> = {
  south: 'route-grass',
  mid: 'route-mid',
  north: 'route-north',
};

/**
 * 传说区的**展示元数据**（传说名 + 池内种族），不是区域表：
 * `GET /capture/zones` 只下发 `legendary/keyTypeId/keyNameZh`，不含池内种族；
 * HUD（`WorldHud.vue`）与准备界面（`CaptureOverlay.vue`）需要传说名与 `speciesIds`
 * 做「可捕捉：X」和「你已经收服过它了」提示。等级带/钥匙等仍以 API 为准。
 * 后续后端若把 `poolSpeciesIds`/`legendaryName` 加进区域表，这里即可删除。
 */
const LEGENDARY_DISPLAY: Partial<Record<ZoneId, { name: string; speciesIds: number[] }>> = {
  'sky-pillar': { name: '烈空坐', speciesIds: [384] },
  seafloor: { name: '盖欧卡', speciesIds: [382] },
  magma: { name: '固拉多', speciesIds: [383] },
  ruins: { name: '雷吉洛克/雷吉艾斯/雷吉斯奇鲁', speciesIds: [377, 378, 379] },
  'southern-island': { name: '拉帝亚斯/拉帝欧斯', speciesIds: [380, 381] },
  'birth-island': { name: '代欧奇希斯', speciesIds: [386] },
};

/** 传说区：池内只有 `speciesIds` 这些传说宝可梦，进入需要 `keyTypeId` 钥匙 */
export interface LegendaryZoneDef {
  /** HUD 展示的传说名（多个用「/」分隔） */
  name: string;
  speciesIds: number[];
  /** 入场钥匙 typeId（商店有售；消耗/门控由后端 `POST /capture/encounter` 处理） */
  keyTypeId: string;
}

export interface ZoneDef {
  id: ZoneId;
  name: string;
  /** 等级带下界（含）；数据未加载的占位区为 undefined（不展示等级带） */
  minLevel?: number;
  /** 等级带上界（含）；等于下界即固定等级 */
  maxLevel?: number;
  /** 入池门槛：只允许进化阶段 stage ≤ maxStage 的种族（0 = 只出未进化型） */
  maxStage?: number;
  /** 安全区（镇内）：没有野生宝可梦 */
  safe?: boolean;
  legendary?: LegendaryZoneDef;
}

/** 前端专有安全区（后端没有 `town`） */
const TOWN_ZONE: ZoneDef = { id: 'town', name: '未白镇', safe: true };

/** 缺省区域：101 号道路·草丛（后端 `zoneTable().default` 的兜底值） */
export const DEFAULT_ZONE_ID: ZoneId = 'route-grass';

/**
 * 后端不可达时的最小缺省区：只有 id 与展示名。
 * 等级带/门槛不在这里镜像——后端恢复后 `loadZones()` 会用真实表替换。
 */
const FALLBACK_DEFAULT_ZONE: ZoneDef = { id: DEFAULT_ZONE_ID, name: '101 号道路·草丛' };

function fallbackTable(): Map<string, ZoneDef> {
  return new Map<string, ZoneDef>([
    [TOWN_ZONE.id, TOWN_ZONE],
    [FALLBACK_DEFAULT_ZONE.id, FALLBACK_DEFAULT_ZONE],
  ]);
}

/**
 * 模块级区域缓存（`loadZones()` 写入，`zoneById` 同步读取）。
 *
 * 用 `shallowRef` 而不是裸 Map：HUD 的 `world.zone` getter 在 Pinia computed 里调用
 * `zoneById`，数据到达后自动重新求值，不必等玩家走一步才刷新。
 */
const table = shallowRef<ReadonlyMap<string, ZoneDef>>(fallbackTable());
/** 后端给的缺省区（`zoneTable().default`），未知 id 回退到它 */
let defaultZoneId: ZoneId = DEFAULT_ZONE_ID;
/** 一次性拉取：成功后保持 resolved；失败置空以便下次 `loadZones()` 重试 */
let loadPromise: Promise<void> | null = null;

export function isAlias(value: string): value is ZoneAlias {
  return value in ZONE_ALIASES;
}

/** 区域 id（含旧别名）→ 规范 id；未收录返回 undefined（未知 id 由调用方回退缺省区） */
export function resolveZoneId(id: unknown): ZoneId | undefined {
  if (typeof id !== 'string') return undefined;
  if (isAlias(id)) return ZONE_ALIASES[id];
  return KNOWN_ZONE_IDS.has(id) ? (id as ZoneId) : undefined;
}

/**
 * 区域定义；接受新 id 与旧别名。
 *
 * - 未知 id 回退缺省区（与旧行为一致）；
 * - **已知 id 在数据到达前返回只带 id/name 的占位**，保证 `store.enter(map.zoneId)` 后
 *   发给后端的 `zoneId` 不会错成缺省区；
 * - `town` 恒由前端提供。
 */
export function zoneById(id: string): ZoneDef {
  const zones = table.value;
  const resolved = resolveZoneId(id);
  if (!resolved) return zones.get(defaultZoneId) ?? FALLBACK_DEFAULT_ZONE;
  return zones.get(resolved) ?? { id: resolved, name: resolved };
}

/** 等级带文案：`Lv2-6` / 没有等级带（安全区或数据未加载）空串 */
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

/** API 条目 → 内部 ZoneDef（未知 id 丢弃；传说区补展示元数据） */
function zoneFromApi(info: CaptureZoneInfo): ZoneDef | null {
  const id = resolveZoneId(info.id);
  if (!id) return null;
  const zone: ZoneDef = {
    id,
    name: info.name,
    minLevel: info.minLevel,
    maxLevel: info.maxLevel,
    maxStage: info.maxStage,
  };
  if (info.legendary) {
    const display = LEGENDARY_DISPLAY[id];
    zone.legendary = {
      name: display?.name ?? info.keyNameZh ?? info.name,
      speciesIds: display?.speciesIds ?? [],
      keyTypeId: info.keyTypeId ?? '',
    };
  }
  return zone;
}

function applyZoneTable(response: CaptureZonesResponse): void {
  const next = fallbackTable();
  for (const info of response.zones) {
    const zone = zoneFromApi(info);
    if (zone) next.set(zone.id, zone);
  }
  defaultZoneId = resolveZoneId(response.default) ?? DEFAULT_ZONE_ID;
  table.value = next;
}

/**
 * 拉取一次 `GET /capture/zones` 并写入模块缓存（并发调用共享同一个 Promise）。
 * 失败**不抛错、不阻塞**：保留 `town` + 最小缺省区占位，下次调用可重试。
 */
export async function loadZones(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      applyZoneTable(await getZones());
    } catch {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

/**
 * 仅测试用：直接注入区域表（不联网），供 `zone.test.ts` 与地图/组件渲染测试替代 API。
 * `loadPromise` 同时置为 resolved，避免同一用例里再触发真实请求。
 */
export function setZonesForTest(response: CaptureZonesResponse): void {
  applyZoneTable(response);
  loadPromise = Promise.resolve();
}

/** 仅测试用：清空缓存，回到「尚未加载」的最小占位状态 */
export function resetZonesForTest(): void {
  table.value = fallbackTable();
  defaultZoneId = DEFAULT_ZONE_ID;
  loadPromise = null;
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
    /** 启动时拉取区域表（模块级单飞 + 缓存；失败不抛错，游戏用最小占位继续） */
    async load(): Promise<void> {
      await loadZones();
    },
  },
});
