import { Body, Controller, Get, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { identityForUser } from '../fabric/chain.types';
import { BuyItemDto, SellItemDto } from './dto/shop.dto';
import { ShopService } from './shop.service';

/** 道具商店：购买 / 半价回收（docs/backend-api.md §3「道具获取途径」）。 */
@Controller('shop')
export class ShopController {
  constructor(private readonly shop: ShopService) {}

  @Get()
  catalog(@CurrentUser() user: AuthUser) {
    return this.shop.catalog(user.username);
  }

  @Post('buy')
  buy(@CurrentUser() user: AuthUser, @Body() dto: BuyItemDto) {
    return this.shop.buy(identityForUser(user), dto.typeId, dto.qty, dto.idemKey);
  }

  @Post('sell')
  sell(@CurrentUser() user: AuthUser, @Body() dto: SellItemDto) {
    return this.shop.sell(identityForUser(user), dto.itemId, dto.qty, dto.idemKey);
  }
}
