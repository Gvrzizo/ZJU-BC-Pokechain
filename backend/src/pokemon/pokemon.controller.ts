import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { identityForUser } from '../fabric/chain.types';
import { zoneTable } from '../game-data/encounter.data';
import { CaptureService } from './capture.service';
import {
  AttemptDto,
  EncounterDto,
  EvolveDto,
  RenamePokemonDto,
  TrainDto,
} from './dto/pokemon.dto';
import { PokemonService } from './pokemon.service';

@Controller()
export class PokemonController {
  constructor(
    private readonly pokemon: PokemonService,
    private readonly capture: CaptureService,
  ) {}

  @Get('pokemon')
  listMine(@CurrentUser() user: AuthUser, @Query('owner') owner?: string) {
    void owner; // only owner=me is supported for now
    return this.pokemon.listMine(user.username);
  }

  @Get('pokedex')
  pokedex(@CurrentUser() user: AuthUser) {
    return this.pokemon.pokedex(user.username);
  }

  /** 详情：仅本人（BOLA 防护，非本人 404；IV/EV/性格等私密数据不外泄）。 */
  @Get('pokemon/:id')
  getOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.pokemon.getOneForUser(id, user.username);
  }

  /**
   * 宝可梦中心：全队回满（每次 10P，`AddPoints(-10, reason='heal:center')`）。
   * 全员满血时不扣费（charged=false）。
   */
  @Post('pokemon/center/heal')
  centerHeal(@CurrentUser() user: AuthUser) {
    return this.pokemon.centerHeal(identityForUser(user));
  }

  /**
   * 区域表（docs/backend-api.md §2）：普通区 7 个（等级带 / 阶段门槛 / 栖息地属性）
   * + 传说区 6 个（固定池、窄等级带、所需钥匙 typeId），并给出缺省区与旧三区别名。
   */
  @Get('capture/zones')
  zones() {
    return zoneTable();
  }

  @Post('capture/encounter')
  encounter(@CurrentUser() user: AuthUser, @Body() dto: EncounterDto) {
    return this.capture.encounter(identityForUser(user), dto.clientSeed, dto.lureTier, dto.zoneId);
  }

  @Post('capture/attempt')
  attempt(@CurrentUser() user: AuthUser, @Body() dto: AttemptDto) {
    return this.capture.attempt(identityForUser(user), dto.eventId, dto.ballItemId);
  }

  @Post('pokemon/:id/train')
  train(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: TrainDto) {
    return this.pokemon.train(identityForUser(user), id, dto.costPoints);
  }

  /** 进化：不带 stoneItemId = 等级进化；带 = 进化石进化（两种路径都返回带进化链的新详情）。 */
  @Post('pokemon/:id/evolve')
  evolve(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: EvolveDto) {
    return this.pokemon.evolve(identityForUser(user), id, dto.stoneItemId);
  }

  /**
   * 改名：第一次免费，之后每次 50P（`AddPoints(-50, reason='rename:<pokemonId>:<count>')`）。
   * 昵称 1-12 字符（拒绝控制字符与 `<>&"'`），锁定/已放生的宝可梦拒绝改名。
   */
  @Post('pokemon/:id/rename')
  rename(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RenamePokemonDto) {
    return this.pokemon.rename(identityForUser(user), id, dto.name);
  }

  @Post('pokemon/:id/release')
  release(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.pokemon.release(identityForUser(user), id);
  }
}
