import { Module } from '@nestjs/common';
import { BattlesModule } from '../battles/battles.module';
import { FairnessController } from './fairness.controller';

@Module({
  imports: [BattlesModule],
  controllers: [FairnessController],
})
export class FairnessModule {}
