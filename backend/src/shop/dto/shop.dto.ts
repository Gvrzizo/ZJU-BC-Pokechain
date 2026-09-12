import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { SHOP_MAX_QTY } from '../shop.data';

export class BuyItemDto {
  @IsString()
  @IsNotEmpty()
  typeId: string;

  @IsInt()
  @Min(1)
  @Max(SHOP_MAX_QTY)
  qty: number;

  /**
   * 客户端幂等键：同一次购买重试时复用，链上 AddPoints/MintItem 都按它派生 idemKey，
   * 不会重复扣分或重复发货（缺省由服务端生成，等价于"每次请求都是一次新购买"）。
   */
  @IsOptional()
  @IsString()
  @Matches(/^[\w-]{8,128}$/)
  idemKey?: string;
}

export class SellItemDto {
  @IsString()
  @IsNotEmpty()
  itemId: string;

  @IsInt()
  @Min(1)
  @Max(SHOP_MAX_QTY)
  qty: number;

  @IsOptional()
  @IsString()
  @Matches(/^[\w-]{8,128}$/)
  idemKey?: string;
}
