import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from '../admin/entities/audit-log.entity';
import { FabricModule } from '../fabric/fabric.module';
import { PokemonModule } from '../pokemon/pokemon.module';
import { UsersModule } from '../users/users.module';
import { BattleGateway } from './battle.gateway';
import { BattleManagerService } from './battle-manager.service';
import { BattlesController } from './battles.controller';
import { BattlesService } from './battles.service';
import { BattleLog } from './entities/battle-log.entity';
import { DisputeRecord } from './entities/dispute-record.entity';
import { WagerTemplate } from './entities/wager-template.entity';
import { SigningService } from './signing.service';
import { WagerTemplateService } from './wager-template.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([BattleLog, AuditLog, DisputeRecord, WagerTemplate]),
    UsersModule,
    PokemonModule,
    FabricModule,
  ],
  controllers: [BattlesController],
  providers: [BattlesService, BattleManagerService, BattleGateway, SigningService, WagerTemplateService],
  exports: [BattlesService, BattleManagerService, SigningService],
})
export class BattlesModule {}
