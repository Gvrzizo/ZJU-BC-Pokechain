import { Test, TestingModule } from '@nestjs/testing';
import RedisMock from 'ioredis-mock';
import { randomUUID } from 'crypto';
import { RedisService } from '../src/common/redis/redis.service';
import { sha256hex } from '../src/common/utils/crypto.util';
import { ChainAdapter } from '../src/fabric/chain.adapter';
import { ADMIN_IDENTITY, SYSTEM_IDENTITY } from '../src/fabric/chain.types';
import { ContractService } from '../src/fabric/contract.service';
import { MockChainAdapter, PERSISTED_METHODS } from '../src/fabric/mock-chain.adapter';
import { MOCK_CHAIN_PREFIX, RedisMockChainStore } from '../src/fabric/mock-chain.store';

/**
 * Cross-process regression for the seeded-demo bug: the mock chain used to be a
 * process-local Map, so `npm run seed` (its own process) minted items/pokemon
 * that the running backend could never see. These tests boot two independent
 * Nest contexts over one Redis (ioredis-mock shares data between clients, like
 * two processes talking to one Redis server).
 */

interface MockProcess {
  app: TestingModule;
  contract: ContractService;
  adapter: MockChainAdapter;
}

/** One "process": own Nest context, own adapter, own Redis connection. */
async function bootProcess(client: RedisMock): Promise<MockProcess> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      { provide: RedisService, useValue: new RedisService(client as never) },
      {
        provide: MockChainAdapter,
        inject: [RedisService],
        useFactory: (redis: RedisService) => new MockChainAdapter(new RedisMockChainStore(redis.client)),
      },
      { provide: ChainAdapter, useExisting: MockChainAdapter },
      ContractService,
    ],
  }).compile();
  await moduleRef.init();
  return { app: moduleRef, contract: moduleRef.get(ContractService), adapter: moduleRef.get(MockChainAdapter) };
}

const SERVER_SEED = 'aa'.repeat(32);
const CLIENT_SEED = 'bb'.repeat(16);

async function seedAshAssets(contract: ContractService, itemId: string, pokemonId: string, eventId: string) {
  await contract.registerPlayer(ADMIN_IDENTITY, 'ash', 'ash', { idemKey: 'register-ash' });
  await contract.mintItem(
    SYSTEM_IDENTITY,
    {
      id: itemId,
      playerId: 'ash',
      typeId: 'poke-ball',
      quantity: 10,
      uri: 'minio://assets/items/poke-ball.png',
      metadataHash: 'x'.repeat(64),
    },
    { idemKey: 'seed-v1-item-ash-poke-ball' },
  );
  await contract.commitRandom(
    SYSTEM_IDENTITY,
    { eventId, purpose: 'capture', playerId: 'ash', commitHash: sha256hex(SERVER_SEED), clientSeed: CLIENT_SEED },
    { idemKey: 'seed-v1-commit-ash-25' },
  );
  await contract.revealAndVerify(SYSTEM_IDENTITY, eventId, SERVER_SEED, { idemKey: 'seed-v1-reveal-ash-25' });
  await contract.mintFromCapture(
    SYSTEM_IDENTITY,
    {
      id: pokemonId,
      playerId: 'ash',
      speciesId: 25,
      name: 'pikachu',
      ivs: { hp: 10, atk: 11, def: 12, spatk: 13, spdef: 14, speed: 15 },
      nature: 'hardy',
      ability: 'static',
      shiny: false,
      moves: ['thunder-shock'],
      dnaHash: sha256hex('pikachu|seed'),
      eventId,
    },
    { idemKey: 'seed-v1-pokemon-ash-25' },
  );
}

describe('mock chain shared through Redis (seed process -> API process)', () => {
  // ioredis-mock shares one dataset between clients (same as one Redis server).
  beforeEach(async () => {
    await new RedisMock().flushall();
  });

  it('a second process reads the assets minted by the first', async () => {
    const itemId = `i_${randomUUID()}`;
    const pokemonId = `p_${randomUUID()}`;

    const seedProc = await bootProcess(new RedisMock());
    await seedAshAssets(seedProc.contract, itemId, pokemonId, `ev_${randomUUID()}`);
    await seedProc.app.close(); // the seed process exits, its in-process state is gone

    const apiProc = await bootProcess(new RedisMock());
    expect((await apiProc.contract.queryPokemonByOwner('ash')).map((p) => p.id)).toEqual([pokemonId]);
    expect((await apiProc.contract.queryItemsByOwner('ash')).map((i) => i.id)).toEqual([itemId]);
    expect((await apiProc.contract.getPokemon(pokemonId)).name).toBe('pikachu');
    await apiProc.app.close();
  });

  it('mutations made by the API process are visible to a later process', async () => {
    const itemId = `i_${randomUUID()}`;
    const pokemonId = `p_${randomUUID()}`;
    const eventId = `ev_${randomUUID()}`;

    const seedProc = await bootProcess(new RedisMock());
    await seedAshAssets(seedProc.contract, itemId, pokemonId, eventId);
    await seedProc.app.close();

    const apiProc = await bootProcess(new RedisMock());
    expect((await apiProc.contract.consumeItem(SYSTEM_IDENTITY, itemId, 3, 'use-potion')).quantity).toBe(7);
    await apiProc.app.close();

    const laterProc = await bootProcess(new RedisMock());
    expect((await laterProc.contract.getItem(itemId)).quantity).toBe(7);
    expect(await laterProc.contract.getRandom(eventId)).toMatchObject({ status: 'CONSUMED', playerId: 'ash' });
    await laterProc.app.close();
  });

  it('rerunning the seed (same fixed ids/idemKeys) neither duplicates nor fails', async () => {
    const seedA = await bootProcess(new RedisMock());
    await seedAshAssets(seedA.contract, 'i_seed_v1_ash-poke-ball', 'p_seed_v1_ash-25', 'ev_seed_v1_ash-25');
    await seedA.app.close();

    const seedB = await bootProcess(new RedisMock());
    await expect(
      seedAshAssets(seedB.contract, 'i_seed_v1_ash-poke-ball', 'p_seed_v1_ash-25', 'ev_seed_v1_ash-25'),
    ).resolves.toBeUndefined();
    expect(await seedB.contract.queryItemsByOwner('ash')).toHaveLength(1);
    expect(await seedB.contract.queryPokemonByOwner('ash')).toHaveLength(1);
    expect((await seedB.contract.getItem('i_seed_v1_ash-poke-ball')).quantity).toBe(10);
    await seedB.app.close();
  });

  it('persists under the mockchain: prefix and resetAll wipes the shared state', async () => {
    const redis = new RedisMock();
    const proc = await bootProcess(redis);
    await proc.contract.registerPlayer(ADMIN_IDENTITY, 'ash', 'ash', { idemKey: 'register-ash' });
    await proc.contract.mintItem(SYSTEM_IDENTITY, {
      id: 'i_shared',
      playerId: 'ash',
      typeId: 'poke-ball',
      quantity: 1,
      uri: 'minio://assets/items/poke-ball.png',
      metadataHash: 'x'.repeat(64),
    });

    expect((await redis.keys(`${MOCK_CHAIN_PREFIX}*`)).sort()).toEqual([
      // --- [FEAT:history] begin ---
      `${MOCK_CHAIN_PREFIX}hist`,
      // --- [FEAT:history] end ---
      `${MOCK_CHAIN_PREFIX}idem`,
      `${MOCK_CHAIN_PREFIX}state`,
    ]);
    await proc.adapter.resetAll();
    expect(await redis.hgetall(`${MOCK_CHAIN_PREFIX}state`)).toEqual({});
    await proc.app.close();
  });

  it('wraps every state-touching ChainAdapter method', () => {
    const internal = new Set([
      'constructor',
      'onChainEvent',
      'runPersisted',
      'withStore',
      'loadRemote',
      'flushRemote',
      'meta',
      'idempotent',
      'emit',
      'get',
      'mustGet',
      'put',
      'assertSafeInt',
      'changePoints',
      'consumeRandom',
      'lockPokemon',
      'lockItem',
      'assertPokemonTradable',
      'assertItemTradable',
      'tradableByTrade',
      'stackOrder',
      'mergeIdleStacks',
      'unlockTradeAssets',
      'executeTrade',
      'lockWager',
      'lockWagerItem',
      'lockedWagerItem',
      'settleInternal',
      'queryAll',
      'matchSelector',
      'resetAll',
      // --- [FEAT:history] begin ---
      'recordHistory',
      // --- [FEAT:history] end ---
    ]);
    const unclassified = Object.getOwnPropertyNames(MockChainAdapter.prototype).filter(
      (name) => !internal.has(name) && !(PERSISTED_METHODS as readonly string[]).includes(name),
    );
    expect(unclassified).toEqual([]);
  });
});
