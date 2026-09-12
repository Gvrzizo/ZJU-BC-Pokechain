import { IsIn, IsInt } from 'class-validator';
import { STARTER_SPECIES_IDS } from '../starter.service';

export class ClaimStarterDto {
  /** 御三家 speciesId：1 = 妙蛙种子 / 4 = 小火龙 / 7 = 杰尼龟 */
  @IsInt()
  @IsIn([...STARTER_SPECIES_IDS])
  speciesId: number;
}
