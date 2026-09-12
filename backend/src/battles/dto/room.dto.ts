import { Type } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import {
  BattleWagerDto,
  CreateRoomDto as WagerCreateRoomDto,
  JoinRoomDto as WagerJoinRoomDto,
} from '../../trades/dto/trades.dto';

/** 房名 / 房主备注 / 加入留言 / 模板名的长度上限（docs/backend-api.md §5） */
export const ROOM_NAME_MAX = 30;
export const ROOM_NOTE_MAX = 100;
export const JOIN_MESSAGE_MAX = 100;
export const TEMPLATE_NAME_MAX = 30;
/** 每个玩家的押注模板上限 */
export const TEMPLATE_LIMIT = 10;

/** 创建房间（在押注 DTO 基础上追加房名 / 备注；房主可稍后经 PATCH 修改）。 */
export class CreateRoomDto extends WagerCreateRoomDto {
  @IsOptional()
  @IsString()
  @MaxLength(ROOM_NAME_MAX)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(ROOM_NOTE_MAX)
  note?: string;
}

/** 加入房间（追加可选留言：房主在确认面板看到"对手想说什么"）。 */
export class JoinRoomDto extends WagerJoinRoomDto {
  @IsOptional()
  @IsString()
  @MaxLength(JOIN_MESSAGE_MAX)
  message?: string;
}

/** 房主修改房名 / 备注（至少给一个字段，服务层校验）。 */
export class UpdateRoomDto {
  @IsOptional()
  @IsString()
  @MaxLength(ROOM_NAME_MAX)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(ROOM_NOTE_MAX)
  note?: string;
}

/** 房主请离加入者（仅在双方确认押注前可用）。 */
export class KickPlayerDto {
  @IsString()
  @IsNotEmpty()
  playerId: string;
}

/** 屏蔽 / 解除屏蔽的目标玩家。 */
export class BlockPlayerDto {
  @IsString()
  @IsNotEmpty()
  playerId: string;
}

/** 保存押注模板（常用押注清单，最多 TEMPLATE_LIMIT 个）。 */
export class SaveTemplateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(TEMPLATE_NAME_MAX)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(ROOM_NOTE_MAX)
  note?: string;

  @ValidateNested()
  @Type(() => BattleWagerDto)
  wager: BattleWagerDto;
}
