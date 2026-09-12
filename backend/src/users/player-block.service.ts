import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppException } from '../common/utils/errors';
import { PlayerBlock } from './entities/player-block.entity';

/** 屏蔽有效期：默认 30 分钟，可用 `BATTLE_BLOCK_TTL_MS` 覆盖（docs/backend-api.md §5）。 */
export const DEFAULT_BLOCK_TTL_MS = 30 * 60 * 1000;

export interface BlockedPlayerView {
  playerId: string;
  blockedAt: string;
  expiresAt: string;
  /** 剩余有效期（毫秒），前端展示"还剩 x 分钟" */
  remainingMs: number;
}

/**
 * 押注房间的临时屏蔽名单（玩家维度）：`blockerId` 屏蔽 `blockedId` 后，
 * 被屏蔽者在 TTL 内不能加入 blocker 创建的房间（BattlesService.joinRoom 拦截）。
 * 记录存 PG（`player_blocks`），过期判定在读取时做，写入会刷新到期时间。
 */
@Injectable()
export class PlayerBlockService {
  constructor(
    @InjectRepository(PlayerBlock) private readonly blocks: Repository<PlayerBlock>,
    private readonly config: ConfigService,
  ) {}

  get ttlMs(): number {
    const raw = Number(this.config.get('BATTLE_BLOCK_TTL_MS') ?? DEFAULT_BLOCK_TTL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BLOCK_TTL_MS;
  }

  /** 屏蔽（幂等：重复屏蔽只顺延到期时间）。不能屏蔽自己。 */
  async block(blockerId: string, blockedId: string): Promise<BlockedPlayerView> {
    if (!blockedId || blockedId === blockerId) {
      throw new AppException('INVALID_PARAM', 'cannot block yourself', HttpStatus.BAD_REQUEST);
    }
    const now = Date.now();
    const expiresAt = new Date(now + this.ttlMs);
    const existing = await this.blocks.findOne({ where: { blockerId, blockedId } });
    const row = existing ?? this.blocks.create({ blockerId, blockedId });
    row.expiresAt = expiresAt;
    const saved = await this.blocks.save(row);
    return toView(saved, now);
  }

  /** 解除屏蔽（幂等：没有记录也返回成功）。 */
  async unblock(blockerId: string, blockedId: string): Promise<{ unblocked: boolean; playerId: string }> {
    await this.blocks.delete({ blockerId, blockedId });
    return { unblocked: true, playerId: blockedId };
  }

  /** 当前仍生效的屏蔽名单（过期记录顺带清掉）。 */
  async list(blockerId: string, now = Date.now()): Promise<BlockedPlayerView[]> {
    const rows = await this.blocks.find({ where: { blockerId } });
    const live: BlockedPlayerView[] = [];
    for (const row of rows) {
      const view = toView(row, now);
      if (view.remainingMs > 0) live.push(view);
      else await this.blocks.delete({ id: row.id });
    }
    return live.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  }

  /** 是否在屏蔽有效期内（`now` 可注入，便于测试过期语义）。 */
  async isBlocked(blockerId: string, blockedId: string, now = Date.now()): Promise<boolean> {
    if (!blockerId || !blockedId) return false;
    const row = await this.blocks.findOne({ where: { blockerId, blockedId } });
    if (!row) return false;
    return new Date(row.expiresAt).getTime() > now;
  }
}

function toView(row: PlayerBlock, now: number): BlockedPlayerView {
  const expiresAt = new Date(row.expiresAt);
  const blockedAt = row.createdAt ? new Date(row.createdAt) : new Date(now);
  return {
    playerId: row.blockedId,
    blockedAt: blockedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    remainingMs: Math.max(0, expiresAt.getTime() - now),
  };
}
