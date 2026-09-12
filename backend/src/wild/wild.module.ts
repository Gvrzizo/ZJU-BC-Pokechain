import { Module } from '@nestjs/common';
import { PokemonModule } from '../pokemon/pokemon.module';
import { RankedModule } from '../ranked/ranked.module';
import { WildController } from './wild.controller';
import { WildService } from './wild.service';

/** 野怪战斗（PvE 捕捉）：羁绊走 RankedModule 的 BondService（BondUp 口径集中在一处）。 */
@Module({
  imports: [PokemonModule, RankedModule],
  controllers: [WildController],
  providers: [WildService],
  exports: [WildService],
})
export class WildModule {}
