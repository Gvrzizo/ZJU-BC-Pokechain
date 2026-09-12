import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** 培养项（王冠指定 IV 维度，docs/backend-api.md §2 能力值计算）。 */
export const STAT_KEYS = ['hp', 'atk', 'def', 'spatk', 'spdef', 'speed'] as const;

export class UseItemDto {
  @IsOptional()
  @IsString()
  targetPokemonId?: string;

  @IsOptional()
  @IsString()
  forgetMoveId?: string;

  /** 银色王冠必填：要把哪一项个体值升满 31 */
  @IsOptional()
  @IsIn(STAT_KEYS)
  stat?: (typeof STAT_KEYS)[number];
}

export class MintItemDto {
  @IsString()
  @IsNotEmpty()
  playerId: string;

  @IsString()
  @IsNotEmpty()
  typeId: string;

  @IsNotEmpty()
  quantity: number;
}
