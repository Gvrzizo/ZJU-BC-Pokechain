import { IsNotEmpty, IsOptional, IsString, Length, Matches } from 'class-validator';

export class RegisterDto {
  @IsString()
  @Length(3, 32)
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'username may contain letters, digits, _ and -' })
  username: string;

  @IsString()
  @Length(8, 128)
  password: string;

  @IsString()
  @Length(1, 64)
  nickname: string;
}

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  username: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @Length(1, 64)
  nickname?: string;

  @IsOptional()
  @IsString()
  @Length(0, 256)
  avatarUri?: string;
}

export class AddFriendDto {
  @IsString()
  @IsNotEmpty()
  friendId: string;
}
