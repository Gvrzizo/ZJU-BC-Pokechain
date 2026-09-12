import { http } from './http';
import type { CaptureResult, WildEncounter } from '@/types';

/**
 * 付费诱饵档位（与后端 `backend/src/pokemon/capture-derive.ts` 的 LURE_TIERS 对齐）：
 * 0 免费 / 1 = 50 积分（野怪 +5 级）/ 2 = 200 积分（+10 级、闪光概率 ×4）。
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
  { tier: 1, nameZh: '普通诱饵', cost: 50, levelBonus: 5, shinyMultiplier: 1 },
  { tier: 2, nameZh: '高级诱饵', cost: 200, levelBonus: 10, shinyMultiplier: 4 },
];

/** 遇敌响应：在共享类型上补充诱饵与实际使用的队伍水平线 */
export interface WildEncounterResult extends WildEncounter {
  lure: { tier: number; cost: number; levelBonus: number; shinyMultiplier: number };
  teamTopLevel: number;
}

export async function encounter(clientSeed?: string, lureTier = 0): Promise<WildEncounterResult> {
  const { data } = await http.post<WildEncounterResult>('/capture/encounter', {
    clientSeed,
    lureTier,
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
