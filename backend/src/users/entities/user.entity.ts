import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ length: 64 })
  username: string;

  @Column({ name: 'password_hash' })
  passwordHash: string;

  @Column({ length: 64 })
  nickname: string;

  @Column({ name: 'avatar_uri', default: '' })
  avatarUri: string;

  /** player | admin | arbitrator */
  @Column({ default: 'player', length: 16 })
  role: string;

  /** Fabric MSP the user belongs to (Org2MSP for arbitrators). */
  @Column({ name: 'fabric_msp_id', default: 'Org1MSP', length: 32 })
  fabricMspId: string;

  /** AES-256-GCM encrypted enrolled certificate (fabric mode only). */
  @Column({ name: 'fabric_cert_enc', type: 'text', nullable: true })
  fabricCertEnc: string | null;

  /** AES-256-GCM encrypted enrollment private key (fabric mode only). */
  @Column({ name: 'fabric_key_enc', type: 'text', nullable: true })
  fabricKeyEnc: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
