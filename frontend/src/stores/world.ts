import { defineStore } from 'pinia';
import { MAPS, START_MAP_ID, getMapDef, isLegendaryMap, type MapId } from '@/game/maps';
import { useZoneStore, zoneById, zoneHint, zoneLabel, type LegendaryZoneDef, type ZoneDef } from '@/stores/zone';

/**
 * 世界状态（OverworldScene 写入，GameView/WorldHud 读取）：
 * 当前地图、坐标、区域提示、跨图横幅，以及"上次所在位置"的本地记忆
 * （去道具店/背包再回 /game 时从原地继续，不必从镇口重走）。
 */
export interface WorldPosition {
  mapId: MapId;
  x: number;
  y: number;
}

export interface WorldBanner {
  seq: number;
  title: string;
  subtitle: string;
  tone: 'normal' | 'legendary';
}

export const WORLD_SPAWN_STORAGE_KEY = 'pokechain.world.spawn';

interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 读取上次所在位置（地图/坐标）；无记录或数据损坏返回 null */
export function readStoredSpawn(storage: Storage | null = defaultStorage()): WorldPosition | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(WORLD_SPAWN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WorldPosition>;
    if (typeof parsed?.mapId !== 'string' || !(parsed.mapId in MAPS)) return null;
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { mapId: parsed.mapId as MapId, x, y };
  } catch {
    return null;
  }
}

export function storeSpawn(pos: WorldPosition, storage: Storage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(WORLD_SPAWN_STORAGE_KEY, JSON.stringify(pos));
  } catch {
    /* 存不进去只影响下次续玩的位置 */
  }
}

export const useWorldStore = defineStore('world', {
  state: () => ({
    mapId: START_MAP_ID as MapId,
    position: { x: MAPS[START_MAP_ID].spawn.x, y: MAPS[START_MAP_ID].spawn.y },
    banner: null as WorldBanner | null,
    bannerSeq: 0,
  }),
  getters: {
    map: (s) => getMapDef(s.mapId),
    mapName(): string {
      return this.map.name;
    },
    zone(): ZoneDef {
      return zoneById(this.map.zoneId);
    },
    /** `101 号道路 Lv2-6` / `天空之柱`（传说区没有等级带） */
    zoneLabel(): string {
      return zoneLabel(this.zone);
    },
    zoneHint(): string {
      return zoneHint(this.zone);
    },
    /** 传说区定义（非传说区为 null） */
    legendary(): LegendaryZoneDef | null {
      return this.zone.legendary ?? null;
    },
    /** 本图是否真的能遇到传说（塔 1F 这种"传说区但没有祭坛"的图不算） */
    legendaryCatchable(): boolean {
      return !!this.map.encounter && !!this.zone.legendary;
    },
    isLegendaryArea: (s): boolean => isLegendaryMap(s.mapId),
    /** 传说区 HUD 的配色档位：普通 / 传说 */
    tone(): 'normal' | 'legendary' {
      return this.legendaryCatchable ? 'legendary' : 'normal';
    },
  },
  actions: {
    /**
     * 进入地图（OverworldScene 的 create 与每次落脚时调用）。
     * 同步遇敌区域（CaptureOverlay 按它请求后端）与本地位置记忆；`announce` 为真时弹横幅。
     */
    enterMap(payload: { mapId: MapId; x: number; y: number; announce?: boolean }) {
      this.mapId = payload.mapId;
      this.position = { x: payload.x, y: payload.y };
      useZoneStore().enter(this.map.zoneId);
      storeSpawn({ mapId: payload.mapId, x: payload.x, y: payload.y });
      if (payload.announce) this.announceMap();
    },
    /** 只更新坐标（同一张图内走路，不重复弹横幅） */
    moveTo(x: number, y: number) {
      this.position = { x, y };
      storeSpawn({ mapId: this.mapId, x, y });
    },
    announceMap() {
      const map = this.map;
      const legendary = this.legendary;
      const catchable = this.legendaryCatchable;
      this.bannerSeq += 1;
      this.banner = {
        seq: this.bannerSeq,
        title: map.name,
        subtitle: catchable
          ? `传说宝可梦的气息…（可捕捉：${legendary?.name ?? ''}）`
          : map.intro ?? zoneHint(this.zone) ?? '',
        tone: catchable ? 'legendary' : 'normal',
      };
    },
    clearBanner(seq: number) {
      if (this.banner?.seq === seq) this.banner = null;
    },
  },
});
