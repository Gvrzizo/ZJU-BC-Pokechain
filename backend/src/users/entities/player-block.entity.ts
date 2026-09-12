import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 对战房间的临时屏蔽名单（docs/backend-api.md §5）：房主屏蔽某人后，此人
 * 在 `expires_at` 之前不能加入该房主创建的任何房间。TTL 由记录自己的
 * 过期时间判定（默认 30 分钟，`BATTLE_BLOCK_TTL_MS` 可覆盖），过期记录
 * 在读取时惰性清理，不依赖定时任务。
 */
@Entity('player_blocks')
@Index(['blockerId', 'blockedId'], { unique: true })
export class PlayerBlock {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 屏蔽发起者（房主）playerId，即用户 username */
  @Column({ name: 'blocker_id', length: 64 })
  blockerId: string;

  /** 被屏蔽者 playerId */
  @Column({ name: 'blocked_id', length: 64 })
  blockedId: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
}
