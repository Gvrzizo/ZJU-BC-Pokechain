import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/** Marks an endpoint as reachable without a JWT. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
export type AppRole = 'player' | 'admin' | 'arbitrator';
/** Restricts an endpoint to the given user roles (requires JwtAuthGuard upstream). */
export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);

export const RATE_LIMIT_KEY = 'rateLimit';
export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  /** 'user' keys on the authenticated user, 'ip' on the client IP. */
  keyBy: 'user' | 'ip';
}
export const RateLimit = (opts: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, opts);
