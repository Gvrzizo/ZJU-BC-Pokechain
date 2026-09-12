import { http } from './http';
import type {
  BattleRewardOutcome,
  RankedEntry,
  RankedLeaderboard,
  RankedQueueMode,
  RankedQueueStatus,
} from '@/types';

/** 段位键（文案在 locales：ranked.tier.<key>） */
export type RankTierKey = 'bronze' | 'silver' | 'gold' | 'platinum' | 'master';

export interface RankTier {
  key: RankTierKey;
  /** 含下界，不含上界 */
  min: number;
  max: number;
  /** 徽章底色（像素风） */
  color: string;
}

/** 段位表与后端 docs/backend-api.md §11 / backend/src/ranked/elo.ts 一致 */
export const RANK_TIERS: RankTier[] = [
  { key: 'bronze', min: 0, max: 1200, color: '#a9663a' },
  { key: 'silver', min: 1200, max: 1400, color: '#b9c2cc' },
  { key: 'gold', min: 1400, max: 1600, color: '#e6c53c' },
  { key: 'platinum', min: 1600, max: 1800, color: '#7fd6e8' },
  { key: 'master', min: 1800, max: 100000, color: '#d05ce3' },
];

/** 积分场准入积分（按段位收；与 backend/src/ranked/arena.ts 一致） */
export const ARENA_ENTRY_FEES: Record<RankTierKey, number> = {
  bronze: 20,
  silver: 50,
  gold: 100,
  platinum: 200,
  master: 400,
};

export function arenaEntryFor(rating: number): number {
  return ARENA_ENTRY_FEES[tierOf(rating).key];
}

/** 系统补贴 = 准入额 ×50%（向下取整） */
export function arenaSubsidyFor(entryFee: number): number {
  return Math.floor(entryFee * 0.5);
}

export function tierOf(rating: number): RankTier {
  return RANK_TIERS.find((tier) => rating >= tier.min && rating < tier.max) ?? RANK_TIERS[0];
}

/** 距下一段位还差多少分（最高段位返回 null） */
export function nextTier(rating: number): { tier: RankTier; points: number } | null {
  const idx = RANK_TIERS.findIndex((tier) => tier.key === tierOf(rating).key);
  const next = RANK_TIERS[idx + 1];
  return next ? { tier: next, points: Math.max(0, next.min - rating) } : null;
}

/** 段位内的进度百分比（0-100），用于进度条 */
export function tierProgress(rating: number): number {
  const tier = tierOf(rating);
  if (tier.max >= 100000) return 100;
  const span = tier.max - tier.min;
  return Math.max(0, Math.min(100, ((rating - tier.min) / span) * 100));
}

/** 进匹配队列（响应即最新状态；已在队列时重复调用等价于刷新）。
 * `mode='arena'` 走积分场（按段位收准入积分，双方接受后才扣）。 */
export async function enqueueRanked(
  teamPokemonIds: string[],
  mode: RankedQueueMode = 'casual',
): Promise<RankedQueueStatus> {
  const { data } = await http.post<RankedQueueStatus>('/ranked/queue', { teamPokemonIds, mode });
  return data;
}

/** 排队状态轮询（服务端每次都会再尝试配对；MATCH_PENDING 带接受期，MATCHED 带 battleId） */
export async function rankedQueueStatus(): Promise<RankedQueueStatus> {
  const { data } = await http.get<RankedQueueStatus>('/ranked/queue/status');
  return data;
}

/** 接受匹配（15 秒接受期内；双方都接受才建房） */
export async function acceptRankedMatch(): Promise<RankedQueueStatus> {
  const { data } = await http.post<RankedQueueStatus>('/ranked/queue/accept', {});
  return data;
}

/** 拒绝匹配（双方回队列，自己 30 秒内匹配窗口重置为 ±200） */
export async function declineRankedMatch(): Promise<RankedQueueStatus> {
  const { data } = await http.post<RankedQueueStatus>('/ranked/queue/decline', {});
  return data;
}

/** 接受机器人对手（排队满 60 秒；每天 5 场，奖励减半） */
export async function acceptRankedBot(): Promise<RankedQueueStatus> {
  const { data } = await http.post<RankedQueueStatus>('/ranked/queue/accept-bot', {});
  return data;
}

export async function cancelRankedQueue(): Promise<RankedQueueStatus> {
  const { data } = await http.delete<RankedQueueStatus>('/ranked/queue');
  return data;
}

/** 排行榜（前 50 + 自己名次）；refresh=true 跳过 10s 缓存 */
export async function getRankedLeaderboard(refresh = false): Promise<RankedLeaderboard> {
  const { data } = await http.get<RankedLeaderboard>('/ranked/leaderboard', {
    params: refresh ? { refresh: '1' } : undefined,
  });
  return data;
}

/** 我的排位：rating / 战绩 / 名次 */
export async function getRankedMe(): Promise<RankedEntry> {
  const { data } = await http.get<RankedEntry>('/ranked/me');
  return data;
}

/** 结算面板：本局 rating 与羁绊变化（服务端应用前返回 status='PENDING'） */
export async function getBattleRewardOutcome(battleId: string): Promise<BattleRewardOutcome> {
  const { data } = await http.get<BattleRewardOutcome>(
    `/ranked/battles/${encodeURIComponent(battleId)}/outcome`,
  );
  return data;
}
