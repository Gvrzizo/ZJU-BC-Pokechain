/**
 * 积分场（stakes arena）口径（docs/backend-api.md §10/§11）：
 * 准入积分按段位收，胜者拿走双方准入（H12 起不再叠加系统补贴，零和），平局退还各自准入。
 *
 * 防刷限制（补贴发放前逐条判定，任一命中即不发）：
 *   - 每人每天最多领 3 次补贴（Redis SET `ranked:subsidy:<player>:<yyyy-mm-dd>`，SCARD 计数）；
 *   - 对局双方 rating 差 > 400 不发（扩圈匹配可能配出大分差对手）；
 *   - 机器人场不发（机器人对局本来也不支持 arena 模式）。
 */
export type ArenaTierKey = 'bronze' | 'silver' | 'gold' | 'platinum' | 'master';

/** 段位分数线（与 elo.ts / 前端 RANK_TIERS 同口径：含下界） */
export const ARENA_TIER_MINS: ReadonlyArray<{ key: ArenaTierKey; min: number }> = [
  { key: 'bronze', min: 0 },
  { key: 'silver', min: 1200 },
  { key: 'gold', min: 1400 },
  { key: 'platinum', min: 1600 },
  { key: 'master', min: 1800 },
];

/** 准入积分（按段位） */
export const ARENA_ENTRY_FEES: Record<ArenaTierKey, number> = {
  bronze: 20,
  silver: 50,
  gold: 100,
  platinum: 200,
  master: 400,
};

/**
 * 系统补贴 = 准入额 × 该系数（向下取整）。
 * H12（2026-10）：改为 **0**——积分场不再增发，胜者只拿双方入场费（零和转移）。
 * 原有「每日 3 次 / 分差 >400 / 机器人场不发」判定保留，未来若要恢复补贴只需调这个系数。
 */
export const ARENA_SUBSIDY_RATIO = 0;
/** 每人每天的补贴上限（次数） */
export const ARENA_SUBSIDY_DAILY_LIMIT = 3;
/** 对手 rating 差超过该值不发补贴 */
export const ARENA_SUBSIDY_MAX_RATING_GAP = 400;

export function arenaTierOf(rating: number): ArenaTierKey {
  let tier: ArenaTierKey = ARENA_TIER_MINS[0].key;
  for (const row of ARENA_TIER_MINS) {
    if (rating >= row.min) tier = row.key;
  }
  return tier;
}

/** 该 rating 的准入积分（段位决定） */
export function arenaEntryFee(rating: number): number {
  return ARENA_ENTRY_FEES[arenaTierOf(rating)];
}

/** 系统补贴额（准入额 50% 向下取整） */
export function arenaSubsidyFor(entryFee: number): number {
  return Math.floor(entryFee * ARENA_SUBSIDY_RATIO);
}

export type ArenaSubsidyBlock = 'DAILY_LIMIT' | 'RATING_GAP' | 'BOT';

/** 补贴资格判定（纯函数，输入都是结算时已知的确定值） */
export function arenaSubsidyDecision(input: {
  subsidy: number;
  ratingGap: number;
  bot: boolean;
  /** 受益方当天已领补贴次数（含本场前的计数） */
  dailyUsed: number;
}): { grant: boolean; blocked?: ArenaSubsidyBlock } {
  if (input.subsidy <= 0) return { grant: false, blocked: undefined };
  if (input.bot) return { grant: false, blocked: 'BOT' };
  if (input.ratingGap > ARENA_SUBSIDY_MAX_RATING_GAP) return { grant: false, blocked: 'RATING_GAP' };
  if (input.dailyUsed >= ARENA_SUBSIDY_DAILY_LIMIT) return { grant: false, blocked: 'DAILY_LIMIT' };
  return { grant: true };
}

/** 一笔积分发放（结算计划里固化，重放按同一组数值 + 同一幂等键提交） */
export interface ArenaPayout {
  playerId: string;
  points: number;
  reason: string;
  idemKey: string;
}

/**
 * 一局 arena 的结算计划：
 * - 有胜者：胜者得 `entryA + entryB + subsidy`（reason `arena:reward:<battleId>`）；
 * - 平局：双方各自取回准入（reason `arena:refund:<battleId>`）。
 */
export function arenaPayouts(input: {
  battleId: string;
  playerA: string;
  playerB: string;
  entryA: number;
  entryB: number;
  /** 链上 result.winnerId；平局为 'DRAW' 或空串 */
  winnerId: string;
  subsidy: number;
}): ArenaPayout[] {
  const { battleId, playerA, playerB, entryA, entryB } = input;
  if (input.winnerId === playerA || input.winnerId === playerB) {
    const points = entryA + entryB + Math.max(0, input.subsidy);
    return points > 0
      ? [
          {
            playerId: input.winnerId,
            points,
            reason: `arena:reward:${battleId}`,
            idemKey: `${battleId}-arena-reward`,
          },
        ]
      : [];
  }
  return [
    { playerId: playerA, points: entryA, reason: `arena:refund:${battleId}`, idemKey: `${battleId}-arena-refund-A` },
    { playerId: playerB, points: entryB, reason: `arena:refund:${battleId}`, idemKey: `${battleId}-arena-refund-B` },
  ].filter((payout) => payout.points > 0);
}

/** 退款（对局取消 / 仲裁 REFUND）：把双方的准入原路退回 */
export function arenaEntryRefunds(input: {
  battleId: string;
  playerA: string;
  playerB: string;
  entryA: number;
  entryB: number;
}): ArenaPayout[] {
  return [
    {
      playerId: input.playerA,
      points: input.entryA,
      reason: `arena:entry-refund:${input.battleId}`,
      idemKey: `${input.battleId}-arena-entry-refund-A`,
    },
    {
      playerId: input.playerB,
      points: input.entryB,
      reason: `arena:entry-refund:${input.battleId}`,
      idemKey: `${input.battleId}-arena-entry-refund-B`,
    },
  ].filter((payout) => payout.points > 0);
}

/** 准入扣费的链上 reason 与幂等键（accept 时冻结，重试不重复扣） */
export function arenaEntryReason(battleId: string): string {
  return `arena:entry:${battleId}`;
}

export function arenaEntryIdemKey(battleId: string, side: 'A' | 'B'): string {
  return `${battleId}-arena-entry-${side}`;
}

/**
 * 补贴计数键（每人每天）：SET 里放当天已领补贴的 battleId，
 * SCARD 即次数——重放同一场战斗不会重复计数（幂等），比 INCR 更适合结算重试。
 */
export function subsidyDailyKey(playerId: string, date: string): string {
  return `ranked:subsidy:${playerId}:${date}`;
}
