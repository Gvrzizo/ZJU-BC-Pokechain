import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { identityForUser } from '../fabric/chain.types';
import { StartWildDto, WildActionDto } from './dto/wild.dto';
import { WildService } from './wild.service';

/** PvE 野怪战斗捕捉（docs/backend-api.md §2）。 */
@Controller('wild')
export class WildController {
  constructor(private readonly wild: WildService) {}

  @Post('start')
  start(@CurrentUser() user: AuthUser, @Body() dto: StartWildDto) {
    return this.wild.start(identityForUser(user), dto.eventId, dto.partyPokemonId);
  }

  @Post(':id/action')
  action(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: WildActionDto) {
    return this.wild.action(identityForUser(user), id, dto.action);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.wild.get(identityForUser(user), id);
  }
}
