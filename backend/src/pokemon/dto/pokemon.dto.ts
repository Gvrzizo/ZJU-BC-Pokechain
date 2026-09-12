import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Min } from 'class-validator';

export class EncounterDto {
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-fA-F]{8,64}$/, { message: 'clientSeed must be 8-64 hex chars' })
  clientSeed?: string;

  /** 付费诱饵：0 免费 / 1 = 50 积分（+5 级）/ 2 = 200 积分（+10 级、闪光 ×4） */
  @IsOptional()
  @IsInt()
  @IsIn([0, 1, 2])
  lureTier?: number;
}

export class AttemptDto {
  @IsString()
  @IsNotEmpty()
  eventId: string;

  @IsString()
  @IsNotEmpty()
  ballItemId: string;
}

export class TrainDto {
  @IsInt()
  @Min(1)
  costPoints: number;
}

export class EvolveDto {
  /** 进化石道具 id；不传 = 等级进化（EVOLUTIONS 里纯等级分支，等级达标即可） */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  stoneItemId?: string;
}

export class LearnMoveDto {
  @IsString()
  @IsNotEmpty()
  moveId: string;

  @IsOptional()
  @IsString()
  forgetMoveId?: string;
}
