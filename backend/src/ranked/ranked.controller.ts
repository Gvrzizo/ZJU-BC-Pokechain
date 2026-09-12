import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { identityForUser } from '../fabric/chain.types';
import { RankedBotService } from './bot.service';
import { RankedQueueDto } from './dto/ranked.dto';
import { RankedService } from './ranked.service';

/**
 * 排位赛（docs/backend-api.md §11）：排队匹配（窗口扩圈 + 15s 接受期）、
 * 机器人兜底、积分场、排行榜、战绩、结算面板数据。
 * 排位房的战斗本身仍走 /battles（socket + 房间流程）。
 */
@Controller('ranked')
export class RankedController {
  constructor(
    private readonly ranked: RankedService,
    private readonly bots: RankedBotService,
  ) {}

  /** 进队列（立即尝试配对；响应即最新排队状态） */
  @Post('queue')
  enqueue(@CurrentUser() user: AuthUser, @Body() dto: RankedQueueDto) {
    return this.ranked.enqueue(identityForUser(user), dto.teamPokemonIds, dto.mode ?? 'casual');
  }

  /** 排队状态轮询（顺带再匹配一次；MATCH_PENDING 带接受期，MATCHED 带 battleId） */
  @Get('queue/status')
  status(@CurrentUser() user: AuthUser) {
    return this.ranked.status(identityForUser(user));
  }

  /** 接受匹配（双方都接受才建房；15 秒未接受按超时处理） */
  @Post('queue/accept')
  accept(@CurrentUser() user: AuthUser) {
    return this.ranked.accept(identityForUser(user));
  }

  /** 拒绝匹配（双方回队列，自己 30 秒内窗口重置为 ±200） */
  @Post('queue/decline')
  decline(@CurrentUser() user: AuthUser) {
    return this.ranked.decline(identityForUser(user));
  }

  /** 接受机器人对手（排队满 60 秒且无真人时可用；每人每天 5 场，奖励减半） */
  @Post('queue/accept-bot')
  acceptBot(@CurrentUser() user: AuthUser) {
    return this.bots.acceptBot(identityForUser(user));
  }

  /** 取消排队（待确认时等于放弃该对局，对方回队列） */
  @Delete('queue')
  cancel(@CurrentUser() user: AuthUser) {
    return this.ranked.cancel(identityForUser(user));
  }

  /** 排行榜（前 50 + 自己名次；refresh=1 跳过缓存） */
  @Get('leaderboard')
  leaderboard(@CurrentUser() user: AuthUser, @Query('refresh') refresh?: string) {
    return this.ranked.leaderboard(identityForUser(user), refresh === '1' || refresh === 'true');
  }

  /** 我的排位：rating / 战绩 / 名次 */
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.ranked.me(identityForUser(user));
  }

  /** 结算面板：本局的 rating 与羁绊变化（未应用时 status=PENDING / 无记录 NONE） */
  @Get('battles/:battleId/outcome')
  outcome(@Param('battleId') battleId: string) {
    return this.ranked.outcome(battleId);
  }
}
