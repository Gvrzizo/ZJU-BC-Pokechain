import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/api.decorators';
import { AuthUser } from '../decorators/current-user.decorator';

/** Global JWT guard; verifies Bearer access tokens and attaches req.user. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('UNAUTHORIZED: missing bearer token');
    }
    try {
      const payload = await this.jwt.verifyAsync<AuthUser & { type?: string }>(token);
      if (payload.type && payload.type !== 'access') {
        throw new Error('wrong token type');
      }
      req.user = { sub: payload.sub, username: payload.username, role: payload.role };
      return true;
    } catch {
      throw new UnauthorizedException('UNAUTHORIZED: invalid or expired token');
    }
  }
}
