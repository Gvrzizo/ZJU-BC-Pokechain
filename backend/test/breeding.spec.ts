import { makeChain, registerPlayers, seedPokemon, userIdentity } from './helpers';
import { BreedingService } from '../src/breeding/breeding.service';
import { deriveChild, lineageHash } from '../src/breeding/breeding-derive';
import { DeriveStream } from '../src/common/utils/crypto.util';
import type { PokemonState } from '../src/fabric/chain.types';

// --- [FEAT:breeding] begin ---

const SERVER_SEED = 'aa11bb22cc33dd44ee55ff660011223344556677889900aabbccddeeff00112233';
const CLIENT_SEED = 'c1e27a8b9d0ef123c1e27a8b9d0ef123';
const EVENT_ID = 'ev_breed_golden';

const parent = (over: Partial<PokemonState> = {}): PokemonState =>
  ({
    docType: 'pokemon',
    id: 'p_a',
    speciesId: 25,
    name: 'pikachu',
    dnaHash: 'a'.repeat(64),
    ivs: { hp: 5, atk: 10, def: 10, spatk: 10, spdef: 10, speed: 10 },
    evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 },
    nature: 'hardy',
    ability: 'static',
    shiny: false,
    level: 20,
    exp: 0,
    moves: ['tackle'],
    ownerId: 'ash',
    status: 'IDLE',
    lockRef: '',
    captureEventId: 'ev_seed',
    createdAt: '2026-01-01T00:00:00.000Z',
    bond: 50,
    ...over,
  }) as PokemonState;

describe('deriveChild 黄金向量（与链码同公式）', () => {
  test('固定 seed/client/event 下的六项 IV 与性格/闪光', () => {
    const a = parent();
    const b = parent({
      id: 'p_b',
      dnaHash: 'b'.repeat(64),
      ivs: { hp: 25, atk: 20, def: 20, spatk: 20, spdef: 20, speed: 20 },
      nature: 'timid',
    });
    const out = deriveChild(new DeriveStream(SERVER_SEED, CLIENT_SEED, EVENT_ID), a, b);
    // 40% 父 / 40% 母 / 20% 随机；def 落在随机档
    expect(out).toEqual({
      ivs: { hp: 25, atk: 20, def: 6, spatk: 20, spdef: 20, speed: 10 },
      nature: 'hardy',
      shiny: false,
    });
  });

  test('血统承诺 = sha256(版本|双亲id/dnaHash|事件|子代id)', () => {
    const a = parent();
    const b = parent({ id: 'p_b', dnaHash: 'b'.repeat(64) });
    const hash = lineageHash(a, b, EVENT_ID, 'p_child');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // 任一构成要素变化都要改变结果（防伪造血统）
    expect(lineageHash(a, b, EVENT_ID, 'p_child')).not.toBe(lineageHash(a, b, EVENT_ID, 'p_other'));
    expect(lineageHash(a, b, EVENT_ID, 'p_child')).not.toBe(lineageHash(b, a, EVENT_ID, 'p_child'));
  });
});

describe('BreedingService（Mock 链）', () => {
  async function setup() {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const a = await seedPokemon(chain, 'ash', { id: 'p_a', level: 20 });
    const b = await seedPokemon(chain, 'ash', { id: 'p_b', level: 25 });
    return { chain, contract, service: new BreedingService(contract), a, b };
  }

  test('正常繁殖：子代字段、扣 200P、血统可查', async () => {
    const { chain, contract, service, a, b } = await setup();
    const before = (await contract.getPlayer('ash')).points;

    const child = await service.breed(userIdentity('ash'), a.id, b.id);

    expect(child).toMatchObject({
      ownerId: 'ash',
      status: 'IDLE',
      level: 1,
      exp: 0,
      bond: 50,
      generation: 1,
      parents: ['p_a', 'p_b'],
      speciesId: 25,
    });
    expect((await contract.getPlayer('ash')).points).toBe(before - 200);
    expect(await chain.getPokemon(child.id)).toMatchObject({ id: child.id, dnaHash: child.dnaHash });
    // 子代 dnaHash 是血统承诺，不是亲代的
    expect(child.dnaHash).not.toBe(a.dnaHash);
    expect(child.dnaHash).not.toBe(b.dnaHash);

    const lineage = await service.getLineage(child.id);
    expect(lineage).toMatchObject({ id: child.id, generation: 1 });
    expect(lineage.parents.map((p) => p.id)).toEqual(['p_a', 'p_b']);
  });

  test('配置读链上：等级门槛与费用', async () => {
    const { service } = await setup();
    const config = await service.getConfig();
    expect(config).toMatchObject({ minLevel: 20, cost: 200 });
    expect(config.layout).toMatchObject({ ivBlock: 50000, natureSlot: 50012 });
  });

  test('不是自己的宝可梦：预校验直接拒绝', async () => {
    const { service, a, b } = await setup();
    await expect(service.breed(userIdentity('gary'), a.id, b.id)).rejects.toThrow(/NOT_OWNER/);
  });

  test('同一只亲代拒绝', async () => {
    const { service, a } = await setup();
    await expect(service.breed(userIdentity('ash'), a.id, a.id)).rejects.toThrow(/INVALID_PARAM/);
  });

  test('等级不足拒绝', async () => {
    const { chain, contract, service, a } = await setup();
    const low = await seedPokemon(chain, 'ash', { id: 'p_low', level: 5 });
    await expect(service.breed(userIdentity('ash'), a.id, low.id)).rejects.toThrow(/INVALID_PARAM/);
    // 不产生任何链上副作用
    expect((await contract.getPlayer('ash')).points).toBe(1000);
  });

  test('亲代被锁定（交易/对战）拒绝', async () => {
    const { chain, contract, service, a, b } = await setup();
    // 直接改状态模拟锁定（真实路径由交易/对战产生）
    const locked = { ...a, status: 'LOCKED_TRADE' as const };
    (chain as unknown as { put: (k: string, v: unknown) => void }).put(`pokemon:${a.id}`, locked);
    void contract;
    await expect(service.breed(userIdentity('ash'), a.id, b.id)).rejects.toThrow(/ASSET_LOCKED/);
  });
});

// --- [FEAT:breeding] end ---
