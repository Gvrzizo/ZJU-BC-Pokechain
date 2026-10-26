import { Module } from '@nestjs/common';
import { FabricModule } from '../fabric/fabric.module';
import { HistoryController } from './history.controller';
import { HistoryService } from './history.service';

// --- [FEAT:history] begin ---

@Module({
  imports: [FabricModule],
  controllers: [HistoryController],
  providers: [HistoryService],
})
export class HistoryModule {}

// --- [FEAT:history] end ---
