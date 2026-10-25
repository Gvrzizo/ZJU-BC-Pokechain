import { Module } from '@nestjs/common';
import { FabricModule } from '../fabric/fabric.module';
import { TradesController } from './trades.controller';
import { TradesService } from './trades.service';

@Module({
  imports: [FabricModule],
  controllers: [TradesController],
  providers: [TradesService],
  exports: [TradesService],
})
export class TradesModule {}
