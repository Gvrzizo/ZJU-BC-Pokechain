import { IsString, MaxLength, MinLength } from 'class-validator';

// --- [FEAT:breeding] begin ---

export class BreedDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  parentAId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  parentBId!: string;
}

// --- [FEAT:breeding] end ---
