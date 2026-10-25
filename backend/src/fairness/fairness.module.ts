import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BattleLog } from '../battles/entities/battle-log.entity';
import { BattlesModule } from '../battles/battles.module';
import { FabricModule } from '../fabric/fabric.module';
import { FairnessController } from './fairness.controller';

@Module({
  imports: [BattlesModule, FabricModule, TypeOrmModule.forFeature([BattleLog])],
  controllers: [FairnessController],
})
export class FairnessModule {}
