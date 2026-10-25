import { Module } from '@nestjs/common';
import { FabricModule } from '../fabric/fabric.module';
import { LeaderboardController } from './leaderboard.controller';
import { LeaderboardService } from './leaderboard.service';

/** 积分排行榜（Redis ZSET + 链事件刷新，docs/backend-api.md §11）。 */
@Module({
  imports: [FabricModule],
  controllers: [LeaderboardController],
  providers: [LeaderboardService],
  exports: [LeaderboardService],
})
export class LeaderboardModule {}
