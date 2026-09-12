import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsInt, IsNotEmpty, IsString, Length, Min } from 'class-validator';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Roles, Public } from '../common/decorators/api.decorators';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditLog } from '../admin/entities/audit-log.entity';
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
    @InjectRepository(AuditLog) private readonly audits: Repository<AuditLog>,
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
    await this.audits.save(
      this.audits.create({ actor: user.username, action: 'assets.register', target: dto.uri, detail: { sha256: dto.sha256, size: dto.size } }),
    );
    return asset;
  }
}
