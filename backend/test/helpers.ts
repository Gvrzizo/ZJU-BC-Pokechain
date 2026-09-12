import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import RedisMock from 'ioredis-mock';
import { Subject } from 'rxjs';
import { RedisService } from '../src/common/redis/redis.service';
import { ContractService } from '../src/fabric/contract.service';
import { MockChainAdapter } from '../src/fabric/mock-chain.adapter';
import { PokemonHpService } from '../src/pokemon/pokemon-hp.service';
import { PokemonService } from '../src/pokemon/pokemon.service';
import { PokemonRename } from '../src/pokemon/entities/pokemon-rename.entity';
import { BondService } from '../src/ranked/bond.service';
import { PlayerBlockService } from '../src/users/player-block.service';
import {
  ADMIN_IDENTITY,
  ChainIdentity,
  PokemonState,
  SYSTEM_IDENTITY,
} from '../src/fabric/chain.types';

export function makeRedis(): RedisService {
  return new RedisService(new RedisMock() as never);
}

export function makeChain(): { chain: MockChainAdapter; contract: ContractService } {
  const chain = new MockChainAdapter();
  return { chain, contract: new ContractService(chain) };
}

/** PokemonHpService 的最小构造（链下 Redis 存当前 HP；与调用方共享同一 redis 实例）。 */
export function makeHpService(redis: RedisService = makeRedis()): PokemonHpService {
  return new PokemonHpService(redis);
}

/** PokemonService 的最小构造：链事件流用空 Subject 冒充（升级/进化测试用）。
 * 改名次数仓库默认新建一个内存 mock（`mockRepo`）；需要断言计数时把同一实例传进来。 */
export function makePokemonService(
  contract: ContractService,
  redis: RedisService,
  renames: ReturnType<typeof mockRepo<PokemonRename>> = mockRepo<PokemonRename>(),
): PokemonService {
  return new PokemonService(
    contract,
    redis,
    { stream$: new Subject().asObservable() } as never,
    makeHpService(redis),
    renames as never,
  );
}

/** BondService 的最小构造（野怪战斗的羁绊挂钩，见 src/ranked/bond.service.ts）。
 * 传入 redis 时与调用方共享每日上限记账（bond:day:*）。 */
export function makeBondService(contract: ContractService, redis: RedisService = makeRedis()): BondService {
  return new BondService(contract, redis);
}

/** PlayerBlockService（押注房屏蔽名单）的最小构造：内存仓库 + 默认 30 分钟 TTL。 */
export function makeBlocks(config: ConfigService = makeConfig()): PlayerBlockService {
  return new PlayerBlockService(mockRepo() as never, config);
}

export function makeConfig(values: Record<string, unknown> = {}): ConfigService {
  return new ConfigService(values);
}

export function userIdentity(username: string, role: 'player' | 'arbitrator' | 'admin' = 'player', mspId = 'Org1MSP'): ChainIdentity {
  return { userId: username, role, mspId };
}

export async function registerPlayers(contract: ContractService, ...names: string[]) {
  for (const name of names) {
    await contract.registerPlayer(ADMIN_IDENTITY, name, name, { idemKey: `register-${name}` });
  }
}

export async function mintBall(contract: ContractService, owner: string, id = `i_${randomUUID()}`, typeId = 'poke-ball', quantity = 5) {
  return contract.mintItem(SYSTEM_IDENTITY, {
    id,
    playerId: owner,
    typeId,
    quantity,
    uri: `minio://assets/items/${typeId}.png`,
    metadataHash: 'x'.repeat(64),
  });
}

/** 伤势持久化：seed 出来的宝可梦默认满血（ioredis-mock 在同进程内共享数据，
 * 不清键会残留上一用例战斗后的 HP）。清 HP 的 redis 实例复用一个，避免多开连接。 */
let hpResetRedis: RedisService | null = null;

async function resetHp(pokemonId: string): Promise<void> {
  hpResetRedis ??= makeRedis();
  await hpResetRedis.del(PokemonHpService.key(pokemonId));
}

/** Seed a pokemon directly on the mock chain (bypassing capture) for trade/battle tests. */
export async function seedPokemon(
  chain: MockChainAdapter,
  owner: string,
  overrides: Partial<PokemonState> = {},
): Promise<PokemonState> {
  const id = overrides.id ?? `p_${randomUUID()}`;
  const pokemon: PokemonState = {
    docType: 'pokemon',
    id,
    speciesId: 25,
    name: 'pikachu',
    dnaHash: 'd'.repeat(64),
    ivs: { hp: 10, atk: 10, def: 10, spatk: 10, spdef: 10, speed: 10 },
    evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 },
    nature: 'hardy',
    ability: 'static',
    shiny: false,
    level: 20,
    exp: 0,
    moves: ['tackle'],
    ownerId: owner,
    status: 'IDLE',
    lockRef: '',
    captureEventId: 'ev_seed',
    createdAt: new Date().toISOString(),
    bond: 50,
    ...overrides,
  };
  (chain as unknown as { put: (k: string, v: unknown) => void }).put(`pokemon:${id}`, pokemon);
  await resetHp(id);
  return pokemon;
}

/** Minimal in-memory stand-in for a TypeORM repository. */
export function mockRepo<T extends { id?: string }>() {
  const rows: T[] = [];
  /**
   * 简易 where 匹配：字段全等即命中，另外支持 `In([...])`（排行榜等查询用它按 id 批量取人）。
   * 其余 FindOperator 一律按"等值"处理——测试里用到的查询形态只到这一步。
   */
  const matches = (row: T, where: Partial<T> = {}): boolean =>
    Object.entries(where as Record<string, unknown>).every(([k, v]) => {
      const value = (row as Record<string, unknown>)[k];
      const op = v as { _type?: string; _value?: unknown; value?: unknown } | null;
      if (op && typeof op === 'object' && op._type === 'in') {
        const list = Array.isArray(op._value) ? op._value : op.value;
        return Array.isArray(list) ? list.includes(value) : false;
      }
      return value === v;
    });
  return {
    rows,
    create: (x: Partial<T>) => ({ ...x }) as T,
    save: async (x: T): Promise<T> => {
      if (!x.id) (x as { id: string }).id = randomUUID();
      const idx = rows.findIndex((r) => r.id === x.id);
      if (idx >= 0) rows[idx] = x;
      else rows.push(x);
      return x;
    },
    findOne: async (opts?: { where?: Partial<T> }): Promise<T | null> => {
      if (!opts?.where) return rows[0] ?? null;
      return rows.find((r) => matches(r, opts.where!)) ?? null;
    },
    find: async (opts?: { where?: Partial<T> }): Promise<T[]> =>
      opts?.where ? rows.filter((r) => matches(r, opts.where!)) : [...rows],
    count: async (opts?: { where?: Partial<T> }): Promise<number> =>
      opts?.where ? rows.filter((r) => matches(r, opts.where!)).length : rows.length,
    update: async (where: Partial<T>, patch: Partial<T>): Promise<{ affected: number }> => {
      let affected = 0;
      for (const r of rows) {
        if (matches(r, where)) {
          Object.assign(r, patch);
          affected += 1;
        }
      }
      return { affected };
    },
    delete: async (where?: Partial<T>): Promise<{ affected: number }> => {
      if (!where) return { affected: 0 };
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (matches(rows[i], where)) rows.splice(i, 1);
      }
      return { affected: before - rows.length };
    },
  };
}

export { SYSTEM_IDENTITY, ADMIN_IDENTITY };
