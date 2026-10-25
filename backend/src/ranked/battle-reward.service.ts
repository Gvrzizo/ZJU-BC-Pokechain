import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../common/redis/redis.service';
import { ContractService } from '../fabric/contract.service';
import { SYSTEM_IDENTITY } from '../fabric/chain.types';
import { BattlesService, BattleSettledEvent } from '../battles/battles.service';
import { BATTLE_WIN_EXP_GAIN, PokemonService } from '../pokemon/pokemon.service';
import { BondService } from '../bond/bond.service';
import { RankedService } from './ranked.service';
import { eloUpdate, RankedOutcome, scaleElo } from './elo';
import { BOT_RATING_SCALE, BOT_REWARD_SCALE, utcDate } from './bot';
import {
  arenaEntryRefunds,
  arenaPayouts,
  arenaSubsidyDecision,
  arenaSubsidyFor,
  ArenaPayout,
  subsidyDailyKey,
} from './arena';
import {
  ArenaSettlement,
  BattleRewardOutcome,
  PendingBattleReward,
  RankedBattleRecord,
  RatingChange,
} from './ranked.types';

const PENDING_SET = 'rewards:pending';
const PENDING_TTL_SEC = 24 * 3600;
/** 结算应用临界区锁：同一场战斗同一时刻只由一个请求应用（链上幂等键是第二道保险） */
const APPLY_LOCK_KEY = (battleId: string) => `rewards:lock:${battleId}`;
const APPLY_LOCK_TTL_SEC = 60;
const SWEEP_BATCH = 50;
/** 补贴计数键 TTL：两天（跨天后自然失效） */
const SUBSIDY_TTL_SEC = 2 * 24 * 3600;

/**
 * 对局结算后的奖励挂钩（docs/backend-api.md §11）：
 * - 羁绊：任意 PvP 对局 SETTLED 后，双方参战队伍 +2/+1（BondService，幂等；机器人场减半 ×0.5 向下取整，每日每宠上限 +6）；
 * - 排位：排位房按 ELO 更新双方 rating（reason=`ranked:<battleId>`，幂等；机器人场减半）；
 * - 机器人场：胜者参战队伍经验 ×0.5（30 → 15，幂等键 `<battleId>-exp-<pokemonId>`）；
 * - 积分场（arena）：胜者拿双方准入 + 系统补贴（`arena:reward:<battleId>`），平局各自退还准入。
 *
 * 触发来源：BattlesService 在对局 settle 后广播 `settled` 事件（含参战队伍）。
 * 广播到达时链上可能还是 RESULT_SUBMITTED（等双方确认 / 兜底结算），此时只登记待办，
 * 由 sweep 定时器在链上 SETTLED 后补应用——兜底结算、服务重启都不会漏发。
 */
@Injectable()
export class BattleRewardService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BattleRewardService.name);
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly battles: BattlesService,
    private readonly contract: ContractService,
    private readonly redis: RedisService,
    private readonly ranked: RankedService,
    private readonly bonds: BondService,
    private readonly pokemon: PokemonService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.battles.events.on('settled', (payload: BattleSettledEvent) => {
      void this.onSettled(payload);
    });
    const sweepMs = this.config.get<number>('ranked.sweepMs') ?? 30_000;
    this.sweepTimer = setInterval(() => void this.sweep(), sweepMs);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** 对局 settle 广播：登记待办（含参战队伍）后立刻尝试应用。 */
  async onSettled(payload: BattleSettledEvent): Promise<void> {
    if (!payload?.battleId) return;
    const pending: PendingBattleReward = {
      battleId: payload.battleId,
      roomId: payload.roomId ?? null,
      playerA: payload.playerA,
      playerB: payload.playerB,
      teamA: payload.teamA ?? [],
      teamB: payload.teamB ?? [],
      createdAt: Date.now(),
    };
    await this.redis.setJson(`rewards:pending:${payload.battleId}`, pending, PENDING_TTL_SEC).catch(() => undefined);
    await this.redis.sadd(PENDING_SET, payload.battleId).catch(() => undefined);
    await this.settle(payload.battleId);
  }

  /**
   * 应用一场战斗的排位/羁绊/积分场奖励（幂等，可重复调用）：
   * 链上不是 SETTLED 时保持待办；REFUNDED（仲裁退款）不发奖，只退积分场准入并出列。
   */
  async settle(battleId: string): Promise<BattleRewardOutcome | null> {
    const lock = await this.redis.setNx(APPLY_LOCK_KEY(battleId), '1', APPLY_LOCK_TTL_SEC).catch(() => false);
    if (!lock) return null;
    try {
      const pending = await this.redis.getJson<PendingBattleReward>(`rewards:pending:${battleId}`);
      if (!pending) return null;
      const battle = await this.contract.getBattle(battleId).catch(() => null);
      if (!battle) return null; // 链不可读：保留待办，下次 sweep 重试
      const rankedRecord = await this.ranked.battleRecord(battleId);
      const playerA = pending.playerA || battle.playerA;
      const playerB = pending.playerB || battle.playerB;
      const teamA = pending.teamA.length > 0 ? pending.teamA : (rankedRecord?.teamA ?? []);
      const teamB = pending.teamB.length > 0 ? pending.teamB : (rankedRecord?.teamB ?? []);

      if (battle.status === 'REFUNDED') {
        // 仲裁退款：不发奖（rating/羁绊/经验），积分场准入原路退回
        await this.refundArenaEntries(battleId, rankedRecord);
        this.logger.warn(`battle ${battleId} refunded — no ranked/bond rewards`);
        await this.clearPending(battleId);
        return null;
      }
      if (battle.status !== 'SETTLED') return null; // 等双方确认 / 兜底结算

      const winnerId = battle.result?.winnerId ?? '';
      if (!winnerId) return null;
      const scale = rankedRecord?.bot ? BOT_REWARD_SCALE : 1;

      let bonds: BattleRewardOutcome['bonds'] = [];
      let ratings: RatingChange[] = [];
      let bondError: string | null = null;
      let ratingError: string | null = null;
      let expError: string | null = null;
      let arenaError: string | null = null;
      let arena: ArenaSettlement | undefined;

      try {
        bonds = await this.bonds.grantPvpBond({ battleId, playerA, playerB, teamA, teamB, winnerId }, { scale });
      } catch (err) {
        bondError = (err as Error).message;
        this.logger.warn(`bond grant failed for ${battleId}: ${bondError}`);
      }

      // 普通 PvP（排位/房间）胜利经验：胜者参战队伍每只 +30（H3）。
      // 机器人场走下面的 grantBotWinExp（+15），两边共用 `<battleId>-exp-<pokemonId>` 幂等键。
      if (!rankedRecord?.bot) {
        try {
          await this.grantPvpWinExp(battleId, playerA, playerB, teamA, teamB, winnerId);
        } catch (err) {
          expError = (err as Error).message;
          this.logger.warn(`pvp win exp failed for ${battleId}: ${expError}`);
        }
      }

      if (rankedRecord) {
        try {
          ratings = await this.applyRankedRatings(
            rankedRecord,
            playerA,
            playerB,
            winnerId,
            rankedRecord.bot ? BOT_RATING_SCALE : 1,
          );
        } catch (err) {
          ratingError = (err as Error).message;
          this.logger.warn(`ranked rating update failed for ${battleId}: ${ratingError}`);
        }
        if (rankedRecord.bot) {
          await this.grantBotWinExp(rankedRecord, winnerId);
        }
        if (rankedRecord.arena) {
          try {
            arena = await this.applyArenaSettlement(rankedRecord, winnerId);
          } catch (err) {
            arenaError = (err as Error).message;
            this.logger.warn(`arena settlement failed for ${battleId}: ${arenaError}`);
          }
        }
      }

      if (bondError || ratingError || expError || arenaError) {
        // 保留待办：sweep 会重试（各条链上调用都是幂等键，重放不会叠加）
        await this.redis.setJson(
          `rewards:pending:${battleId}`,
          { ...pending, lastError: bondError ?? ratingError ?? expError ?? arenaError },
          PENDING_TTL_SEC,
        );
        return null;
      }

      const outcome: BattleRewardOutcome = {
        battleId,
        ranked: !!rankedRecord,
        winnerId,
        settledAt: new Date().toISOString(),
        ratings,
        bonds,
        ...(rankedRecord?.bot ? { bot: true } : {}),
        ...(arena ? { arena } : {}),
      };
      await this.redis.setJson(this.ranked.outcomeKey(battleId), outcome, 3600);
      if (rankedRecord) {
        await this.ranked.saveBattleRecord({ ...rankedRecord, state: 'APPLIED', arena: arena ?? rankedRecord.arena });
        for (const change of ratings) {
          await this.redis.zadd('ranked:lb', change.after, change.playerId).catch(() => undefined);
        }
      }
      await this.clearPending(battleId);
      this.logger.log(
        `battle ${battleId} rewards applied: ranked=${!!rankedRecord} ratings=${ratings.length} bonds=${bonds.length}` +
          (rankedRecord?.bot ? ' (bot: halved)' : '') +
          (arena ? ` arena=${arena.plan?.payouts.length ?? 0} payout(s)` : ''),
      );
      return outcome;
    } finally {
      await this.redis.del(APPLY_LOCK_KEY(battleId)).catch(() => undefined);
    }
  }

  /**
   * 排位分更新：首次结算时用当时的链上 rating 计算并**固化**为计划，
   * 之后（含失败重试）都按同一组数值提交，配合链上固定 idemKey 保证不会被重放叠加。
   * `scale` < 1（机器人场）时按 `delta × scale` 四舍五入后固化——重放仍用同一组数值。
   */
  private async applyRankedRatings(
    record: RankedBattleRecord,
    playerA: string,
    playerB: string,
    winnerId: string,
    scale = 1,
  ): Promise<RatingChange[]> {
    let plan = record.plan;
    if (!plan) {
      const [pa, pb] = await Promise.all([this.contract.getPlayer(playerA), this.contract.getPlayer(playerB)]);
      const outcome: RankedOutcome = winnerId === playerA ? 'A' : winnerId === playerB ? 'B' : 'DRAW';
      const elo = scaleElo(eloUpdate(pa.rating, pb.rating, outcome), scale);
      plan = { A: { before: elo.a.before, after: elo.a.after }, B: { before: elo.b.before, after: elo.b.after } };
      const stored = await this.ranked.battleRecord(record.battleId);
      if (stored) await this.ranked.saveBattleRecord({ ...stored, state: 'PLANNED', plan });
    }
    const reason = `ranked:${record.battleId}`;
    await this.contract.updateRating(SYSTEM_IDENTITY, playerA, plan.A.after, reason, {
      idemKey: `${record.battleId}-rating-A`,
    });
    await this.contract.updateRating(SYSTEM_IDENTITY, playerB, plan.B.after, reason, {
      idemKey: `${record.battleId}-rating-B`,
    });
    return [
      { playerId: playerA, before: plan.A.before, after: plan.A.after, delta: plan.A.after - plan.A.before },
      { playerId: playerB, before: plan.B.before, after: plan.B.after, delta: plan.B.after - plan.B.before },
    ];
  }

  /**
   * 普通 PvP（排位/房间）胜利经验：胜者参战队伍每只 +30。
   * DRAW/REFUND 或队伍缺失时不发；`grantBattleWinExp` 内部按链上 ownerId 过滤（赢来的对手宝可梦不会误加）。
   */
  private async grantPvpWinExp(
    battleId: string,
    playerA: string,
    playerB: string,
    teamA: string[],
    teamB: string[],
    winnerId: string,
  ): Promise<void> {
    if (!winnerId || winnerId === 'DRAW' || winnerId === 'REFUND') return;
    const winnerTeam = winnerId === playerA ? teamA : winnerId === playerB ? teamB : [];
    if (winnerTeam.length === 0) return;
    const granted = await this.pokemon.grantBattleWinExp(winnerId, winnerTeam, battleId, BATTLE_WIN_EXP_GAIN);
    this.logger.log(
      `pvp battle ${battleId}: exp +${BATTLE_WIN_EXP_GAIN} for ${granted.length} pokemon of ${winnerId}`,
    );
  }

  /**
   * 机器人场经验（奖励减半）：胜者参战队伍每只 +15（BATTLE_WIN_EXP_GAIN × 0.5）。
   * 幂等键与通用 PvP 胜利经验一致（`<battleId>-exp-<pokemonId>`），重复/并行发放不会叠加。
   */
  private async grantBotWinExp(record: RankedBattleRecord, winnerId: string): Promise<void> {
    if (!winnerId || winnerId === 'DRAW') return;
    const winnerTeam = winnerId === record.playerA ? record.teamA : winnerId === record.playerB ? record.teamB : [];
    if (winnerTeam.length === 0) return;
    const gain = Math.round(BATTLE_WIN_EXP_GAIN * BOT_REWARD_SCALE);
    const granted = await this.pokemon.grantBattleWinExp(winnerId, winnerTeam, record.battleId, gain);
    this.logger.log(
      `bot battle ${record.battleId}: exp +${gain} for ${granted.length} pokemon of ${winnerId}`,
    );
  }

  /**
   * 积分场结算（胜者通吃 + 补贴 / 平局退还）：
   * 首次结算时固化计划——补贴资格在这里判定一次（每日 3 次上限 / 对手分差 >400 / 机器人场），
   * 计划里的每笔 AddPoints 都带固定幂等键，重试不会重复发。计划持久化在排位房记录里。
   */
  private async applyArenaSettlement(record: RankedBattleRecord, winnerId: string): Promise<ArenaSettlement> {
    // 重读记录：ELO 计划（rating 差判定补贴资格）刚由 applyRankedRatings 写回 Redis
    const fresh = (await this.ranked.battleRecord(record.battleId)) ?? record;
    let arena = (fresh.arena ?? record.arena) as ArenaSettlement;
    if (!arena.plan) {
      const winner = winnerId === fresh.playerA || winnerId === fresh.playerB ? winnerId : null;
      const winnerEntry = winner === fresh.playerA ? arena.entryA : winner === fresh.playerB ? arena.entryB : 0;
      const gap = this.ratingGapOf(fresh);
      const date = utcDate();
      const dailyUsed = winner ? await this.redis.client.scard(subsidyDailyKey(winner, date)) : 0;
      const decision = arenaSubsidyDecision({
        subsidy: arenaSubsidyFor(winnerEntry),
        ratingGap: gap,
        bot: !!fresh.bot,
        dailyUsed,
      });
      const subsidy = decision.grant ? arenaSubsidyFor(winnerEntry) : 0;
      if (decision.grant && winner) {
        // 幂等计数：同一场战斗重复结算不会重复占名额
        await this.redis.client.sadd(subsidyDailyKey(winner, date), fresh.battleId);
        await this.redis.client.expire(subsidyDailyKey(winner, date), SUBSIDY_TTL_SEC);
        this.logger.log(`arena ${fresh.battleId}: subsidy +${subsidy} for ${winner}`);
      } else if (decision.blocked) {
        this.logger.log(`arena ${fresh.battleId}: no subsidy (${decision.blocked})`);
      }
      arena = {
        ...arena,
        plan: {
          winnerId: winnerId || 'DRAW',
          subsidy,
          subsidyTo: decision.grant ? winner : null,
          subsidyBlocked: decision.blocked,
          payouts: arenaPayouts({
            battleId: fresh.battleId,
            playerA: fresh.playerA,
            playerB: fresh.playerB,
            entryA: arena.entryA,
            entryB: arena.entryB,
            winnerId,
            subsidy,
          }),
        },
      };
      const stored = await this.ranked.battleRecord(record.battleId);
      if (stored) await this.ranked.saveBattleRecord({ ...stored, arena });
    }
    await this.payArena(arena.plan?.payouts ?? []);
    return { ...arena, applied: true };
  }

  /** 结算时双方 rating 差（用固化的 ELO 计划，链为准；无计划按 0 处理） */
  private ratingGapOf(record: RankedBattleRecord): number {
    return record.plan ? Math.abs(record.plan.A.before - record.plan.B.before) : 0;
  }

  /** 退款路径（仲裁 REFUNDED）：把积分场准入原路退回，幂等 */
  private async refundArenaEntries(battleId: string, record: RankedBattleRecord | null): Promise<void> {
    if (!record?.arena) return;
    const payouts = arenaEntryRefunds({
      battleId,
      playerA: record.playerA,
      playerB: record.playerB,
      entryA: record.arena.entryA,
      entryB: record.arena.entryB,
    });
    try {
      await this.payArena(payouts);
    } catch (err) {
      this.logger.warn(`arena entry refund failed for ${battleId}: ${(err as Error).message}`);
    }
  }

  private async payArena(payouts: ArenaPayout[]): Promise<void> {
    for (const payout of payouts) {
      await this.contract.addPoints(SYSTEM_IDENTITY, payout.playerId, payout.points, payout.reason, {
        idemKey: payout.idemKey,
      });
    }
  }

  /** 兜底扫尾：处理广播时链上还没结算（兜底 SettleBattle / 重启）的待办。 */
  async sweep(): Promise<number> {
    const ids = await this.redis.smembers(PENDING_SET).catch(() => [] as string[]);
    let applied = 0;
    for (const battleId of ids.slice(0, SWEEP_BATCH)) {
      try {
        // 待办记录 TTL 24h：记录已过期（对局长期悬置/仲裁未决）时把索引一并清掉
        if (!(await this.redis.get(`rewards:pending:${battleId}`))) {
          await this.redis.srem(PENDING_SET, battleId).catch(() => undefined);
          continue;
        }
        const outcome = await this.settle(battleId);
        if (outcome) applied += 1;
      } catch (err) {
        this.logger.warn(`reward sweep failed for ${battleId}: ${(err as Error).message}`);
      }
    }
    if (applied > 0) this.logger.log(`reward sweep applied ${applied} battle(s)`);
    return applied;
  }

  private async clearPending(battleId: string): Promise<void> {
    await this.redis.srem(PENDING_SET, battleId).catch(() => undefined);
    await this.redis.del(`rewards:pending:${battleId}`).catch(() => undefined);
  }
}
