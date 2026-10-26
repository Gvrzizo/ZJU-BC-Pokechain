import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

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

  /**
   * 一次用几个（目前只对神奇糖果生效，1-99）。缺省 1。
   * 界面上"喂到 20 级"就是把它算成 20-level。
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  count?: number;
}

export class MergeStacksDto {
  @IsString()
  @IsNotEmpty()
  typeId!: string;
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
