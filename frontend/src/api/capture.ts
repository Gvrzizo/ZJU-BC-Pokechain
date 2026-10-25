import { http } from './http';
import type { ZoneId } from '@/stores/zone';
import type { CaptureResult, CaptureZonesResponse, WildEncounter } from '@/types';

/**
 * 付费诱饵档位（与后端 `backend/src/pokemon/capture-derive.ts` 的 LURE_TIERS 对齐）：
 * 0 免费 / 1 = 50 积分（带内 +2 级）/ 2 = 200 积分（带内 +5 级、闪光概率 ×4）。
 * 等级加成只在**区域内**生效并封顶区域上界（docs/backend-api.md §2「区域等级带」）。
 */
export interface LureOption {
  tier: 0 | 1 | 2;
  nameZh: string;
  cost: number;
  levelBonus: number;
  shinyMultiplier: number;
}

export const LURE_TIERS: LureOption[] = [
  { tier: 0, nameZh: '不投放', cost: 0, levelBonus: 0, shinyMultiplier: 1 },
  { tier: 1, nameZh: '普通诱饵', cost: 50, levelBonus: 2, shinyMultiplier: 1 },
  { tier: 2, nameZh: '高级诱饵', cost: 200, levelBonus: 5, shinyMultiplier: 4 },
];

/** 遇敌响应：在共享类型上补充区域（等级带 / 阶段门槛）与诱饵 */
export interface WildEncounterResult extends WildEncounter {
  zone: { id: ZoneId; name: string; minLevel: number; maxLevel: number; maxStage: number };
  lure: { tier: number; cost: number; levelBonus: number; shinyMultiplier: number };
}

/**
 * 区域表（docs/backend-api.md §2）：普通区 7 + 传说区 6 + 缺省区/旧别名。
 * 前端不再镜像 `backend/src/game-data/encounter.data.ts`，启动时拉取一次即可。
 */
export async function getZones(): Promise<CaptureZonesResponse> {
  const { data } = await http.get<CaptureZonesResponse>('/capture/zones');
  return data;
}

export async function encounter(
  clientSeed?: string,
  lureTier = 0,
  zoneId?: ZoneId,
): Promise<WildEncounterResult> {
  const { data } = await http.post<WildEncounterResult>('/capture/encounter', {
    clientSeed,
    lureTier,
    zoneId,
  });
  return data;
}

export async function attemptCapture(
  eventId: string,
  ballItemId: string,
): Promise<CaptureAttemptResult> {
  const { data } = await http.post<CaptureAttemptResult>('/capture/attempt', {
    eventId,
    ballItemId,
  });
  return data;
}

/** 成功时后端随响应返回的积分奖励（+20，见 docs/backend-api.md §10「积分经济」） */
export interface CaptureAttemptResult extends CaptureResult {
  catchReward?: number;
}
