import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators/api.decorators';
import { LeaderboardService } from './leaderboard.service';

/** Points leaderboard HTTP surface; the Redis ZSET cache lives in LeaderboardService. */
@Public()
@Controller('leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboard: LeaderboardService) {}

  @Get()
  board() {
    return this.leaderboard.board();
  }
}
