import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [
    {
      provide: RedisService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('redisUrl') ?? 'redis://localhost:6379';
        const client = new Redis(url, {
          lazyConnect: false,
          maxRetriesPerRequest: 2,
          retryStrategy: (times) => Math.min(times * 200, 2000),
        });
        client.on('error', (err) => {
          // avoid crashing the process on transient redis outages; guards will fail closed
          // eslint-disable-next-line no-console
          console.warn(`[redis] ${err.message}`);
        });
        return new RedisService(client);
      },
    },
  ],
  exports: [RedisService],
})
export class RedisModule {}
