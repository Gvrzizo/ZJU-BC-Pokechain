import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Min } from 'class-validator';

export class EncounterDto {
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-fA-F]{8,64}$/, { message: 'clientSeed must be 8-64 hex chars' })
  clientSeed?: string;

  /** 付费诱饵：0 免费 / 1 = 50 积分（带内 +2 级）/ 2 = 200 积分（带内 +5 级、闪光 ×4） */
  @IsOptional()
  @IsInt()
  @IsIn([0, 1, 2])
  lureTier?: number;

  /**
   * 遇敌区域（地图 y 带，frontend OverworldScene 传入）：south / mid / north；缺省按南部。
   * 合法值由 game-data/encounter.data.ts 的 ZONES 决定，服务层校验并抛 INVALID_ZONE（test/capture.spec 同口径）。
   */
  @IsOptional()
  @IsString()
  zoneId?: string;
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

/**
 * 改名（docs/backend-api.md §2「改名」）：`name` 的完整校验（trim / 1-12 字符 / 拒绝控制字符与
 * `<>&"'`）在 `PokemonService.rename`（`pokemon-name.ts`）内做，DTO 只保证类型与非空。
 */
export class RenamePokemonDto {
  @IsString()
  @IsNotEmpty()
  name: string;
}
