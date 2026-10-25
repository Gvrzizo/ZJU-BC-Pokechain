import { Module } from '@nestjs/common';
import { BondModule } from '../bond/bond.module';
import { FabricModule } from '../fabric/fabric.module';
import { PokemonModule } from '../pokemon/pokemon.module';
import { WildController } from './wild.controller';
import { WildService } from './wild.service';

/** 野怪战斗（PvE 捕捉）：羁绊走 BondModule 的 BondService（BondUp 口径集中在一处）。 */
@Module({
  imports: [PokemonModule, BondModule, FabricModule],
  controllers: [WildController],
  providers: [WildService],
  exports: [WildService],
})
export class WildModule {}
