import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { AddFriendDto } from '../auth/dto/auth.dto';
import { SocialService } from './social.service';

@Controller()
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @Get('friends')
  friends(@CurrentUser() user: AuthUser) {
    return this.social.listFriends(user.sub);
  }

  @Post('friends')
  addFriend(@CurrentUser() user: AuthUser, @Body() dto: AddFriendDto) {
    return this.social.addFriend(user.sub, dto.friendId);
  }

  @Delete('friends/:id')
  removeFriend(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.social.removeFriend(user.sub, id);
  }

  @Get('blacklist')
  blacklist(@CurrentUser() user: AuthUser) {
    return this.social.listBlacklist(user.sub);
  }

  @Post('blacklist')
  block(@CurrentUser() user: AuthUser, @Body() dto: AddFriendDto) {
    return this.social.block(user.sub, dto.friendId);
  }

  @Delete('blacklist/:id')
  unblock(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.social.unblock(user.sub, id);
  }
}
