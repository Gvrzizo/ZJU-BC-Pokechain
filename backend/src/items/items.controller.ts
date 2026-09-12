import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { identityForUser } from '../fabric/chain.types';
import { UseItemDto } from './dto/items.dto';
import { ItemsService } from './items.service';

@Controller('items')
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get()
  listMine(@CurrentUser() user: AuthUser, @Query('owner') owner?: string) {
    void owner;
    return this.items.listMine(user.username);
  }

  @Get('catalog')
  catalog() {
    return this.items.catalog();
  }

  @Post(':id/use')
  use(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UseItemDto) {
    return this.items.use(identityForUser(user), id, {
      targetPokemonId: dto.targetPokemonId,
      forgetMoveId: dto.forgetMoveId,
      stat: dto.stat,
    });
  }
}
