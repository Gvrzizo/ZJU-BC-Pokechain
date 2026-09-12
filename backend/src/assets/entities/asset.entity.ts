import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('assets')
@Unique(['uri'])
export class Asset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  uri: string;

  @Column({ length: 64 })
  sha256: string;

  @Column({ type: 'int', default: 0 })
  size: number;

  @Column({ name: 'registered_by', length: 64, default: '' })
  registeredBy: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
