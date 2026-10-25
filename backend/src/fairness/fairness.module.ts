import { Module } from '@nestjs/common';
import { BattlesModule } from '../battles/battles.module';
import { FabricModule } from '../fabric/fabric.module';
import { FairnessController } from './fairness.controller';

@Module({
  imports: [BattlesModule, FabricModule],
  controllers: [FairnessController],
})
export class FairnessModule {}
