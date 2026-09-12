import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Thin wrapper over ioredis. The constructor accepts an optional pre-built client
 * so unit tests can inject ioredis-mock without touching the network.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(public readonly client: Redis) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSec?: number): Promise<void> {
    if (ttlSec && ttlSec > 0) {
      await this.client.set(key, value, 'EX', ttlSec);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length > 0) {
      await this.client.del(...keys);
    }
  }

  /** SET key value NX EX ttl — returns true when the key was newly set. */
  async setNx(key: string, value: string, ttlSec: number): Promise<boolean> {
    const res = await this.client.set(key, value, 'EX', ttlSec, 'NX');
    return res === 'OK';
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      this.logger.warn(`Corrupt JSON at redis key ${key}`);
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSec?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSec);
  }

  /** Sliding-window rate counter. Returns the number of hits inside the window. */
  async slidingWindowHit(key: string, windowMs: number, now = Date.now()): Promise<number> {
    const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
    await this.client
      .multi()
      .zadd(key, now, member)
      .zremrangebyscore(key, 0, now - windowMs)
      .expire(key, Math.ceil(windowMs / 1000) + 1)
      .exec();
    return this.client.zcard(key);
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    await this.client.zadd(key, score, member);
  }

  async zincrby(key: string, delta: number, member: string): Promise<void> {
    await this.client.zincrby(key, delta, member);
  }

  async zrevrangeWithScores(key: string, start: number, stop: number): Promise<Array<{ member: string; score: number }>> {
    const flat = await this.client.zrevrange(key, start, stop, 'WITHSCORES');
    const out: Array<{ member: string; score: number }> = [];
    for (let i = 0; i < flat.length; i += 2) {
      out.push({ member: flat[i], score: Number(flat[i + 1]) });
    }
    return out;
  }

  async sadd(key: string, ...members: string[]): Promise<void> {
    if (members.length > 0) await this.client.sadd(key, ...members);
  }

  async srem(key: string, ...members: string[]): Promise<void> {
    if (members.length > 0) await this.client.srem(key, ...members);
  }

  async smembers(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }
}
