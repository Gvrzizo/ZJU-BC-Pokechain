// 排位 / 羁绊链下状态（Redis）与对外契约，见 docs/backend-api.md §11。
import type { ArenaPayout, ArenaSubsidyBlock } from './arena';

export type QueueState = 'QUEUED' | 'MATCH_PENDING' | 'MATCHED' | 'TIMEOUT' | 'ERROR';

/** 排队模式：casual=只争 rating；arena=积分场（准入积分按段位收，胜者通吃 + 补贴） */
export type QueueMode = 'casual' | 'arena';

/** Redis `ranked:queue:<playerId>`（TTL 300s）——排队中的玩家 */
export interface RankedQueueEntry {
  playerId: string;
  nickname: string;
  teamPokemonIds: string[];
  /** 入队时的链上 rating（匹配窗口用） */
  rating: number;
  joinedAt: number;
  /** 排队模式（旧条目缺字段按 casual） */
  mode?: QueueMode;
  /** 拒绝/超时未接受对局后，`windowResetUntil` 之前窗口重置为 ±200 */
  windowResetUntil?: number;
  /** 刚拒绝过的对手（`avoidUntil` 之前不再与该对手配对） */
  avoid?: string;
  avoidUntil?: number;
  /** 已进入 MATCH_PENDING：指向待确认对局，期间不再参与配对 */
  matchId?: string;
}

/**
 * Redis `ranked:pending:<matchId>`（TTL 60s）——已配对、等待双方 15s 内接受的对局。
 * 双方都 accept 后才建房；任一方 decline / 超时 → 双方回队列。
 */
export interface RankedPendingMatch {
  matchId: string;
  mode: QueueMode;
  playerA: string;
  ratingA: number;
  playerB: string;
  ratingB: number;
  /** 配对时的出战队伍快照：接受期 `GET /ranked/queue/status` 展示对手阵容用（旧记录可缺） */
  teamA?: string[];
  teamB?: string[];
  acceptA: boolean;
  acceptB: boolean;
  /** 接受期截止（epoch ms，15s） */
  deadline: number;
  createdAt: number;
  /** 双方都接受后写入的战果凭据（同一记录同时充当幂等标记） */
  battleId?: string;
  roomId?: string | null;
}

/** Redis `ranked:match:<playerId>`（TTL 300s）——匹配成功后给双方的入场凭据 */
export interface RankedMatch {
  /** 机器人场没有房间（机器人无链上资产），为 null */
  roomId: string | null;
  battleId: string;
  opponentId: string;
  opponentRating: number;
  at: number;
  /** 机器人场标记（前端展示"练习赛"与奖励减半提示） */
  bot?: boolean;
}

/** 积分场结算留痕（`ranked:battle:<battleId>.arena`，首次结算时固化计划） */
export interface ArenaSettlement {
  entryA: number;
  entryB: number;
  plan?: {
    winnerId: string;
    /** 实际发放的系统补贴（0 = 不发） */
    subsidy: number;
    /** 补贴受益者（无补贴为 null） */
    subsidyTo: string | null;
    /** 不发补贴的原因（防刷规则命中时记录） */
    subsidyBlocked?: ArenaSubsidyBlock;
    payouts: ArenaPayout[];
  };
  /** 结算已应用（展示用） */
  applied?: boolean;
}

/** Redis `ranked:battle:<battleId>`（TTL 24h）——排位房与结算计划的留痕 */
export interface RankedBattleRecord {
  battleId: string;
  /** 机器人场没有房间 */
  roomId: string | null;
  playerA: string;
  playerB: string;
  teamA: string[];
  teamB: string[];
  state: 'PENDING' | 'PLANNED' | 'APPLIED';
  /** 排队模式（旧记录缺字段按 casual） */
  mode?: QueueMode;
  /** 机器人对局：奖励一律 ×0.5（seed/队伍留痕供复核） */
  bot?: { seed: string; mons: Array<{ speciesId: number; level: number }> };
  /** 积分场：准入额与结算计划 */
  arena?: ArenaSettlement;
  /** 首次结算时计算的 ELO 计划（重放时按同一组数值提交，保证幂等） */
  plan?: {
    A: { before: number; after: number };
    B: { before: number; after: number };
  };
  createdAt: number;
}

/** Redis `rewards:pending:<battleId>`（TTL 24h）——等待链上 SETTLED 的对局结算待办 */
export interface PendingBattleReward {
  battleId: string;
  roomId: string | null;
  playerA: string;
  playerB: string;
  teamA: string[];
  teamB: string[];
  createdAt: number;
}

export interface RatingChange {
  playerId: string;
  before: number;
  after: number;
  delta: number;
}

/** 一只宝可梦的羁绊变化（仅列出真正被提升的） */
export interface BondChange {
  pokemonId: string;
  speciesId: number;
  name: string;
  side: 'A' | 'B';
  result: 'WIN' | 'LOSS' | 'DRAW';
  before: number;
  after: number;
  delta: number;
}

/** Redis `ranked:outcome:<battleId>`（TTL 1h）——结算面板展示的排位/羁绊变化 */
export interface BattleRewardOutcome {
  battleId: string;
  ranked: boolean;
  winnerId: string;
  settledAt: string;
  ratings: RatingChange[];
  bonds: BondChange[];
  /** 机器人场（ELO/羁绊/经验减半） */
  bot?: boolean;
  /** 积分场结算明细（准入 / 补贴 / 发奖） */
  arena?: ArenaSettlement;
}

export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  nickname: string;
  rating: number;
  wins: number;
  losses: number;
  isMe?: boolean;
}
