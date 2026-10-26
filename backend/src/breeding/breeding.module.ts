import { Module } from '@nestjs/common';
import { FabricModule } from '../fabric/fabric.module';
import { BreedingController } from './breeding.controller';
import { BreedingService } from './breeding.service';

// --- [FEAT:breeding] begin ---

@Module({
  imports: [FabricModule],
  controllers: [BreedingController],
  providers: [BreedingService],
})
export class BreedingModule {}

// --- [FEAT:breeding] end ---
