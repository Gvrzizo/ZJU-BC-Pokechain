import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BattlesModule } from '../battles/battles.module';
import { BondModule } from '../bond/bond.module';
import { FabricModule } from '../fabric/fabric.module';
import { PokemonModule } from '../pokemon/pokemon.module';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { BattleRewardService } from './battle-reward.service';
import { RankedBattleLauncher } from './battle-launcher';
import { RankedBotService } from './bot.service';
import { RankedController } from './ranked.controller';
import { RankedService } from './ranked.service';

/**
 * 排位（docs/backend-api.md §11）：
 * 排队匹配/接受期/积分场/ELO/排行榜（RankedService）、机器人对手（RankedBotService）、
 * 对局 SETTLED 后的应用与兜底（BattleRewardService，监听 BattlesService 的 settled 广播）。
 * PokemonModule 供机器人场经验（×0.5）使用；羁绊走 BondModule（BondUp 口径集中在一处）。
 */
@Module({
  imports: [BattlesModule, UsersModule, PokemonModule, BondModule, FabricModule, TypeOrmModule.forFeature([User])],
  controllers: [RankedController],
  providers: [RankedService, RankedBotService, RankedBattleLauncher, BattleRewardService],
  exports: [RankedService, RankedBotService, BattleRewardService],
})
export class RankedModule {}
