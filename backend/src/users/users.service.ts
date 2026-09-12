import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ContractService } from '../fabric/contract.service';
import { PlayerState } from '../fabric/chain.types';
import { User } from './entities/user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly contract: ContractService,
  ) {}

  findByUsername(username: string): Promise<User | null> {
    return this.users.findOne({ where: { username } });
  }

  findById(id: string): Promise<User | null> {
    return this.users.findOne({ where: { id } });
  }

  async mustFindByUsername(username: string): Promise<User> {
    const user = await this.findByUsername(username);
    if (!user) throw new NotFoundException(`USER_NOT_FOUND: user ${username} does not exist`);
    return user;
  }

  save(user: User): Promise<User> {
    return this.users.save(user);
  }

  create(data: Partial<User>): User {
    return this.users.create(data);
  }

  /** On-chain player state; null when the player is not registered on-chain yet. */
  async chainPlayer(username: string): Promise<PlayerState | null> {
    try {
      return await this.contract.getPlayer(username);
    } catch {
      return null;
    }
  }

  publicProfile(user: User, chain: PlayerState | null) {
    return {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      avatarUri: user.avatarUri,
      role: user.role,
      points: chain?.points ?? null,
      wins: chain?.wins ?? 0,
      losses: chain?.losses ?? 0,
      level: chain ? 1 + Math.floor((chain.wins + chain.losses) / 5) : 1,
      createdAt: user.createdAt,
    };
  }
}
