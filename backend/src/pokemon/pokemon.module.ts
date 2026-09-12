import { Module } from '@nestjs/common';
import { CaptureService } from './capture.service';
import { PokemonHpService } from './pokemon-hp.service';
import { PokemonController } from './pokemon.controller';
import { PokemonService } from './pokemon.service';

@Module({
  controllers: [PokemonController],
  providers: [PokemonService, CaptureService, PokemonHpService],
  exports: [PokemonService, CaptureService, PokemonHpService],
})
export class PokemonModule {}
