import { defineStore } from 'pinia';

/**
 * 区域遇敌模型（前端口径，docs/backend-api.md §2「区域等级带」）。
 * id / 等级带 / 阶段门槛与 `backend/src/game-data/encounter.data.ts` 一一对应，
 * 另带地图 y 带（OverworldScene 的 40x30 程序化地图，y 越小越靠北）：
 * 南部 = 出生区（只出未进化型），中部可出一段进化型，北部可出二段进化型。
 */
export type ZoneId = 'south' | 'mid' | 'north';

export interface ZoneDef {
  id: ZoneId;
  name: string;
  minLevel: number;
  maxLevel: number;
  /** 入池门槛：只允许进化阶段 stage ≤ maxStage 的种族（0 = 只出未进化型） */
  maxStage: number;
  /** 地图行区间（含端点，前端口径） */
  minY: number;
  maxY: number;
}

export const MAP_HEIGHT = 30;

export const ZONES: readonly ZoneDef[] = [
  { id: 'south', name: '101 号道路·南', minLevel: 2, maxLevel: 6, maxStage: 0, minY: 20, maxY: 29 },
  { id: 'mid', name: '101 号道路·中', minLevel: 8, maxLevel: 16, maxStage: 1, minY: 10, maxY: 19 },
  { id: 'north', name: '101 号道路·北', minLevel: 17, maxLevel: 28, maxStage: 2, minY: 0, maxY: 9 },
];

export const DEFAULT_ZONE_ID: ZoneId = 'south';

export function zoneById(id: ZoneId): ZoneDef {
  return ZONES.find((z) => z.id === id) ?? ZONES[0];
}

/** 地图行 y → 区域（程序化地图 40x30；越界夹到最近的带） */
export function zoneAtY(y: number): ZoneDef {
  const row = Math.min(MAP_HEIGHT - 1, Math.max(0, Math.floor(y)));
  return ZONES.find((z) => row >= z.minY && row <= z.maxY) ?? zoneById(DEFAULT_ZONE_ID);
}

/** HUD / 提示文案：`101 号道路·南 Lv2-6` */
export function zoneLabel(zone: ZoneDef): string {
  return `${zone.name} Lv${zone.minLevel}-${zone.maxLevel}`;
}

/** 当前所在区域（OverworldScene 写入，CaptureOverlay 读取）：遇敌时随请求发给后端 */
export const useZoneStore = defineStore('zone', {
  state: () => ({ id: DEFAULT_ZONE_ID as ZoneId }),
  getters: {
    zone: (s): ZoneDef => zoneById(s.id),
    label(): string {
      return zoneLabel(this.zone);
    },
  },
  actions: {
    enter(id: ZoneId) {
      this.id = id;
    },
    enterAtY(y: number) {
      this.id = zoneAtY(y).id;
    },
  },
});
