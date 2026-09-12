import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { In, Repository } from 'typeorm';
import { RedisService } from '../common/redis/redis.service';
import { AppException } from '../common/utils/errors';
import { ContractService } from '../fabric/contract.service';
import { ChainIdentity, identityForUser, SYSTEM_IDENTITY } from '../fabric/chain.types';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { BattleRoom, BattlesService, assertTeamSize } from '../battles/battles.service';
import { OpponentPokemonDetail, enrichTeam, toOpponentTeam } from '../battles/wager-detail';
import { PokemonHpService } from '../pokemon/pokemon-hp.service';
import { RankedBattleLauncher } from './battle-launcher';
import { BOT_DAILY_LIMIT, BOT_NICKNAME, BOT_OFFER_AFTER_MS, BOT_PLAYER_ID, botDailyKey, utcDate } from './bot';
import { arenaEntryFee, arenaEntryIdemKey, arenaEntryReason, arenaEntryRefunds } from './arena';
import { MATCH_WINDOW_BASE, matchWindowFor, MATCH_WINDOW_RESET_MS } from './elo';
import {
  ArenaSettlement,
  BattleRewardOutcome,
  LeaderboardEntry,
  QueueMode,
  QueueState,
  RankedBattleRecord,
  RankedMatch,
  RankedPendingMatch,
  RankedQueueEntry,
} from './ranked.types';

/**
 * 排队有效期：入队后 300s 内没匹配到对手则本次排队超时（前端提示重新匹配）。
 * 需要长于扩圈（±200→±1000 需 160s）与机器人选项（60s）的窗口。
 */
export const QUEUE_TTL_SEC = 300;
/** 待确认对局（MATCH_PENDING）的接受期：15s */
export const MATCH_ACCEPT_MS = 15_000;
/** 待确认记录的 TTL（接受期 + 余量，超时由 status 轮询惰性回收） */
const PENDING_TTL_SEC = 60;
/** 匹配成功后给双方的入场凭据 TTL */
const MATCH_TTL_SEC = 300;
const BATTLE_RECORD_TTL_SEC = 24 * 3600;
const OUTCOME_TTL_SEC = 3600;
/** 匹配/建房临界区锁（避免两个轮询同时配对出两场战斗） */
const MATCH_LOCK_KEY = 'ranked:matchlock';
const MATCH_LOCK_TTL_SEC = 5;
/** 同一待确认对局只允许一个请求完成建房（两个 accept 并发时） */
const ACCEPT_LOCK_TTL_SEC = 15;
/** 排位房的房间记录 TTL（与 BattlesService 的 ROOM_TTL_SEC 一致） */
const RANKED_ROOM_TTL_SEC = 3600;
/** 排行缓存（链上 rating 对账 + 昵称组装后整体缓存，避免每次轮询打满链读） */
const BOARD_CACHE_KEY = 'cache:ranked:lb';
const BOARD_CACHE_TTL_SEC = 10;
const BOARD_RECONCILE_LIMIT = 100;
const BOARD_SIZE = 50;
const BOARD_SEED_LIMIT = 500;

export interface QueueStatusResult {
  state: QueueState | 'IDLE';
  /** 排队模式（casual / arena） */
  mode?: QueueMode;
  rating?: number;
  nickname?: string;
  teamPokemonIds?: string[];
  waitedMs?: number;
  /** 已等待秒数 */
  waitedSec?: number;
  /** 当前匹配窗口（±N，随时间扩圈） */
  window?: number;
  queueSize?: number;
  /** 排队满 60 秒仍无真人 → 可接受机器人对手 */
  botOffer?: boolean;
  /** 今天还能打几场机器人（0 = 已达每日上限 5 场） */
  botRemainingToday?: number;
  /** 本场准入积分（casual 恒为 0） */
  entryFee?: number;
  /** MATCH_PENDING：接受期截止（epoch ms） */
  acceptDeadline?: number;
  /** MATCH_PENDING：自己是否已接受 */
  accepted?: boolean;
  /** MATCHED：对手是机器人（奖励减半的练习赛） */
  bot?: boolean;
  roomId?: string | null;
  battleId?: string;
  opponent?: {
    playerId: string;
    nickname: string;
    rating: number;
    /** MATCH_PENDING：对手出战队伍的**裁剪**富化视图（不含 IV/EV/性格/羁绊，docs/backend-api.md §11.1） */
    team?: OpponentPokemonDetail[];
  };
  message?: string;
}

/** 排位房无押注：wager=0（排位只争 rating，不赌资产） */
const EMPTY_WAGER = (): { pokemonIds: string[]; itemIds: string[]; points: number } => ({
  pokemonIds: [],
  itemIds: [],
  points: 0,
});

/**
 * 排位赛（docs/backend-api.md §11）：Redis ZSET 匹配队列（窗口随时间扩圈）+
 * 15 秒接受期（双方 accept 才建房）+ arena 准入积分 + 机器人兜底对手。
 * 结算在 BattleRewardService；机器人出招在 RankedBotService。
 */
@Injectable()
export class RankedService {
  private readonly logger = new Logger(RankedService.name);

  constructor(
    private readonly contract: ContractService,
    private readonly redis: RedisService,
    private readonly battles: BattlesService,
    private readonly users: UsersService,
    private readonly launcher: RankedBattleLauncher,
    /** 当前 HP（链下 Redis）：入队校验"非濒死"，避免带 0 HP 宝可梦排队（docs/backend-api.md §2） */
    private readonly hp: PokemonHpService,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {}

  private queueKey(): string {
    return 'ranked:queue';
  }

  private entryKey(playerId: string): string {
    return `ranked:queue:${playerId}`;
  }

  private matchKey(playerId: string): string {
    return `ranked:match:${playerId}`;
  }

  private pendingKey(matchId: string): string {
    return `ranked:pending:${matchId}`;
  }

  private pendingOfKey(playerId: string): string {
    return `ranked:pending:of:${playerId}`;
  }

  private acceptLockKey(matchId: string): string {
    return `ranked:acceptlock:${matchId}`;
  }

  /** 排队提示（配对失败 / 对手拒绝 / 对手未接受），下次轮询读一次即清 */
  private noticeKey(playerId: string): string {
    return `ranked:notice:${playerId}`;
  }

  private errorKey(playerId: string): string {
    return `ranked:error:${playerId}`;
  }

  private battleKey(battleId: string): string {
    return `ranked:battle:${battleId}`;
  }

  outcomeKey(battleId: string): string {
    return `ranked:outcome:${battleId}`;
  }

  // ---------------------------------------------------------------- 排队 --

  /** 进入匹配队列并立刻尝试配对；返回最新排队状态。 */
  async enqueue(as: ChainIdentity, teamPokemonIds: string[], mode: QueueMode = 'casual'): Promise<QueueStatusResult> {
    await this.assertTeam(as.userId, teamPokemonIds);
    const player = await this.contract.getPlayer(as.userId).catch(() => null);
    if (!player) throw new AppException('PLAYER_NOT_FOUND', `player ${as.userId} is not registered`, HttpStatus.NOT_FOUND);
    const user = await this.users.findByUsername(as.userId).catch(() => null);
    const previous = await this.redis.getJson<RankedQueueEntry>(this.entryKey(as.userId));
    // 重新排队等于放弃待确认的对局：对手回队列（自己由下面的新条目接管）
    const pending = await this.pendingOf(as.userId);
    if (pending) {
      const opponent = pending.playerA === as.userId ? pending.playerB : pending.playerA;
      await this.endPending(pending, { drop: [as.userId], notice: { [opponent]: '对手重新排队，已回到匹配队列' } });
    }
    const entry: RankedQueueEntry = {
      playerId: as.userId,
      nickname: user?.nickname ?? as.userId,
      teamPokemonIds: [...new Set(teamPokemonIds)],
      rating: player.rating,
      joinedAt: Date.now(),
      mode,
      // 重新排队保留"刚拒绝对手"的 30s 窗口重置
      windowResetUntil: previous?.windowResetUntil,
      avoid: previous?.avoid,
      avoidUntil: previous?.avoidUntil,
    };
    await this.redis.del(this.matchKey(as.userId), this.errorKey(as.userId));
    await this.redis.setJson(this.entryKey(as.userId), entry, QUEUE_TTL_SEC);
    await this.redis.zadd(this.queueKey(), entry.rating, as.userId);
    await this.tryMatch();
    return this.status(as);
  }

  /**
   * 排队状态（前端轮询）：顺带再尝试一次配对（"轮询即匹配"）。
   * MATCH_PENDING（等双方接受）→ 带上对手与接受期；已配对 → MATCHED（带 battleId）；
   * 条目过期 → TIMEOUT。
   */
  async status(as: ChainIdentity): Promise<QueueStatusResult> {
    const playerId = as.userId;
    const matched = await this.redis.getJson<RankedMatch>(this.matchKey(playerId));
    if (matched) return this.matchedResult(playerId, matched);

    const pending = await this.pendingOf(playerId);
    if (pending) {
      // 接受期已过：按超时处理（未接受方窗口重置），然后按队列状态返回
      if (PendingExpired(pending)) await this.expirePending(pending);
      else return this.pendingResult(playerId, pending);
    }

    const failed = await this.redis.get(this.errorKey(playerId));
    if (failed) {
      await this.redis.del(this.errorKey(playerId));
      return { state: 'ERROR', message: failed };
    }

    let entry = await this.redis.getJson<RankedQueueEntry>(this.entryKey(playerId));
    if (!entry) {
      const stale = await this.redis.client.zscore(this.queueKey(), playerId);
      if (stale !== null) {
        await this.redis.client.zrem(this.queueKey(), playerId);
        return { state: 'TIMEOUT', message: `排队超过 ${QUEUE_TTL_SEC} 秒仍未匹配到对手，请重新匹配` };
      }
      return { state: 'IDLE' };
    }
    await this.tryMatch();
    const after = await this.redis.getJson<RankedMatch>(this.matchKey(playerId));
    if (after) return this.matchedResult(playerId, after);
    const pendingAfter = await this.pendingOf(playerId);
    if (pendingAfter) return this.pendingResult(playerId, pendingAfter);
    entry = (await this.redis.getJson<RankedQueueEntry>(this.entryKey(playerId))) ?? entry;
    return this.queuedStatus(entry);
  }

  /**
   * 接受匹配（15s 接受期内）。双方都接受才建房；第二个 accept 完成建房后返回 MATCHED。
   * 接受期内重复调用幂等（只置一次标志）。
   */
  async accept(as: ChainIdentity): Promise<QueueStatusResult> {
    const pending = await this.pendingOf(as.userId);
    if (!pending) return this.status(as);
    const side = pending.playerA === as.userId ? 'A' : 'B';
    if (PendingExpired(pending)) {
      await this.expirePending(pending);
      return this.status(as);
    }
    if (side === 'A') pending.acceptA = true;
    else pending.acceptB = true;
    await this.savePending(pending);

    if (pending.acceptA && pending.acceptB) {
      const lock = await this.redis
        .setNx(this.acceptLockKey(pending.matchId), '1', ACCEPT_LOCK_TTL_SEC)
        .catch(() => false);
      if (lock) {
        const fresh = await this.redis.getJson<RankedPendingMatch>(this.pendingKey(pending.matchId));
        if (fresh && !fresh.battleId) {
          fresh.acceptA = true;
          fresh.acceptB = true;
          await this.startMatch(fresh);
        }
      }
    }
    return this.status(as);
  }

  /**
   * 拒绝匹配：双方回队列，**拒绝方 30s 内匹配窗口重置为 ±200**（且 30s 内不再与该对手配对）。
   */
  async decline(as: ChainIdentity): Promise<QueueStatusResult> {
    const pending = await this.pendingOf(as.userId);
    if (!pending) return this.status(as);
    const opponent = pending.playerA === as.userId ? pending.playerB : pending.playerA;
    await this.endPending(pending, {
      reset: [as.userId],
      notice: {
        [as.userId]: `已拒绝与 ${opponent} 的对局，重新匹配中（30 秒内匹配窗口重置为 ±${MATCH_WINDOW_BASE}）`,
        [opponent]: '对手拒绝了对局，重新匹配中',
      },
    });
    return this.status(as);
  }

  /** 取消排队（已配对时不撤销对局；待确认时等于放弃并让对方回队列）。 */
  async cancel(as: ChainIdentity): Promise<QueueStatusResult> {
    const matched = await this.redis.getJson<RankedMatch>(this.matchKey(as.userId));
    if (matched) return this.status(as);
    const pending = await this.pendingOf(as.userId);
    if (pending) {
      const opponent = pending.playerA === as.userId ? pending.playerB : pending.playerA;
      await this.endPending(pending, {
        drop: [as.userId],
        notice: { [opponent]: '对手取消了对局，重新匹配中' },
      });
      return { state: 'IDLE' };
    }
    await this.redis.del(this.entryKey(as.userId));
    await this.redis.client.zrem(this.queueKey(), as.userId);
    return { state: 'IDLE' };
  }

  // ------------------------------------------------------------ 待确认对局 --

  /** 读取自己所在的待确认对局；记录已过期（TTL 到）时清理索引并返回 null。 */
  private async pendingOf(playerId: string): Promise<RankedPendingMatch | null> {
    const matchId = await this.redis.get(this.pendingOfKey(playerId));
    if (!matchId) return null;
    const pending = await this.redis.getJson<RankedPendingMatch>(this.pendingKey(matchId));
    if (!pending) {
      await this.redis.del(this.pendingOfKey(playerId));
      return null;
    }
    return pending;
  }

  private async savePending(pending: RankedPendingMatch): Promise<void> {
    await this.redis.setJson(this.pendingKey(pending.matchId), pending, PENDING_TTL_SEC);
  }

  /** 超时（15s 内没接受）：双方回队列，未接受方窗口重置并提示。 */
  private async expirePending(pending: RankedPendingMatch): Promise<void> {
    const late = [
      ...(pending.acceptA ? [] : [pending.playerA]),
      ...(pending.acceptB ? [] : [pending.playerB]),
    ];
    const notice: Record<string, string> = {};
    for (const playerId of [pending.playerA, pending.playerB]) {
      const opponent = playerId === pending.playerA ? pending.playerB : pending.playerA;
      notice[playerId] = late.includes(playerId)
        ? `未在 15 秒内接受对局，重新匹配中（匹配窗口重置为 ±200）`
        : `对手未在 15 秒内接受，重新匹配中（对手 ${opponent}）`;
    }
    this.logger.log(`ranked pending ${pending.matchId} expired (no accept from ${late.join(', ') || 'both'})`);
    await this.endPending(pending, { reset: late, notice });
  }

  /**
   * 结束待确认对局：不在 `drop` 里的玩家放回队列（`reset` 里的窗口重置、
   * 并与对手互设 30s 避让），`notice` 文案留给下次轮询。
   */
  private async endPending(
    pending: RankedPendingMatch,
    opts: { drop?: string[]; reset?: string[]; notice?: Record<string, string> },
  ): Promise<void> {
    const now = Date.now();
    for (const playerId of [pending.playerA, pending.playerB]) {
      await this.redis.del(this.pendingOfKey(playerId));
      const entry = await this.redis.getJson<RankedQueueEntry>(this.entryKey(playerId));
      if (opts.drop?.includes(playerId) || !entry) {
        await this.redis.del(this.entryKey(playerId));
        await this.redis.client.zrem(this.queueKey(), playerId);
      } else {
        const opponent = playerId === pending.playerA ? pending.playerB : pending.playerA;
        const reset = opts.reset?.includes(playerId) ?? false;
        const next: RankedQueueEntry = {
          ...entry,
          matchId: undefined,
          windowResetUntil: reset ? now + MATCH_WINDOW_RESET_MS : entry.windowResetUntil,
          avoid: reset ? opponent : entry.avoid,
          avoidUntil: reset ? now + MATCH_WINDOW_RESET_MS : entry.avoidUntil,
        };
        await this.saveEntry(next);
        await this.redis.zadd(this.queueKey(), next.rating, playerId);
      }
      const message = opts.notice?.[playerId];
      if (message) await this.redis.set(this.noticeKey(playerId), message, QUEUE_TTL_SEC);
    }
    await this.redis.del(this.pendingKey(pending.matchId));
    await this.redis.del(this.acceptLockKey(pending.matchId)).catch(() => undefined);
  }

  /** 写回排队条目并保留剩余 TTL（不因重排/回收而刷新等候时间）。 */
  private async saveEntry(entry: RankedQueueEntry): Promise<void> {
    const ttl = await this.redis.client.ttl(this.entryKey(entry.playerId)).catch(() => -1);
    await this.redis.setJson(this.entryKey(entry.playerId), entry, ttl > 0 ? ttl : QUEUE_TTL_SEC);
  }

  private queuedResult(entry: RankedQueueEntry): QueueStatusResult {
    const waitedMs = Date.now() - entry.joinedAt;
    const resetForMs = Math.max(0, (entry.windowResetUntil ?? 0) - Date.now());
    const mode = entry.mode ?? 'casual';
    return {
      state: 'QUEUED',
      mode,
      rating: entry.rating,
      nickname: entry.nickname,
      teamPokemonIds: entry.teamPokemonIds,
      waitedMs,
      waitedSec: Math.floor(waitedMs / 1000),
      window: matchWindowFor(waitedMs, { resetForMs }),
      entryFee: mode === 'arena' ? arenaEntryFee(entry.rating) : 0,
    };
  }

  private async queuedStatus(entry: RankedQueueEntry): Promise<QueueStatusResult> {
    const result = this.queuedResult(entry);
    result.queueSize = await this.redis.client.zcard(this.queueKey());
    const notice = await this.redis.get(this.noticeKey(entry.playerId));
    if (notice) {
      await this.redis.del(this.noticeKey(entry.playerId));
      result.message = notice;
    }
    if (entry.mode !== 'arena' && this.botOfferReady(entry)) {
      result.botOffer = true;
      result.botRemainingToday = await this.botRemainingToday(entry.playerId);
    }
    return result;
  }

  /** 机器人选项：排队满 60s、无真人可配（arena 模式不提供机器人）。 */
  private botOfferReady(entry: RankedQueueEntry): boolean {
    return Date.now() - entry.joinedAt >= BOT_OFFER_AFTER_MS;
  }

  /** 今天还能打几场机器人（计数键由 RankedBotService 在开局时自增） */
  private async botRemainingToday(playerId: string): Promise<number> {
    const used = Number((await this.redis.get(botDailyKey(playerId, utcDate()))) ?? 0);
    return Math.max(0, BOT_DAILY_LIMIT - (Number.isFinite(used) ? used : 0));
  }

  private async matchedResult(playerId: string, matched: RankedMatch): Promise<QueueStatusResult> {
    return {
      state: 'MATCHED',
      roomId: matched.roomId,
      battleId: matched.battleId,
      mode: matched.bot ? 'casual' : undefined,
      bot: matched.bot,
      opponent: {
        playerId: matched.opponentId,
        nickname:
          matched.opponentId === BOT_PLAYER_ID
            ? BOT_NICKNAME
            : ((await this.users.findByUsername(matched.opponentId).catch(() => null))?.nickname ??
              matched.opponentId),
        rating: matched.opponentRating,
      },
    };
  }

  private async pendingResult(playerId: string, pending: RankedPendingMatch): Promise<QueueStatusResult> {
    const side = pending.playerA === playerId ? 'A' : 'B';
    const opponentId = side === 'A' ? pending.playerB : pending.playerA;
    const opponentRating = side === 'A' ? pending.ratingB : pending.ratingA;
    const entry = await this.redis.getJson<RankedQueueEntry>(this.entryKey(playerId));
    const waitedMs = entry ? Date.now() - entry.joinedAt : 0;
    // 接受期展示对手阵容：只给公开信息（富化后裁剪掉 IV/EV/性格/羁绊）
    const opponentTeam = await enrichTeam(this.contract, await this.teamOf(pending, side === 'A' ? 'B' : 'A'));
    return {
      state: 'MATCH_PENDING',
      mode: pending.mode,
      entryFee: pending.mode === 'arena' ? arenaEntryFee(side === 'A' ? pending.ratingA : pending.ratingB) : 0,
      acceptDeadline: pending.deadline,
      accepted: side === 'A' ? pending.acceptA : pending.acceptB,
      waitedMs,
      waitedSec: Math.floor(waitedMs / 1000),
      window: entry ? matchWindowFor(waitedMs, { resetForMs: Math.max(0, (entry.windowResetUntil ?? 0) - Date.now()) }) : undefined,
      opponent: {
        playerId: opponentId,
        nickname: (await this.users.findByUsername(opponentId).catch(() => null))?.nickname ?? opponentId,
        rating: opponentRating,
        team: toOpponentTeam(opponentTeam),
      },
    };
  }

  /** 待确认对局里某一方的出战队伍 id：优先用配对时快照，旧记录（无快照）回退读其排队条目。 */
  private async teamOf(pending: RankedPendingMatch, side: 'A' | 'B'): Promise<string[]> {
    const snapshot = side === 'A' ? pending.teamA : pending.teamB;
    if (snapshot?.length) return snapshot;
    const playerId = side === 'A' ? pending.playerA : pending.playerB;
    const entry = await this.redis.getJson<RankedQueueEntry>(this.entryKey(playerId));
    return entry?.teamPokemonIds ?? [];
  }

  // ---------------------------------------------------------------- 匹配 --

  /**
   * 配对：按 rating 取队列成员，找第一对分差 ≤ 双方窗口（min(窗口A, 窗口B)）的玩家，
   * 建立**待确认对局**（双方各 15s 接受期，见 accept/decline），本身不建房。
   * 临界区由 Redis 锁串行化，重复调用只会配出一对。
   */
  async tryMatch(): Promise<string | null> {
    const acquired = await this.redis.setNx(MATCH_LOCK_KEY, String(Date.now()), MATCH_LOCK_TTL_SEC).catch(() => false);
    if (!acquired) return null;
    try {
      return await this.matchOnce();
    } finally {
      await this.redis.del(MATCH_LOCK_KEY).catch(() => undefined);
    }
  }

  private async matchOnce(): Promise<string | null> {
    const now = Date.now();
    const live: Array<{ entry: RankedQueueEntry; window: number }> = [];
    for (const { member } of await this.queueMembers()) {
      const entry = await this.redis.getJson<RankedQueueEntry>(this.entryKey(member));
      if (!entry) {
        await this.redis.client.zrem(this.queueKey(), member); // 条目已过期（TTL 到），清掉 ZSET 残留
        continue;
      }
      // 已进入接受期（快照里带 matchId）的玩家不参与配对；记录已消失时清掉残留标记
      if (entry.matchId) {
        const pending = await this.redis.getJson<RankedPendingMatch>(this.pendingKey(entry.matchId));
        if (pending) continue;
        await this.saveEntry({ ...entry, matchId: undefined });
      }
      const resetForMs = Math.max(0, (entry.windowResetUntil ?? 0) - now);
      live.push({ entry, window: matchWindowFor(now - entry.joinedAt, { resetForMs }) });
    }
    live.sort((a, b) => a.entry.rating - b.entry.rating || a.entry.joinedAt - b.entry.joinedAt);
    for (let i = 0; i < live.length; i += 1) {
      const first = live[i];
      for (let j = i + 1; j < live.length; j += 1) {
        const second = live[j];
        const gap = second.entry.rating - first.entry.rating;
        if (gap > Math.min(first.window, second.window)) break;
        if (gap > first.window) break;
        // 刚拒绝过对方的双方 30s 内不再互相配对（避免拒绝—重配的循环）
        if (this.avoided(first.entry, second.entry.playerId, now) || this.avoided(second.entry, first.entry.playerId, now)) continue;
        // 先入队者为 A（同毫秒按玩家 id 字典序）
        const a = first.entry.joinedAt <= second.entry.joinedAt ? first.entry : second.entry;
        const b = a === first.entry ? second.entry : first.entry;
        const matchId = await this.startPending(a, b);
        if (matchId) return matchId;
      }
    }
    return null;
  }

  private avoided(entry: RankedQueueEntry, opponentId: string, now: number): boolean {
    return entry.avoid === opponentId && (entry.avoidUntil ?? 0) > now;
  }

  /** Redis ZSET 全量读取（队列规模是演示级，直接在内存里按各自窗口筛）。 */
  private async queueMembers(): Promise<Array<{ member: string; score: number }>> {
    const flat = await this.redis.client.zrange(this.queueKey(), 0, -1, 'WITHSCORES');
    const out: Array<{ member: string; score: number }> = [];
    for (let i = 0; i < flat.length; i += 2) out.push({ member: flat[i], score: Number(flat[i + 1]) });
    return out;
  }

  /** 建立待确认对局（把双方从 ZSET 摘出、打上 matchId），返回 matchId。 */
  private async startPending(a: RankedQueueEntry, b: RankedQueueEntry): Promise<string | null> {
    if ((a.mode ?? 'casual') !== (b.mode ?? 'casual')) return null; // 模式不同的两人不混配
    try {
      // 配对时二次校验队伍（排队后宝可梦可能被交易/押注锁定）——失效则双方出队并带 ERROR
      await this.assertTeam(a.playerId, a.teamPokemonIds);
      await this.assertTeam(b.playerId, b.teamPokemonIds);
    } catch (err) {
      const message = `匹配失败：${(err as Error).message}`;
      this.logger.warn(`ranked pair ${a.playerId} vs ${b.playerId} rejected: ${message}`);
      await this.redis.del(this.entryKey(a.playerId), this.entryKey(b.playerId));
      await this.redis.client.zrem(this.queueKey(), a.playerId, b.playerId);
      await Promise.all([
        this.redis.set(this.errorKey(a.playerId), message, QUEUE_TTL_SEC),
        this.redis.set(this.errorKey(b.playerId), message, QUEUE_TTL_SEC),
      ]);
      return null;
    }
    const pending: RankedPendingMatch = {
      matchId: `m_${randomUUID()}`,
      mode: a.mode ?? 'casual',
      playerA: a.playerId,
      ratingA: a.rating,
      playerB: b.playerId,
      ratingB: b.rating,
      // 接受期双方可见的"对手阵容"（docs/backend-api.md §11.1）：配对时的队伍快照
      teamA: [...new Set(a.teamPokemonIds)],
      teamB: [...new Set(b.teamPokemonIds)],
      acceptA: false,
      acceptB: false,
      deadline: Date.now() + MATCH_ACCEPT_MS,
      createdAt: Date.now(),
    };
    await this.savePending(pending);
    await Promise.all([
      this.redis.set(this.pendingOfKey(a.playerId), pending.matchId, PENDING_TTL_SEC),
      this.redis.set(this.pendingOfKey(b.playerId), pending.matchId, PENDING_TTL_SEC),
      this.saveEntry({ ...a, matchId: pending.matchId }),
      this.saveEntry({ ...b, matchId: pending.matchId }),
      this.redis.client.zrem(this.queueKey(), a.playerId, b.playerId),
    ]);
    this.logger.log(
      `ranked pending ${pending.matchId}: ${a.playerId} (${a.rating}, ±${Math.abs(a.rating - b.rating)}) vs ${b.playerId} (${b.rating})`,
    );
    return pending.matchId;
  }

  /**
   * 双方接受后建房并开局。casual 走既有房间流程（`confirmWager` 双确认建房）；
   * arena 先扣双方准入（扣失败即取消建房）再自己指定 battleId 建房（见 RankedBattleLauncher）。
   * 成功写入排位房记录与双方 MATCHED 凭据；失败则双方出队并带错误提示。
   */
  private async startMatch(pending: RankedPendingMatch): Promise<string | null> {
    const entryA = await this.redis.getJson<RankedQueueEntry>(this.entryKey(pending.playerA));
    const entryB = await this.redis.getJson<RankedQueueEntry>(this.entryKey(pending.playerB));
    if (!entryA || !entryB) return null;
    const mode = pending.mode ?? 'casual';
    let battleId = `b_${randomUUID()}`;
    let roomId: string | null = null;
    let launched = false;
    let arena: ArenaSettlement | undefined;
    try {
      await this.assertTeam(pending.playerA, entryA.teamPokemonIds);
      await this.assertTeam(pending.playerB, entryB.teamPokemonIds);
      const identityA = await this.identityOf(pending.playerA);
      const identityB = await this.identityOf(pending.playerB);
      const room = await this.battles.createRoom(identityA, {
        mode: '1v1',
        wager: EMPTY_WAGER(),
        teamPokemonIds: entryA.teamPokemonIds,
      });
      await this.battles.joinRoom(identityB, room.id, {
        wager: EMPTY_WAGER(),
        teamPokemonIds: entryB.teamPokemonIds,
      });
      roomId = room.id;
      if (mode === 'arena') {
        arena = await this.chargeArenaEntries(pending, entryA, entryB, battleId);
        const [teamA, teamB] = await Promise.all([
          this.launcher.loadTeam(entryA.teamPokemonIds),
          this.launcher.loadTeam(entryB.teamPokemonIds),
        ]);
        await this.launcher.launch({ battleId, playerA: pending.playerA, playerB: pending.playerB, teamA, teamB });
        launched = true;
        await this.activateRoom(room.id, battleId);
      } else {
        await this.battles.confirmWager(identityA, room.id);
        const active = await this.battles.confirmWager(identityB, room.id);
        if (!active.battleId) throw new Error('RANKED_ROOM_NOT_ACTIVE: wager confirmation did not activate the room');
        battleId = active.battleId;
      }

      const record: RankedBattleRecord = {
        battleId,
        roomId,
        playerA: pending.playerA,
        playerB: pending.playerB,
        teamA: entryA.teamPokemonIds,
        teamB: entryB.teamPokemonIds,
        state: 'PENDING',
        mode,
        arena,
        createdAt: Date.now(),
      };
      await this.redis.setJson(this.battleKey(battleId), record, BATTLE_RECORD_TTL_SEC);
      const now = Date.now();
      await Promise.all([
        this.redis.setJson(
          this.matchKey(pending.playerA),
          {
            roomId,
            battleId,
            opponentId: pending.playerB,
            opponentRating: entryB.rating,
            at: now,
          } satisfies RankedMatch,
          MATCH_TTL_SEC,
        ),
        this.redis.setJson(
          this.matchKey(pending.playerB),
          {
            roomId,
            battleId,
            opponentId: pending.playerA,
            opponentRating: entryA.rating,
            at: now,
          } satisfies RankedMatch,
          MATCH_TTL_SEC,
        ),
      ]);
      await this.endPending(pending, { drop: [pending.playerA, pending.playerB] });
      this.logger.log(
        `ranked match ${battleId} (${mode}): ${pending.playerA} (${entryA.rating}) vs ${pending.playerB} (${entryB.rating})`,
      );
      return battleId;
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`ranked match failed for ${pending.playerA} vs ${pending.playerB}: ${message}`);
      if (arena) await this.refundArenaEntries(pending, arena, 'create-failed');
      if (launched) await this.launcher.abandon(battleId);
      if (roomId) await this.closeRoom(roomId);
      await this.endPending(pending, { drop: [pending.playerA, pending.playerB] });
      await Promise.all([
        this.redis.set(this.errorKey(pending.playerA), `匹配失败：${message}`, QUEUE_TTL_SEC),
        this.redis.set(this.errorKey(pending.playerB), `匹配失败：${message}`, QUEUE_TTL_SEC),
      ]);
      return null;
    }
  }

  /**
   * 竞技场准入扣费：**在 CreateBattle 之前**扣双方准入（AddPoints 负数，reason
   * `arena:entry:<battleId>`，幂等键按 battleId + 阵营；扣失败即取消建房）。
   * 第一方扣成功、第二方失败时会原路退回第一方。
   */
  private async chargeArenaEntries(
    pending: RankedPendingMatch,
    entryA: RankedQueueEntry,
    entryB: RankedQueueEntry,
    battleId: string,
  ): Promise<ArenaSettlement> {
    const feeA = arenaEntryFee(entryA.rating);
    const feeB = arenaEntryFee(entryB.rating);
    const reason = arenaEntryReason(battleId);
    await this.contract.addPoints(SYSTEM_IDENTITY, pending.playerA, -feeA, reason, {
      idemKey: arenaEntryIdemKey(battleId, 'A'),
    });
    try {
      await this.contract.addPoints(SYSTEM_IDENTITY, pending.playerB, -feeB, reason, {
        idemKey: arenaEntryIdemKey(battleId, 'B'),
      });
    } catch (err) {
      // 只退**已经扣成功**的第一方（第二方的扣费失败，没扣到钱）
      await this.refundArenaEntries(pending, { entryA: feeA, entryB: 0 }, 'charge-failed');
      throw err;
    }
    this.logger.log(`arena ${battleId}: entries ${pending.playerA}=${feeA}, ${pending.playerB}=${feeB}`);
    return { entryA: feeA, entryB: feeB };
  }

  /** 退款（建房取消/中途失败）：把已扣的准入原路退回，幂等。 */
  private async refundArenaEntries(
    pending: RankedPendingMatch,
    arena: ArenaSettlement,
    why: string,
  ): Promise<void> {
    for (const payout of arenaEntryRefunds({
      battleId: pending.matchId,
      playerA: pending.playerA,
      playerB: pending.playerB,
      entryA: arena.entryA,
      entryB: arena.entryB,
    })) {
      await this.contract
        .addPoints(SYSTEM_IDENTITY, payout.playerId, payout.points, payout.reason, { idemKey: payout.idemKey })
        .catch((err: Error) => this.logger.warn(`arena entry refund failed for ${payout.playerId} (${why}): ${err.message}`));
    }
  }

  /**
   * 排位房激活记账：arena 分支由排位侧指定 battleId 建房（先扣费后建房），
   * 这里把房间推到 ACTIVE 状态并推送 `battle:activated`（与 confirmWager 的收尾一致）。
   * 注意要**重读**房间（joinRoom 之后本地对象已过时）。
   */
  private async activateRoom(roomId: string, battleId: string): Promise<void> {
    const room = await this.battles.getRoom(roomId);
    const active: BattleRoom = {
      ...room,
      status: 'ACTIVE',
      battleId,
      confirmations: { A: true, B: true },
      updatedAt: new Date().toISOString(),
    };
    await this.redis.setJson(`battle:room:${roomId}`, active, RANKED_ROOM_TTL_SEC);
    await this.redis.sadd('battle:rooms', roomId);
    await this.redis.del('cache:battle:lobby');
    this.battles.events.emit('activated', {
      roomId,
      battleId,
      playerIds: [room.playerA, room.playerB].filter((id): id is string => !!id),
    });
  }

  private async closeRoom(roomId: string): Promise<void> {
    const room = await this.redis.getJson<BattleRoom>(`battle:room:${roomId}`);
    if (!room) return;
    await this.redis.setJson(
      `battle:room:${roomId}`,
      { ...room, status: 'FINISHED', updatedAt: new Date().toISOString() },
      RANKED_ROOM_TTL_SEC,
    );
    await this.redis.del('cache:battle:lobby');
  }

  async identityOf(playerId: string): Promise<ChainIdentity> {
    const user = await this.users.findByUsername(playerId).catch(() => null);
    return user ? identityForUser(user) : { mspId: 'Org1MSP', role: 'player', userId: playerId };
  }

  // ------------------------------------------------------- 机器人场（读接口） --

  /** 排队条目（机器人场需要队伍/模式/入队时间）。 */
  async queueEntry(playerId: string): Promise<RankedQueueEntry | null> {
    return this.redis.getJson<RankedQueueEntry>(this.entryKey(playerId));
  }

  /** 机器人场建房后写 MATCHED 凭据并让玩家出队（与 PvP 匹配成功同一收尾）。 */
  async recordMatched(playerId: string, matched: RankedMatch): Promise<void> {
    await this.redis.setJson(this.matchKey(playerId), matched, MATCH_TTL_SEC);
    await this.redis.del(this.entryKey(playerId));
    await this.redis.client.zrem(this.queueKey(), playerId);
  }

  /** 排位房记录（结算用；非排位对局返回 null）。 */
  async battleRecord(battleId: string): Promise<RankedBattleRecord | null> {
    return this.redis.getJson<RankedBattleRecord>(this.battleKey(battleId));
  }

  async saveBattleRecord(record: RankedBattleRecord): Promise<void> {
    await this.redis.setJson(this.battleKey(record.battleId), record, BATTLE_RECORD_TTL_SEC);
  }

  // -------------------------------------------------------- 排行榜 / 战绩 --

  /**
   * 排行榜：Redis ZSET 缓存（前 100）→ 逐个链上 rating 对账刷新 → 取前 50 +
   * 自己的名次。ZSET 为空时用 PG 用户表冷启动（链上无全量玩家查询）。
   */
  async leaderboard(as: ChainIdentity, refresh = false): Promise<{ top: LeaderboardEntry[]; me: LeaderboardEntry | null }> {
    await this.ensureBoardSeeded();
    await this.ensureMember(as.userId);
    let top = refresh ? null : await this.redis.getJson<LeaderboardEntry[]>(BOARD_CACHE_KEY);
    if (!top) {
      top = await this.rebuildBoard();
      await this.redis.setJson(BOARD_CACHE_KEY, top, BOARD_CACHE_TTL_SEC);
    }
    const me = await this.meEntry(as.userId);
    return { top: top.map((e) => ({ ...e, isMe: e.playerId === as.userId })), me };
  }

  /** 自己的排位战绩：链上 rating + wins/losses + 榜单名次。 */
  async me(as: ChainIdentity): Promise<LeaderboardEntry & { total: number }> {
    await this.ensureBoardSeeded();
    await this.ensureMember(as.userId);
    const entry = await this.meEntry(as.userId);
    const total = await this.redis.client.zcard(this.boardKey()).catch(() => 0);
    if (!entry) {
      const player = await this.contract.getPlayer(as.userId).catch(() => null);
      const user = await this.users.findByUsername(as.userId).catch(() => null);
      return {
        rank: 0,
        playerId: as.userId,
        nickname: user?.nickname ?? as.userId,
        rating: player?.rating ?? 0,
        wins: player?.wins ?? 0,
        losses: player?.losses ?? 0,
        total,
      };
    }
    return { ...entry, total };
  }

  private boardKey(): string {
    return 'ranked:lb';
  }

  /** 冷启动：链上没有全量玩家查询，用 PG 用户表把每个人按链上 rating 放上榜单。 */
  private async ensureBoardSeeded(): Promise<void> {
    const size = await this.redis.client.zcard(this.boardKey()).catch(() => 0);
    if (size > 0) return;
    const users = await this.userRepo.find({ take: BOARD_SEED_LIMIT }).catch(() => []);
    for (const user of users) {
      if (user.username === BOT_PLAYER_ID) continue; // 机器人不上榜
      const player = await this.contract.getPlayer(user.username).catch(() => null);
      if (player) await this.redis.zadd(this.boardKey(), player.rating, user.username);
    }
  }

  private async ensureMember(playerId: string): Promise<void> {
    if (playerId === BOT_PLAYER_ID) return;
    const score = await this.redis.client.zscore(this.boardKey(), playerId).catch(() => null);
    if (score !== null) return;
    const player = await this.contract.getPlayer(playerId).catch(() => null);
    if (player) await this.redis.zadd(this.boardKey(), player.rating, playerId);
  }

  /** 前 100 名逐个与链上 rating 对账（链为准），组装昵称后取前 50。 */
  private async rebuildBoard(): Promise<LeaderboardEntry[]> {
    const members = (await this.redis.zrevrangeWithScores(this.boardKey(), 0, BOARD_RECONCILE_LIMIT - 1)).filter(
      (m) => m.member !== '' && m.member !== BOT_PLAYER_ID,
    );
    const rows: Array<Omit<LeaderboardEntry, 'rank' | 'nickname' | 'isMe'>> = [];
    for (const { member, score } of members) {
      const player = await this.contract.getPlayer(member).catch(() => null);
      if (!player) continue;
      if (player.rating !== score) await this.redis.zadd(this.boardKey(), player.rating, member);
      rows.push({ playerId: member, rating: player.rating, wins: player.wins, losses: player.losses });
    }
    rows.sort((a, b) => b.rating - a.rating || a.playerId.localeCompare(b.playerId));
    const top = rows.slice(0, BOARD_SIZE);
    const nicknames = await this.nicknames(top.map((r) => r.playerId));
    return top.map((row, i) => ({ rank: i + 1, nickname: nicknames.get(row.playerId) ?? row.playerId, ...row }));
  }

  private async meEntry(playerId: string): Promise<LeaderboardEntry | null> {
    const rank = await this.redis.client.zrevrank(this.boardKey(), playerId).catch(() => null);
    if (rank === null) return null;
    const player = await this.contract.getPlayer(playerId).catch(() => null);
    if (!player) return null;
    const nicknames = await this.nicknames([playerId]);
    return {
      rank: rank + 1,
      playerId,
      nickname: nicknames.get(playerId) ?? playerId,
      rating: player.rating,
      wins: player.wins,
      losses: player.losses,
    };
  }

  private async nicknames(playerIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (playerIds.length === 0) return map;
    try {
      const users = await this.userRepo.find({ where: { username: In(playerIds) } });
      for (const user of users) map.set(user.username, user.nickname || user.username);
    } catch {
      /* 昵称只是展示信息，取不到就回退 playerId */
    }
    return map;
  }

  // ------------------------------------------------------------- 结算面板 --

  /** 结算面板用：本局排位/羁绊变化（尚未应用时 status=PENDING）。 */
  async outcome(battleId: string): Promise<Partial<BattleRewardOutcome> & { status?: string }> {
    const stored = await this.redis.getJson<BattleRewardOutcome>(this.outcomeKey(battleId));
    if (stored) return stored;
    const pending = await this.redis.get(`rewards:pending:${battleId}`);
    if (pending) return { status: 'PENDING', battleId };
    return { status: 'NONE', battleId };
  }

  /**
   * 队伍校验：每只宝可梦必须属于本人、IDLE **且非濒死**（机器人场同样只校验玩家一方）。
   * 濒死（0 HP）在建房时会被链上流程拒绝并让双方回队列，故入队即拦截并指明是哪只
   * （伤势持久化，docs/backend-api.md §2）。
   */
  async assertTeam(playerId: string, pokemonIds: string[]): Promise<void> {
    // 队伍规模 1-6（与房间创建/加入同一口径）：违规 400 INVALID_TEAM_SIZE
    assertTeamSize(pokemonIds);
    for (const id of [...new Set(pokemonIds)]) {
      const pokemon = await this.contract.getPokemon(id).catch(() => null);
      if (!pokemon || pokemon.ownerId !== playerId) {
        throw new AppException('NOT_OWNER', `pokemon ${id} is not owned by ${playerId}`, HttpStatus.FORBIDDEN);
      }
      if (pokemon.status !== 'IDLE') {
        throw new AppException('ASSET_LOCKED', `pokemon ${id} is ${pokemon.status}`, HttpStatus.CONFLICT);
      }
      if ((await this.hp.currentHp(pokemon)) <= 0) {
        throw new AppException(
          'FAINTED',
          `pokemon ${id} (${pokemon.name}) has fainted; heal it at the pokemon center before queueing`,
          HttpStatus.CONFLICT,
        );
      }
    }
  }
}

function PendingExpired(pending: RankedPendingMatch): boolean {
  return pending.deadline <= Date.now();
}
