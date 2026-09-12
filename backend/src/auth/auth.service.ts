import { randomBytes, randomUUID } from 'crypto';
import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { RedisService } from '../common/redis/redis.service';
import { ContractService } from '../fabric/contract.service';
import { FabricCaService } from '../fabric/fabric-ca.service';
import { ADMIN_IDENTITY } from '../fabric/chain.types';
import { encryptSecret } from '../common/utils/secret-box.util';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { LoginDto, RegisterDto } from './dto/auth.dto';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    private readonly contract: ContractService,
    private readonly ca: FabricCaService,
    private readonly config: ConfigService,
  ) {}

  private get fabricMock(): boolean {
    return this.config.get<boolean>('fabric.mock') ?? true;
  }

  /**
   * register = ① PG user (argon2) ② Fabric CA register+enroll (skipped when
   * FABRIC_MOCK) ③ on-chain RegisterPlayer submitted with the admin identity,
   * playerId = username.
   */
  async register(dto: RegisterDto): Promise<{ user: Partial<User> } & TokenPair> {
    const existing = await this.users.findByUsername(dto.username);
    if (existing) {
      throw new ConflictException('USERNAME_TAKEN: username already registered');
    }
    const passwordHash = await argon2.hash(dto.password);
    const user = this.users.create({
      username: dto.username,
      nickname: dto.nickname,
      passwordHash,
      role: 'player',
      fabricMspId: 'Org1MSP',
    });

    if (!this.fabricMock) {
      const { cert, key } = await this.ca.registerAndEnroll(dto.username, 'player');
      const encKey = this.config.get<string>('certEncKey') ?? '';
      user.fabricCertEnc = encryptSecret(cert, encKey);
      user.fabricKeyEnc = encryptSecret(key, encKey);
    }
    await this.users.save(user);

    // chain player record (idempotent; admin identity submits on behalf of the user)
    await this.contract.registerPlayer(ADMIN_IDENTITY, dto.username, dto.nickname, {
      idemKey: `register-${dto.username}`,
    });

    const tokens = await this.issueTokens(user);
    return { user: this.sanitize(user), ...tokens };
  }

  async login(dto: LoginDto): Promise<{ user: Partial<User> } & TokenPair> {
    const user = await this.users.findByUsername(dto.username);
    if (!user) {
      throw new UnauthorizedException('BAD_CREDENTIALS: invalid username or password');
    }
    const ok = await argon2.verify(user.passwordHash, dto.password).catch(() => false);
    if (!ok) {
      throw new UnauthorizedException('BAD_CREDENTIALS: invalid username or password');
    }
    const tokens = await this.issueTokens(user);
    return { user: this.sanitize(user), ...tokens };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: { sub: string; jti: string; type?: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken);
    } catch {
      throw new UnauthorizedException('INVALID_REFRESH: refresh token is invalid or expired');
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('INVALID_REFRESH: not a refresh token');
    }
    const key = this.refreshKey(payload.sub, payload.jti);
    const whitelisted = await this.redis.get(key).catch(() => null);
    if (!whitelisted) {
      throw new UnauthorizedException('REFRESH_REVOKED: refresh token was revoked or rotated');
    }
    const user = await this.users.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('INVALID_REFRESH: user no longer exists');
    }
    await this.redis.del(key); // rotate: old refresh token dies here
    return this.issueTokens(user);
  }

  async logout(refreshToken: string): Promise<{ revoked: boolean }> {
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; jti: string }>(refreshToken);
      await this.redis.del(this.refreshKey(payload.sub, payload.jti));
      return { revoked: true };
    } catch {
      return { revoked: false };
    }
  }

  async issueTokens(user: User): Promise<TokenPair> {
    const accessTtl = this.config.get<string>('jwt.accessTtl') ?? '15m';
    const refreshTtlSec = this.config.get<number>('jwt.refreshTtlSec') ?? 7 * 24 * 3600;
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, username: user.username, role: user.role, type: 'access' },
      { expiresIn: accessTtl },
    );
    const jti = randomUUID();
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, jti, type: 'refresh', nonce: randomBytes(8).toString('hex') },
      { expiresIn: refreshTtlSec },
    );
    await this.redis.set(this.refreshKey(user.id, jti), '1', refreshTtlSec);
    return { accessToken, refreshToken };
  }

  private refreshKey(sub: string, jti: string): string {
    return `refresh:${sub}:${jti}`;
  }

  sanitize(user: User): Partial<User> {
    const { passwordHash, fabricCertEnc, fabricKeyEnc, ...rest } = user;
    return rest;
  }
}
