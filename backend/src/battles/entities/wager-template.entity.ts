import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { WagerBundle } from '../../fabric/chain.types';
import { ESCAPE_MAX_EXPANSION } from '../room-text';

/**
 * 玩家保存的常用押注模板（docs/backend-api.md §5）：名称 + 备注 + 归一后的押注清单，
 * 每个玩家最多 TEMPLATE_LIMIT 个。资产 id 只是"当时选中的清单"，创建/加入房间时
 * 仍走链上权威校验（模板命中已易主/已消耗的资产时由 create/join 报错）。
 */
@Entity('wager_templates')
export class WagerTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 模板归属玩家（username） */
  @Index()
  @Column({ name: 'owner_id', length: 64 })
  ownerId: string;

  /** 展示名：≤30 用户字符，落库前已 HTML 转义，故列宽按最大膨胀倍数预留 */
  @Column({ length: 30 * ESCAPE_MAX_EXPANSION })
  name: string;

  @Column({ type: 'text', default: '' })
  note: string;

  /** 归一后的押注包（与链上 `Battle.wager` 同形态） */
  @Column({ type: 'jsonb' })
  wager: WagerBundle;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
