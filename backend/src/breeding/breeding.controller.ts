import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { identityForUser } from '../fabric/chain.types';
import { BreedingService } from './breeding.service';
import { BreedDto } from './dto/breeding.dto';

// --- [FEAT:breeding] begin ---

@Controller('breeding')
export class BreedingController {
  constructor(private readonly breeding: BreedingService) {}

  @Get('config')
  config() {
    return this.breeding.getConfig();
  }

  @Get('lineage/:id')
  lineage(@Param('id') id: string) {
    return this.breeding.getLineage(id);
  }

  @Post('breed')
  breed(@CurrentUser() user: AuthUser, @Body() dto: BreedDto) {
    return this.breeding.breed(identityForUser(user), dto.parentAId, dto.parentBId);
  }
}

// --- [FEAT:breeding] end ---
