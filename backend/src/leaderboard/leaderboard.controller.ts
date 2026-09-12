import { Controller, Get, OnModuleInit } from '@nestjs/common';
import { Public } from '../common/decorators/api.decorators';
import { RedisService } from '../common/redis/redis.service';
import { ChainEventsService } from '../fabric/chain-events.service';
import { ContractService } from '../fabric/contract.service';

const BOARD_KEY = 'leaderboard:points';

/** Points leaderboard cached in a Redis ZSET, refreshed by chain events. */
@Public()
@Controller('leaderboard')
export class LeaderboardController implements OnModuleInit {
  constructor(
    private readonly redis: RedisService,
    private readonly contract: ContractService,
    private readonly events: ChainEventsService,
  ) {}

  onModuleInit(): void {
    this.events.stream$.subscribe(({ name, payload }) => {
      if (!['PointsChanged', 'PlayerRegistered', 'BattleSettled'].includes(name)) return;
      const ids = [payload.playerId, payload.playerA, payload.playerB].filter(
        (v): v is string => typeof v === 'string' && !!v,
      );
      for (const id of new Set(ids)) void this.refreshPlayer(id);
    });
  }

  private async refreshPlayer(playerId: string): Promise<void> {
    try {
      const player = await this.contract.getPlayer(playerId);
      await this.redis.zadd(BOARD_KEY, player.points, playerId);
    } catch {
      // player may not exist on-chain yet; ignore
    }
  }

  @Get()
  async board() {
    const top = await this.redis.zrevrangeWithScores(BOARD_KEY, 0, 19).catch(() => []);
    return top.map((e, i) => ({ rank: i + 1, playerId: e.member, points: e.score }));
  }
}
