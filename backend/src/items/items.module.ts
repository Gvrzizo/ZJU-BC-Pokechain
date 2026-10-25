import { Module } from '@nestjs/common';
import { FabricModule } from '../fabric/fabric.module';
import { PokemonModule } from '../pokemon/pokemon.module';
import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';

@Module({
  imports: [PokemonModule, FabricModule],
  controllers: [ItemsController],
  providers: [ItemsService],
  exports: [ItemsService],
})
export class ItemsModule {}
