import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Blacklist } from './entities/blacklist.entity';
import { ChatMessage } from './entities/chat-message.entity';
import { Friendship } from './entities/friendship.entity';
import { SocialController } from './social.controller';
import { SocialService } from './social.service';

@Module({
  imports: [TypeOrmModule.forFeature([Friendship, Blacklist, ChatMessage])],
  controllers: [SocialController],
  providers: [SocialService],
  exports: [SocialService],
})
export class SocialModule {}
