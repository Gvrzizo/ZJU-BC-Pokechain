import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { identityForUser } from '../fabric/chain.types';
import { CreateTradeDto } from './dto/trades.dto';
import { TradesService } from './trades.service';

@Controller('trades')
export class TradesController {
  constructor(private readonly trades: TradesService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTradeDto) {
    return this.trades.create(identityForUser(user), dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('box') box?: 'in' | 'out') {
    return this.trades.list(identityForUser(user), box);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.trades.getOne(id);
  }

  @Post(':id/confirm')
  confirm(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.trades.confirm(identityForUser(user), id);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.trades.cancel(identityForUser(user), id);
  }
}
