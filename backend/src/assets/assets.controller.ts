import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsInt, IsNotEmpty, IsString, Length, Min } from 'class-validator';
import { Roles, Public } from '../common/decorators/api.decorators';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditService } from '../admin/audit.service';
import { AssetsService } from './assets.service';

class RegisterAssetDto {
  @IsString()
  @IsNotEmpty()
  uri: string;

  @IsString()
  @Length(64, 64)
  sha256: string;

  @IsInt()
  @Min(0)
  size: number;
}

@Controller('assets')
export class AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly audits: AuditService,
  ) {}

  @Public()
  @Get('manifest')
  manifest() {
    return this.assets.manifest();
  }

  @Roles('admin')
  @Post('register')
  async register(@CurrentUser() user: AuthUser, @Body() dto: RegisterAssetDto) {
    const asset = await this.assets.register(dto.uri, dto.sha256, dto.size, user.username);
    await this.audits.record(user.username, 'assets.register', dto.uri, { sha256: dto.sha256, size: dto.size });
    return asset;
  }
}
