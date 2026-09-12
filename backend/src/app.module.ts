import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration from './config/configuration';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { HealthController } from './common/health.controller';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { ReplayInterceptor } from './common/interceptors/replay.interceptor';
import { RedisModule } from './common/redis/redis.module';
import { FabricModule } from './fabric/fabric.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { SocialModule } from './social/social.module';
import { PokemonModule } from './pokemon/pokemon.module';
import { WildModule } from './wild/wild.module';
import { ItemsModule } from './items/items.module';
import { ShopModule } from './shop/shop.module';
import { TradesModule } from './trades/trades.module';
import { BattlesModule } from './battles/battles.module';
import { FairnessModule } from './fairness/fairness.module';
import { AssetsModule } from './assets/assets.module';
import { AdminModule } from './admin/admin.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { RankedModule } from './ranked/ranked.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.secret'),
        signOptions: { expiresIn: config.get<string>('jwt.accessTtl') ?? '15m' },
      }),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>('databaseUrl'),
        autoLoadEntities: true,
        // course environment: schema sync instead of migrations (see README)
        synchronize: true,
      }),
    }),
    RedisModule,
    FabricModule,
    AuthModule,
    UsersModule,
    SocialModule,
    PokemonModule,
    WildModule,
    ItemsModule,
    ShopModule,
    TradesModule,
    BattlesModule,
    FairnessModule,
    AssetsModule,
    AdminModule,
    LeaderboardModule,
    RankedModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: ReplayInterceptor },
  ],
})
export class AppModule {}
