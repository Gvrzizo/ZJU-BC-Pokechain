import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ length: 64 })
  actor: string;

  @Column({ length: 64 })
  action: string;

  @Column({ length: 128, default: '' })
  target: string;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  detail: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
