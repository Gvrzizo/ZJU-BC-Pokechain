import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { identityForUser } from '../fabric/chain.types';
import { CaptureService } from './capture.service';
import { AttemptDto, EncounterDto, EvolveDto, LearnMoveDto, TrainDto } from './dto/pokemon.dto';
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

  @Get('pokemon/:id')
  getOne(@Param('id') id: string) {
    return this.pokemon.getOne(id);
  }

  /**
   * 宝可梦中心：全队回满（每次 10P，`AddPoints(-10, reason='heal:center')`）。
   * 全员满血时不扣费（charged=false）。
   */
  @Post('pokemon/center/heal')
  centerHeal(@CurrentUser() user: AuthUser) {
    return this.pokemon.centerHeal(identityForUser(user));
  }

  @Post('capture/encounter')
  encounter(@CurrentUser() user: AuthUser, @Body() dto: EncounterDto) {
    return this.capture.encounter(identityForUser(user), dto.clientSeed, dto.lureTier);
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

  @Post('pokemon/:id/release')
  release(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.pokemon.release(identityForUser(user), id);
  }

  @Post('pokemon/:id/moves/learn')
  learnMove(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: LearnMoveDto) {
    return this.pokemon.learnMove(identityForUser(user), id, dto.moveId, dto.forgetMoveId);
  }
}
