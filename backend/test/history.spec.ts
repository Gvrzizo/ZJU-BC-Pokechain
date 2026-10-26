import { makeChain, registerPlayers, seedPokemon, userIdentity } from './helpers';
import { projectHistory } from '../src/history/history.service';
import { ChainHistoryEntry, ChainHistoryResult } from '../src/fabric/chain.types';

// --- [FEAT:history] begin ---

function entry(overrides: Partial<ChainHistoryEntry> = {}): ChainHistoryEntry {
  return {
    txId: 'tx',
    at: '2026-01-01T00:00:00.000Z',
    ownerId: 'ash',
    name: 'pikachu',
    level: 5,
    speciesId: 25,
    bond: 50,
    status: 'IDLE',
    ...overrides,
  };
}

/** 链码返回的是 { summary, entries }：summary 来自完整历史，entries 是最新 N 条。 */
function result(entriesNewestFirst: ChainHistoryEntry[], overrides: Partial<ChainHistoryResult['summary']> = {}): ChainHistoryResult {
  const ordered = [...entriesNewestFirst].reverse();
  let transfers = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].ownerId !== ordered[i - 1].ownerId) transfers += 1;
  }
  return {
    summary: {
      firstOwner: ordered[0]?.ownerId ?? '',
      currentOwner: ordered[ordered.length - 1]?.ownerId ?? '',
      transfers,
      versions: ordered.length,
      truncated: false,
      ...overrides,
    },
    entries: entriesNewestFirst,
  };
}

describe('projectHistory（纯函数）', () => {
  test('单条记录 = 收服，初训家即 owner', () => {
    const history = projectHistory('p1', result([entry()]));
    expect(history).toMatchObject({ pokemonId: 'p1', firstOwner: 'ash', currentOwner: 'ash', transfers: 0, versions: 1 });
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].type).toBe('capture');
  });

  test('易主记 transfer，并累计转手次数', () => {
    const history = projectHistory(
      'p1',
      result([entry({ ownerId: 'gary', txId: 't2' }), entry({ ownerId: 'ash', txId: 't1' })]),
    );
    expect(history.firstOwner).toBe('ash');
    expect(history.currentOwner).toBe('gary');
    expect(history.transfers).toBe(1);
    expect(history.entries[0]).toMatchObject({ type: 'transfer', from: 'ash', to: 'gary', txId: 't2' });
  });

  test('同一版本里易主 + 升级：产生两条事件', () => {
    const history = projectHistory(
      'p1',
      result([entry({ ownerId: 'gary', level: 9, txId: 't2' }), entry({ ownerId: 'ash', level: 5, txId: 't1' })]),
    );
    const types = history.entries.map((e) => e.type);
    expect(types).toContain('transfer');
    expect(types).toContain('level');
  });

  test('改名按 name 变化识别', () => {
    const history = projectHistory(
      'p1',
      result([entry({ name: '皮卡丘', txId: 't2' }), entry({ name: 'pikachu', txId: 't1' })]),
    );
    expect(history.entries[0]).toMatchObject({ type: 'rename', from: 'pikachu', to: '皮卡丘' });
  });

  test('进化按 speciesId 变化识别', () => {
    const history = projectHistory(
      'p1',
      result([entry({ speciesId: 26, txId: 't2' }), entry({ speciesId: 25, txId: 't1' })]),
    );
    expect(history.entries[0]).toMatchObject({ type: 'evolve', from: 25, to: 26 });
  });

  test('放生：owner 清空并记 release', () => {
    const history = projectHistory(
      'p1',
      result([entry({ ownerId: '', status: 'RELEASED', txId: 't2' }), entry({ ownerId: 'ash', txId: 't1' })]),
    );
    expect(history.currentOwner).toBe('');
    expect(history.entries.map((e) => e.type)).toContain('release');
    expect(history.transfers).toBe(1);
  });

  test('窗口被截断时：摘要仍准确，且不伪造"收服"事件', () => {
    // 真实历史 300 条，只返回最近 2 条；summary 由链码在完整历史上算好
    const history = projectHistory(
      'p1',
      result([entry({ ownerId: 'gary', level: 40, txId: 't300' }), entry({ ownerId: 'ash', level: 39, txId: 't299' })], {
        firstOwner: 'ash',
        currentOwner: 'gary',
        transfers: 7,
        versions: 300,
        truncated: true,
      }),
    );
    expect(history).toMatchObject({ firstOwner: 'ash', transfers: 7, versions: 300, truncated: true });
    // 第一条不再被当作"收服"
    expect(history.entries.map((e) => e.type)).not.toContain('capture');
    // 窗口内仍能看到这次易主与升级（同一版本内顺序不保证，故只断言存在）
    expect(history.entries).toContainEqual(expect.objectContaining({ type: 'transfer', from: 'ash', to: 'gary' }));
    expect(history.entries).toContainEqual(expect.objectContaining({ type: 'level', from: 39, to: 40 }));
  });
});

describe('MockChainAdapter.getPokemonHistory（与真链同形的只读查询）', () => {
  test('未存在过的宝可梦抛 POKEMON_NOT_FOUND', async () => {
    const { chain } = makeChain();
    await expect(chain.getPokemonHistory('p_missing')).rejects.toThrow(/POKEMON_NOT_FOUND/);
  });

  test('seed 后一条、转移后两条，最新在前', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const pokemon = await seedPokemon(chain, 'ash');

    expect((await chain.getPokemonHistory(pokemon.id)).entries).toHaveLength(1);
    await chain.transferPokemon(userIdentity('ash'), { id: pokemon.id, toId: 'gary' });

    const { summary, entries } = await chain.getPokemonHistory(pokemon.id);
    expect(entries).toHaveLength(2);
    expect(entries[0].ownerId).toBe('gary');
    expect(entries[1].ownerId).toBe('ash');
    expect(summary).toMatchObject({ firstOwner: 'ash', currentOwner: 'gary', transfers: 1, versions: 2, truncated: false });
  });

  test('maxEntries 只截断明细，summary 不变', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const pokemon = await seedPokemon(chain, 'ash');
    await chain.transferPokemon(userIdentity('ash'), { id: pokemon.id, toId: 'gary' });

    const { summary, entries } = await chain.getPokemonHistory(pokemon.id, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0].ownerId).toBe('gary');
    expect(summary).toMatchObject({ firstOwner: 'ash', transfers: 1, truncated: true });
  });
});

// --- [FEAT:history] end ---
