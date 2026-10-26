import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FabricModule } from '../fabric/fabric.module';
// --- [FEAT:dex] begin ---
import { DexModule } from '../dex/dex.module';
// --- [FEAT:dex] end ---
import { CaptureService } from './capture.service';
import { PokemonRename } from './entities/pokemon-rename.entity';
import { PokemonHpService } from './pokemon-hp.service';
import { PokemonController } from './pokemon.controller';
import { PokemonService } from './pokemon.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([PokemonRename]),
    FabricModule,
    // --- [FEAT:dex] begin ---
    DexModule,
    // --- [FEAT:dex] end ---
  ],
  controllers: [PokemonController],
  providers: [PokemonService, CaptureService, PokemonHpService],
  exports: [PokemonService, CaptureService, PokemonHpService],
})
export class PokemonModule {}
