import { Injectable, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { ChainEventsService } from '../fabric/chain-events.service';
import { BattleSettledChainEvent, PointsChangedEvent } from '../fabric/chain.types';
import { ContractService } from '../fabric/contract.service';

const BOARD_KEY = 'leaderboard:points';

/**
 * Points leaderboard cached in a Redis ZSET, refreshed by chain events.
 * Kept out of the controller so the HTTP surface stays thin (docs/backend-api.md §11).
 */
@Injectable()
export class LeaderboardService implements OnModuleInit {
  constructor(
    private readonly redis: RedisService,
    private readonly contract: ContractService,
    private readonly events: ChainEventsService,
  ) {}

  onModuleInit(): void {
    // 结算/交易事件不一定带 playerId：BattleSettled 只有 winnerId，交易 PointsChanged 是 fromId/toId。
    // 不把这几个 id 一起纳入，真链排行榜在结算后不会刷新（H4）。
    const refresh = (payload: PointsChangedEvent | BattleSettledChainEvent): void => {
      const ids = [payload.playerId, payload.playerA, payload.playerB, payload.winnerId, payload.fromId, payload.toId].filter(
        (v): v is string => typeof v === 'string' && !!v,
      );
      for (const id of new Set(ids)) void this.refreshPlayer(id);
    };
    this.events.onEvent('PointsChanged', refresh);
    this.events.onEvent('BattleSettled', refresh);
    this.events.onEvent('PlayerRegistered', (payload) => void this.refreshPlayer(payload.playerId));
  }

  private async refreshPlayer(playerId: string): Promise<void> {
    try {
      const player = await this.contract.getPlayer(playerId);
      await this.redis.zadd(BOARD_KEY, player.points, playerId);
    } catch {
      // player may not exist on-chain yet; ignore
    }
  }

  async board() {
    const top = await this.redis.zrevrangeWithScores(BOARD_KEY, 0, 19).catch(() => []);
    return top.map((e, i) => ({ rank: i + 1, playerId: e.member, points: e.score }));
  }
}
