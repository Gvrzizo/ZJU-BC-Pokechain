import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/api.decorators';
import { identityForUser } from '../fabric/chain.types';
import { ArbitrateDto, DisputeDto } from '../trades/dto/trades.dto';
import { BattleLog } from './entities/battle-log.entity';
import {
  BlockPlayerDto,
  CreateRoomDto,
  JoinRoomDto,
  KickPlayerDto,
  SaveTemplateDto,
  UpdateRoomDto,
} from './dto/room.dto';
import { BattlesService } from './battles.service';
import { WagerTemplateService } from './wager-template.service';

@Controller('battles')
export class BattlesController {
  constructor(
    private readonly battles: BattlesService,
    private readonly templates: WagerTemplateService,
    @InjectRepository(BattleLog) private readonly battleLogs: Repository<BattleLog>,
  ) {}

  @Post('rooms')
  createRoom(@CurrentUser() user: AuthUser, @Body() dto: CreateRoomDto) {
    return this.battles.createRoom(identityForUser(user), dto);
  }

  @Get('rooms')
  listRooms() {
    return this.battles.listRooms();
  }

  /** 我的屏蔽名单（大厅"屏蔽名单"小界面）。注意须先于 `rooms/:id` 声明。 */
  @Get('rooms/blocks')
  listBlocks(@CurrentUser() user: AuthUser) {
    return this.battles.listBlockedPlayers(identityForUser(user));
  }

  /** 屏蔽某玩家（默认 30 分钟）：其加入我创建的房间会被 403 BLOCKED_BY_HOST 拒绝。 */
  @Post('rooms/block')
  blockPlayer(@CurrentUser() user: AuthUser, @Body() dto: BlockPlayerDto) {
    return this.battles.blockPlayer(identityForUser(user), dto.playerId);
  }

  @Delete('rooms/block/:playerId')
  unblockPlayer(@CurrentUser() user: AuthUser, @Param('playerId') playerId: string) {
    return this.battles.unblockPlayer(identityForUser(user), playerId);
  }

  /** 房间详情：房间本体 + 双方押注的富化明细（"查看押注"弹窗）。 */
  @Get('rooms/:id')
  roomDetail(@Param('id') id: string) {
    return this.battles.roomDetail(id);
  }

  /** 房主改房名 / 备注（仅房主、激活前）。 */
  @Patch('rooms/:id')
  updateRoom(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateRoomDto) {
    return this.battles.updateRoom(identityForUser(user), id, dto);
  }

  /** 房主请离加入者（仅在双方确认押注前）。 */
  @Post('rooms/:id/kick')
  kick(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: KickPlayerDto) {
    return this.battles.kick(identityForUser(user), id, dto.playerId);
  }

  /** 技能元数据（静态表）：战斗界面技能按钮展示 威力/命中/属性/说明。注意须先于 `:id` 声明。 */
  @Get('moves')
  listMoves() {
    return this.battles.listMoves();
  }

  /** 常用押注模板（每个玩家最多 10 个）。同样须先于 `:id` 声明。 */
  @Get('templates')
  async listTemplates(@CurrentUser() user: AuthUser) {
    return { templates: await this.templates.list(user.username) };
  }

  @Post('templates')
  saveTemplate(@CurrentUser() user: AuthUser, @Body() dto: SaveTemplateDto) {
    return this.templates.save(user.username, dto);
  }

  @Delete('templates/:id')
  deleteTemplate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.templates.remove(user.username, id);
  }

  /** Dispute console: GET /battles?status=disputed|resolved|all (admin/arbitrator only). */
  @Roles('arbitrator', 'admin')
  @Get()
  listDisputes(@Query('status') status?: string) {
    return this.battles.listDisputes(status);
  }

  @Post('rooms/:id/join')
  joinRoom(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: JoinRoomDto) {
    return this.battles.joinRoom(identityForUser(user), id, dto);
  }

  @Post(':id/wager/confirm')
  confirmWager(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.battles.confirmWager(identityForUser(user), id);
  }

  @Post(':id/result/confirm')
  confirmResult(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.battles.confirmResult(identityForUser(user), id);
  }

  @Post(':id/forfeit')
  @HttpCode(202)
  async forfeit(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.battles.forfeit(identityForUser(user), id);
    return { forfeited: true };
  }

  @Post(':id/dispute')
  dispute(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: DisputeDto) {
    return this.battles.dispute(identityForUser(user), id, dto.reason);
  }

  @Roles('arbitrator', 'admin')
  @Post(':id/arbitrate')
  arbitrate(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ArbitrateDto) {
    return this.battles.arbitrate(identityForUser(user), id, dto.outcome, dto.note);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.battles.detail(id);
  }

  @Get(':id/replay')
  async replay(@Param('id') id: string) {
    const log = await this.battleLogs.findOne({
      where: { battleId: id },
      order: { createdAt: 'DESC' },
    });
    return { battleId: id, replay: log ?? null };
  }
}
