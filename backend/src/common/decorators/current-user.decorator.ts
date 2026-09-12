import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthUser {
  /** users.id (uuid, PG primary key) */
  sub: string;
  /** username == on-chain playerId */
  username: string;
  role: 'player' | 'admin' | 'arbitrator';
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest();
    return req.user as AuthUser;
  },
);
