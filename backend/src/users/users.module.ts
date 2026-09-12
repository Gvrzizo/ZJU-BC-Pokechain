import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlayerBlock } from './entities/player-block.entity';
import { User } from './entities/user.entity';
import { PlayerBlockService } from './player-block.service';
import { StarterService } from './starter.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, PlayerBlock])],
  controllers: [UsersController],
  providers: [UsersService, StarterService, PlayerBlockService],
  exports: [UsersService, StarterService, PlayerBlockService, TypeOrmModule],
})
export class UsersModule {}
