import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * 改名次数（链下 PG，docs/backend-api.md §2「改名」）：链上只保留最新 `name`，
 * "第一次免费、之后每次收费"的计数存在这里。`count` = 已完成改名次数，
 * 0 表示从未改名；改名请求的收费幂等键按 `count + 1` 派生，重放不会重复扣分。
 */
@Entity('pokemon_rename')
export class PokemonRename {
  @PrimaryColumn({ name: 'pokemon_id', length: 128 })
  pokemonId: string;

  @Column({ type: 'int', default: 0 })
  count: number;
}
