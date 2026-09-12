import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Off-chain index of disputed battles. The chaincode has no status-rich-query
 * (docs/chaincode-api.md §1 Battle only exposes GetBattle / QueryByPlayer), so
 * the admin/arbitrator dispute list is served from this PG table; every dispute
 * and arbitration flows through BattlesService, keeping the index in sync.
 */
@Entity('dispute_records')
export class DisputeRecord {
  @PrimaryColumn({ name: 'battle_id' })
  battleId: string;

  @Column({ name: 'player_a' })
  playerA: string;

  @Column({ name: 'player_b' })
  playerB: string;

  @Column({ name: 'raised_by' })
  raisedBy: string;

  @Column({ type: 'text' })
  reason: string;

  /** OPEN = awaiting arbitration; RESOLVED = arbitrated on-chain. */
  @Column({ default: 'OPEN' })
  status: 'OPEN' | 'RESOLVED';

  @Column({ type: 'text', nullable: true })
  outcome: string | null;

  @Column({ name: 'arbiter_note', type: 'text', nullable: true })
  arbiterNote: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;
}
