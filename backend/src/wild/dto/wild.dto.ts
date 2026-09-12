import { Type } from 'class-transformer';
import { IsIn, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';

export class StartWildDto {
  @IsString()
  @IsNotEmpty()
  eventId: string;

  /** 可选首发：须是 owner 名下 IDLE 的宝可梦 id；缺省取等级最高者 */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  partyPokemonId?: string;
}

/**
 * 回合动作：move（moveId）/ ball（ballItemId）/ switch（targetPokemonId）/ run；
 * 字段按类型在服务层二次校验。
 */
export class WildActionPayloadDto {
  @IsIn(['move', 'ball', 'run', 'switch'])
  type: 'move' | 'ball' | 'run' | 'switch';

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  moveId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  ballItemId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  targetPokemonId?: string;
}

export class WildActionDto {
  @ValidateNested()
  @Type(() => WildActionPayloadDto)
  action: WildActionPayloadDto;
}
