import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// --- [FEAT:dex] begin ---

/**
 * 图鉴解锁记录（持久化）：一旦捕获/领取/进化过某个种族，就永久解锁。
 *
 * 为什么不直接看"当前拥有"：进化会把 speciesId 改掉，低阶种族就不在背包里了；
 * 如果图鉴按当前拥有计算，进化后低阶条目会变回未解锁。
 */
@Entity('pokedex_unlock')
@Index(['playerId', 'speciesId'], { unique: true })
export class PokedexUnlock {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'player_id', type: 'varchar', length: 64 })
  playerId!: string;

  @Column({ name: 'species_id', type: 'int' })
  speciesId!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}

// --- [FEAT:dex] end ---
