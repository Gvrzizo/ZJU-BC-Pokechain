import { IsArray, ArrayNotEmpty, IsIn, IsOptional, IsString } from 'class-validator';
import type { QueueMode } from '../ranked.types';

export class RankedQueueDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  teamPokemonIds: string[];

  /** 排队模式：casual（默认，只争 rating）/ arena（积分场，按段位收准入积分） */
  @IsOptional()
  @IsIn(['casual', 'arena'])
  mode?: QueueMode;
}
