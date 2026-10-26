import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DexService } from './dex.service';
import { PokedexUnlock } from './pokedex-unlock.entity';

// --- [FEAT:dex] begin ---

@Module({
  imports: [TypeOrmModule.forFeature([PokedexUnlock])],
  providers: [DexService],
  exports: [DexService],
})
export class DexModule {}

// --- [FEAT:dex] end ---
