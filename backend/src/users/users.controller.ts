import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { identityForUser } from '../fabric/chain.types';
import { UpdateMeDto } from '../auth/dto/auth.dto';
import { ClaimStarterDto } from './dto/users.dto';
import { RunningShoesService } from './running-shoes.service';
import { StarterService } from './starter.service';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly starters: StarterService,
    private readonly runningShoes: RunningShoesService,
  ) {}

  @Get('me')
  async me(@CurrentUser() auth: AuthUser) {
    const user = await this.users.mustFindByUsername(auth.username);
    const [chain, hasStarter] = await Promise.all([
      this.users.chainPlayer(user.username),
      this.starters.hasStarter(user.username),
    ]);
    return { user: { ...this.users.publicProfile(user, chain), hasStarter } };
  }

  /** 新手礼包：注册后仅一次，三选一御三家（重复调用 409 STARTER_ALREADY_CLAIMED）。 */
  @Post('me/starter')
  claimStarter(@CurrentUser() auth: AuthUser, @Body() dto: ClaimStarterDto) {
    return this.starters.claim(identityForUser(auth), dto.speciesId);
  }

  /**
   * 跑鞋：起始镇「妈妈」赠送的一次性道具（新老账号都可领）。
   * 幂等——重复领取返回已有的那一份（`claimed:false`），不会报错也不会多发。
   */
  @Post('me/running-shoes')
  claimRunningShoes(@CurrentUser() auth: AuthUser) {
    return this.runningShoes.claim(identityForUser(auth));
  }

  @Patch('me')
  async updateMe(@CurrentUser() auth: AuthUser, @Body() dto: UpdateMeDto) {
    const user = await this.users.mustFindByUsername(auth.username);
    if (dto.nickname !== undefined) user.nickname = dto.nickname;
    if (dto.avatarUri !== undefined) user.avatarUri = dto.avatarUri;
    await this.users.save(user);
    const chain = await this.users.chainPlayer(user.username);
    return { user: this.users.publicProfile(user, chain) };
  }

  @Get(':id/profile')
  async profile(@Param('id') id: string) {
    const user = (await this.users.findById(id)) ?? (await this.users.mustFindByUsername(id));
    const chain = await this.users.chainPlayer(user.username);
    return this.users.publicProfile(user, chain);
  }
}
