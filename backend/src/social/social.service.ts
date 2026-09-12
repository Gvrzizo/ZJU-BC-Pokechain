import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Blacklist } from './entities/blacklist.entity';
import { Friendship } from './entities/friendship.entity';

@Injectable()
export class SocialService {
  constructor(
    @InjectRepository(Friendship) private readonly friendships: Repository<Friendship>,
    @InjectRepository(Blacklist) private readonly blacklists: Repository<Blacklist>,
  ) {}

  listFriends(userId: string): Promise<Friendship[]> {
    return this.friendships.find({ where: { userId } });
  }

  async addFriend(userId: string, friendId: string): Promise<Friendship> {
    if (userId === friendId) {
      throw new ConflictException('INVALID_FRIEND: cannot friend yourself');
    }
    const existing = await this.friendships.findOne({ where: { userId, friendId } });
    if (existing) return existing;
    return this.friendships.save(this.friendships.create({ userId, friendId }));
  }

  async removeFriend(userId: string, friendId: string): Promise<{ removed: boolean }> {
    const res = await this.friendships.delete({ userId, friendId });
    if (!res.affected) throw new NotFoundException('FRIEND_NOT_FOUND: not in your friend list');
    return { removed: true };
  }

  listBlacklist(userId: string): Promise<Blacklist[]> {
    return this.blacklists.find({ where: { userId } });
  }

  async block(userId: string, blockedId: string): Promise<Blacklist> {
    if (userId === blockedId) {
      throw new ConflictException('INVALID_BLOCK: cannot block yourself');
    }
    const existing = await this.blacklists.findOne({ where: { userId, blockedId } });
    if (existing) return existing;
    return this.blacklists.save(this.blacklists.create({ userId, blockedId }));
  }

  async unblock(userId: string, blockedId: string): Promise<{ removed: boolean }> {
    const res = await this.blacklists.delete({ userId, blockedId });
    if (!res.affected) throw new NotFoundException('BLOCK_NOT_FOUND: not in your blacklist');
    return { removed: true };
  }
}
