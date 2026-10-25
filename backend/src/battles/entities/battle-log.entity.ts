import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('battle_logs')
export class BattleLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'battle_id' })
  battleId: string;

  /** Canonical turn log used for resultHash = sha256(canonical(turns)). */
  @Column({ name: 'turns_json', type: 'jsonb' })
  turnsJson: unknown[];

  @Column({ name: 'result_hash', length: 64 })
  resultHash: string;

  @Column({ name: 'server_sig', type: 'text' })
  serverSig: string;

  /** 签名公钥指纹（SigningService.keyId）：换钥后据此选择验签公钥；旧记录为空串。 */
  @Column({ name: 'server_key_id', length: 32, default: '' })
  serverKeyId: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
