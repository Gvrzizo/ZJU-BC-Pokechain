import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { AppException } from '../utils/errors';
import { RedisService } from '../redis/redis.service';

const NONCE_TTL_SEC = 300;
const MAX_SKEW_MS = NONCE_TTL_SEC * 1000;

/**
 * Anti-replay for mutating requests: requires X-Nonce (unique) + X-Timestamp (fresh).
 * Stored as nonce:<uuid> with SET NX EX 300; replays get 409 REPLAY_DETECTED.
 */
@Injectable()
export class ReplayInterceptor implements NestInterceptor {
  constructor(private readonly redis: RedisService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<Request>();
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return next.handle();
    }

    const nonce = req.header('x-nonce');
    const timestamp = req.header('x-timestamp');
    if (!nonce || !/^[\w-]{8,128}$/.test(nonce)) {
      throw new AppException('NONCE_REQUIRED', 'mutating requests require a valid X-Nonce header', HttpStatus.BAD_REQUEST);
    }
    if (!timestamp) {
      throw new AppException('TIMESTAMP_REQUIRED', 'mutating requests require X-Timestamp', HttpStatus.BAD_REQUEST);
    }
    const ts = /^\d+$/.test(timestamp) ? Number(timestamp) : Date.parse(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
      throw new AppException('STALE_TIMESTAMP', 'X-Timestamp is outside the allowed clock skew', HttpStatus.BAD_REQUEST);
    }

    let fresh = true;
    try {
      fresh = await this.redis.setNx(`nonce:${nonce}`, '1', NONCE_TTL_SEC);
    } catch {
      fresh = true; // fail open if redis is unavailable in the course environment
    }
    if (!fresh) {
      throw new AppException('REPLAY_DETECTED', 'X-Nonce was already used', HttpStatus.CONFLICT);
    }
    return next.handle();
  }
}
