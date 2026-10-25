import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';

export class AssetOfferDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pokemonIds: string[] = [];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  itemIds: string[] = [];

  @IsOptional()
  @IsInt()
  @Min(0)
  points = 0;
}

export class CreateTradeDto {
  @IsString()
  @IsNotEmpty()
  toPlayerId: string;

  @ValidateNested()
  @Type(() => AssetOfferDto)
  offer: AssetOfferDto;

  @ValidateNested()
  @Type(() => AssetOfferDto)
  request: AssetOfferDto;

  /** 10 秒 - 7 天（链码 CreateTrade 同样限制 `expiresAt - nowISO <= 7d`）。 */
  @IsInt()
  @Min(10)
  @Max(7 * 24 * 3600)
  ttlSeconds: number;
}

/** 押注道具引用：id=堆叠实例 id，qty=押注数量（整堆押注即 qty=堆叠总量）。 */
export class WagerItemDto {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsInt()
  @Min(1)
  qty: number;
}

/**
 * 对战押注（房间 wager）：`items:[{id,qty}]` 部分数量押注；`itemIds` 为旧格式
 * 整堆押注兼容字段（链码解析层归一为 items:[{id,qty:0}]），两者不可混用。
 */
export class BattleWagerDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pokemonIds: string[] = [];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WagerItemDto)
  items?: WagerItemDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  itemIds: string[] = [];

  @IsOptional()
  @IsInt()
  @Min(0)
  points = 0;
}

export class CreateRoomDto {
  @IsString()
  mode: '1v1' = '1v1';

  @ValidateNested()
  @Type(() => BattleWagerDto)
  wager: BattleWagerDto;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  teamPokemonIds: string[];
}

export class JoinRoomDto {
  @ValidateNested()
  @Type(() => BattleWagerDto)
  wager: BattleWagerDto;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  teamPokemonIds: string[];
}

export class DisputeDto {
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class ArbitrateDto {
  @IsString()
  @IsNotEmpty()
  outcome: string; // winnerId | 'DRAW' | 'REFUND'

  @IsString()
  @IsNotEmpty()
  note: string;
}
