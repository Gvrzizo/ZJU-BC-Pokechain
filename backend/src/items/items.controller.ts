import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { identityForUser } from '../fabric/chain.types';
import { MergeStacksDto, UseItemDto } from './dto/items.dto';
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
      count: dto.count,
    });
  }

  /** 合并同一 typeId 的 IDLE 堆叠（真链上 CouchDB 富查询有延迟，会残留多堆叠）。 */
  @Post('merge')
  merge(@CurrentUser() user: AuthUser, @Body() dto: MergeStacksDto) {
    return this.items.mergeStacks(identityForUser(user), dto.typeId);
  }
}
