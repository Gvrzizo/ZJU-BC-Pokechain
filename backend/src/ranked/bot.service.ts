import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DeriveStream } from '../common/utils/crypto.util';
import { RedisService } from '../common/redis/redis.service';
import { AppException } from '../common/utils/errors';
import { ContractService } from '../fabric/contract.service';
import { ADMIN_IDENTITY, SYSTEM_IDENTITY } from '../fabric/chain.types';
import { BattleManagerService } from '../battles/battle-manager.service';
import { BattleRewardService } from './battle-reward.service';
import { RankedBattleLauncher } from './battle-launcher';
import { QueueStatusResult, RankedService } from './ranked.service';
import {
  BOT_DAILY_LIMIT,
  BOT_MOVE_DELAY_MS,
  BOT_NICKNAME,
  BOT_OFFER_AFTER_MS,
  BOT_PLAYER_ID,
  averageLevel,
  botDailyKey,
  botTurnRolls,
  buildBotTeam,
  pickBotAction,
  utcDate,
} from './bot';
import { RankedBattleRecord } from './ranked.types';

/** 同一玩家的 accept-bot 串行化（双击/并发只会开一场） */
const BOT_LOCK_KEY = (playerId: string) => `ranked:bot:lock:${playerId}`;
const BOT_LOCK_TTL_SEC = 30;
/** 场次计数键 TTL：两天（跨天后自然失效） */
const BOT_DAILY_TTL_SEC = 2 * 24 * 3600;
/** BOT 玩家的链上注册幂等键（RegisterPlayer 幂等，重跑不会重复建号） */
const BOT_REGISTER_IDEM_KEY = 'ranked-bot-register';

/**
 * 练习机器人（docs/backend-api.md §11）：排队 60s 没有真人时，玩家可以打一场机器人对局。
 *
 * - 链上注册共享 `BOT` 玩家（初始 rating 1000），战斗走同一套 CreateBattle + 引擎；
 * - 机器人队伍是内存临时实体（3 只，等级 = 玩家队伍平均等级 ±2，种族取自野生池）；
 * - 机器人出招由本服务代打：监听引擎的 `turn` 事件，从该对局的 RandomCommit 派生流
 *   （偏移 100000 起，与引擎顺序游标互不干扰）挑一个合法技能，普通伤害招优先；
 * - 对局结束后立刻以 system 身份 SettleBattle（机器人不会自己 ConfirmResult），
 *   让减半奖励尽快在结算面板可见，而不是等 2 分钟兜底。
 */
@Injectable()
export class RankedBotService implements OnModuleInit {
  private readonly logger = new Logger(RankedBotService.name);
  /** 正在进行的机器人对局（battleId），结束后清出 */
  private readonly live = new Set<string>();

  constructor(
    private readonly contract: ContractService,
    private readonly redis: RedisService,
    private readonly manager: BattleManagerService,
    private readonly launcher: RankedBattleLauncher,
    private readonly ranked: RankedService,
    private readonly rewards: BattleRewardService,
  ) {}

  onModuleInit(): void {
    this.manager.events.on('turn', (battleId: string, payload: { awaitingPlayerIds?: string[] }) => {
      void this.onTurn(battleId, payload);
    });
    this.manager.events.on('end', (battleId: string) => {
      void this.onBattleEnd(battleId);
    });
  }

  // ------------------------------------------------------------------ 开局 --

  /**
   * 接受机器人对手：注册 BOT 玩家 → 生成机器人队伍 → 建链上对局 + 起引擎 + 写凭据。
   * 每人每天最多 BOT_DAILY_LIMIT 场（Redis 计数 `ranked:bot:<player>:<yyyy-mm-dd>`）；
   * arena 模式不提供机器人（准入积分不能对着机器人刷）。
   */
  async acceptBot(as: { userId: string }): Promise<QueueStatusResult> {
    const playerId = as.userId;
    const lock = await this.redis.setNx(BOT_LOCK_KEY(playerId), '1', BOT_LOCK_TTL_SEC).catch(() => false);
    if (!lock) {
      throw new AppException('BOT_IN_PROGRESS', 'a bot battle is already being created', HttpStatus.CONFLICT);
    }
    let reserved = false;
    try {
      const entry = await this.ranked.queueEntry(playerId);
      if (!entry) {
        throw new AppException('NOT_QUEUED', 'join the queue before asking for a bot opponent', HttpStatus.CONFLICT);
      }
      if ((entry.mode ?? 'casual') === 'arena') {
        throw new AppException('ARENA_BOT_UNAVAILABLE', 'arena matches cannot be played against the bot', HttpStatus.CONFLICT);
      }
      if (Date.now() - entry.joinedAt < BOT_OFFER_AFTER_MS) {
        throw new AppException(
          'BOT_NOT_OFFERED',
          `bot opponents unlock after ${Math.round(BOT_OFFER_AFTER_MS / 1000)}s in the queue`,
          HttpStatus.CONFLICT,
        );
      }
      const used = await this.reserveBotBattle(playerId);
      reserved = true;
      if (used > BOT_DAILY_LIMIT) {
        await this.releaseBotBattle(playerId);
        reserved = false;
        throw new AppException(
          'BOT_DAILY_LIMIT',
          `daily bot limit (${BOT_DAILY_LIMIT} battles) reached`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      await this.ranked.assertTeam(playerId, entry.teamPokemonIds);
      const bot = await this.contract
        .registerPlayer(ADMIN_IDENTITY, BOT_PLAYER_ID, BOT_NICKNAME, { idemKey: BOT_REGISTER_IDEM_KEY })
        .catch(async (err: Error) => {
          const existing = await this.contract.getPlayer(BOT_PLAYER_ID).catch(() => null);
          if (!existing) throw err;
          return existing;
        });
      const playerTeam = await this.launcher.loadTeam(entry.teamPokemonIds);
      const battleId = `b_${randomUUID()}`;
      const { team: botTeam, seed } = buildBotTeam({
        battleId,
        avgLevel: averageLevel(playerTeam.map((mon) => mon.level)),
      });
      await this.launcher.launch({
        battleId,
        playerA: playerId,
        playerB: BOT_PLAYER_ID,
        teamA: playerTeam,
        teamB: botTeam,
      });
      // 机器人不需要进战斗界面：直接标记到场，玩家的入场宽限期照常生效
      this.manager.enterBattle(battleId, BOT_PLAYER_ID);

      const record: RankedBattleRecord = {
        battleId,
        roomId: null,
        playerA: playerId,
        playerB: BOT_PLAYER_ID,
        teamA: entry.teamPokemonIds,
        teamB: [],
        state: 'PENDING',
        mode: 'casual',
        bot: { seed, mons: botTeam.map((mon) => ({ speciesId: mon.speciesId, level: mon.level })) },
        createdAt: Date.now(),
      };
      await this.ranked.saveBattleRecord(record);
      await this.ranked.recordMatched(playerId, {
        roomId: null,
        battleId,
        opponentId: BOT_PLAYER_ID,
        opponentRating: bot.rating,
        at: Date.now(),
        bot: true,
      });
      this.live.add(battleId);
      this.logger.log(
        `bot battle ${battleId}: ${playerId} (avg Lv${averageLevel(playerTeam.map((m) => m.level)).toFixed(1)}) vs ` +
          botTeam.map((m) => `#${m.speciesId}L${m.level}`).join(','),
      );
      return this.ranked.status({ mspId: 'Org1MSP', role: 'player', userId: playerId });
    } catch (err) {
      if (reserved) await this.releaseBotBattle(playerId);
      throw err;
    } finally {
      await this.redis.del(BOT_LOCK_KEY(playerId)).catch(() => undefined);
    }
  }

  /** 每日场次 +1（返回自增后的次数；开局失败时由调用方回滚） */
  async reserveBotBattle(playerId: string): Promise<number> {
    const key = botDailyKey(playerId, utcDate());
    const used = await this.redis.client.incr(key);
    await this.redis.client.expire(key, BOT_DAILY_TTL_SEC);
    return used;
  }

  /** 开局失败时退回一次机会 */
  async releaseBotBattle(playerId: string): Promise<void> {
    const key = botDailyKey(playerId, utcDate());
    const used = await this.redis.client.decr(key);
    if (used <= 0) await this.redis.del(key);
  }

  /** 今天已打的机器人场次 */
  async botUsedToday(playerId: string): Promise<number> {
    const used = Number((await this.redis.get(botDailyKey(playerId, utcDate()))) ?? 0);
    return Number.isFinite(used) && used > 0 ? used : 0;
  }

  // ------------------------------------------------------------------ 出招 --

  /** 引擎广播轮到谁出招：轮到机器人时延迟一小会儿出招（服务端代打）。 */
  private async onTurn(battleId: string, payload: { awaitingPlayerIds?: string[] }): Promise<void> {
    if (!this.live.has(battleId)) return;
    if (!payload?.awaitingPlayerIds?.includes(BOT_PLAYER_ID)) return;
    const timer = setTimeout(() => void this.playBotTurn(battleId), BOT_MOVE_DELAY_MS);
    timer.unref?.();
  }

  private playBotTurn(battleId: string): void {
    const battle = this.manager.get(battleId);
    if (!battle || battle.finalized || battle.engine.finished) return;
    const side = this.manager.sideOf(battle, BOT_PLAYER_ID);
    if (!side) return;
    const state = battle.engine.publicState();
    const sideState = side === 'A' ? state.A : state.B;
    if (sideState.acted) return;
    const active = battle.engine.active(side);
    const stream = new DeriveStream(battle.serverSeed, battle.clientSeed, battle.eventId);
    const rolls = botTurnRolls(stream, state.turn);
    const action = pickBotAction({
      moves: active.moves,
      team: battle.engine.team(side).map((mon) => ({ hp: mon.hp })),
      activeIndex: sideState.active,
      mustSwitch: sideState.mustSwitch,
      roll: rolls.move,
      switchRoll: rolls.switch,
    });
    try {
      this.manager.submitAction(battleId, BOT_PLAYER_ID, action);
    } catch (err) {
      this.logger.warn(`bot action rejected in ${battleId}: ${(err as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ 结算 --

  /**
   * 对局结束：机器人不会 ConfirmResult，用 system 身份直接 SettleBattle 收尾，
   * 随后立刻尝试应用奖励（减半）——不然要等 2 分钟兜底 / 30 秒 sweep。
   */
  private async onBattleEnd(battleId: string): Promise<void> {
    if (!this.live.delete(battleId)) return;
    try {
      const chain = await this.contract.getBattle(battleId);
      if (chain.status === 'RESULT_SUBMITTED') {
        await this.contract.settleBattle(SYSTEM_IDENTITY, battleId, { idemKey: `${battleId}-bot-settle` });
      }
    } catch (err) {
      this.logger.warn(`bot battle ${battleId} settle failed: ${(err as Error).message}`);
    }
    await this.rewards.settle(battleId).catch((err: Error) => {
      this.logger.warn(`bot battle ${battleId} rewards failed: ${err.message}`);
    });
  }

  /** 测试用：当前进行中的机器人对局数 */
  liveCount(): number {
    return this.live.size;
  }
}
