import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';
import { Roles } from '../common/decorators/api.decorators';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { AdminService } from './admin.service';

class MintItemBody {
  @IsString()
  @IsNotEmpty()
  playerId: string;

  @IsString()
  @IsNotEmpty()
  typeId: string;

  @IsInt()
  @Min(1)
  quantity: number;
}

class AddPointsBody {
  @IsString()
  @IsNotEmpty()
  playerId: string;

  @IsInt()
  delta: number;

  @IsString()
  @IsNotEmpty()
  reason: string;
}

class GrantRoleBody {
  @IsString()
  @IsNotEmpty()
  playerId: string;

  @IsString()
  @IsNotEmpty()
  role: string;
}

@Roles('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Post('items/mint')
  mintItem(@CurrentUser() user: AuthUser, @Body() dto: MintItemBody) {
    return this.admin.mintItem(user.username, dto.playerId, dto.typeId, dto.quantity);
  }

  @Post('points')
  addPoints(@CurrentUser() user: AuthUser, @Body() dto: AddPointsBody) {
    return this.admin.addPoints(user.username, dto.playerId, dto.delta, dto.reason);
  }

  @Post('roles')
  grantRole(@CurrentUser() user: AuthUser, @Body() dto: GrantRoleBody) {
    return this.admin.grantRole(user.username, dto.playerId, dto.role);
  }

  @Get('audit-logs')
  auditLogs(@Query('limit') limit?: string) {
    return this.admin.auditLogs(limit ? parseInt(limit, 10) : 100);
  }
}
