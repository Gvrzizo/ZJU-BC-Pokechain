import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AppException } from '../utils/errors';
import { RATE_LIMIT_KEY, RateLimitOptions } from '../decorators/api.decorators';
import { AuthUser } from '../decorators/current-user.decorator';
import { RedisService } from '../redis/redis.service';

const DEFAULT_LIMIT = 100;
const DEFAULT_WINDOW_MS = 60_000;

/** Redis sliding-window rate limiter: 100 req/min per user by default; per-route overrides via @RateLimit. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly redis: RedisService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const opts = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const limit = opts?.limit ?? DEFAULT_LIMIT;
    const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
    const keyBy = opts?.keyBy ?? 'user';
    const subject =
      keyBy === 'ip'
        ? `ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`
        : `user:${req.user?.sub ?? req.ip ?? 'anon'}`;
    const key = `rate:${keyBy === 'ip' ? 'ip' : 'user'}:${subject}:${context.getHandler().name}`;

    let hits: number;
    try {
      hits = await this.redis.slidingWindowHit(key, windowMs);
    } catch {
      // fail open when redis is down in the course environment, but never silently for login
      return keyBy !== 'ip';
    }
    if (hits > limit) {
      throw new AppException('RATE_LIMITED', `too many requests (>${limit}/${windowMs / 1000}s)`, HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
