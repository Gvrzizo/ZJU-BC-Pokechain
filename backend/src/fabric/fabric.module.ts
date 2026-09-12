import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { RedisService } from '../common/redis/redis.service';
import { ChainAdapter } from './chain.adapter';
import { ChainEventsService } from './chain-events.service';
import { ContractService } from './contract.service';
import { FabricCaService } from './fabric-ca.service';
import { FabricChainAdapter } from './fabric-chain.adapter';
import { FabricGatewayService } from './fabric-gateway.service';
import { MockChainAdapter } from './mock-chain.adapter';
import { RedisMockChainStore } from './mock-chain.store';

/** Mock chain state lives in Redis so seed / API / reruns share one world state. */
export function createMockChainAdapter(config: ConfigService, redis: RedisService): MockChainAdapter {
  const mock = config.get<boolean>('fabric.mock') ?? true;
  return new MockChainAdapter(mock ? new RedisMockChainStore(redis.client) : undefined);
}

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [
    FabricGatewayService,
    FabricCaService,
    {
      provide: MockChainAdapter,
      inject: [ConfigService, RedisService],
      useFactory: createMockChainAdapter,
    },
    FabricChainAdapter,
    {
      provide: ChainAdapter,
      inject: [ConfigService, MockChainAdapter, FabricChainAdapter],
      useFactory: (config: ConfigService, mock: MockChainAdapter, fabric: FabricChainAdapter) =>
        (config.get<boolean>('fabric.mock') ?? true ? mock : fabric),
    },
    ContractService,
    ChainEventsService,
  ],
  exports: [ChainAdapter, ContractService, ChainEventsService, FabricCaService, MockChainAdapter],
})
export class FabricModule {}
