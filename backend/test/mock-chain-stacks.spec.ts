import { childStackId, computeWagerHash } from '../src/fabric/chain.adapter';
import { ContractService } from '../src/fabric/contract.service';
import { MockChainAdapter } from '../src/fabric/mock-chain.adapter';
import { SYSTEM_IDENTITY } from '../src/fabric/chain.types';
import { makeChain, registerPlayers, userIdentity } from './helpers';

/** Mirror of the chaincode's stack semantics (docs/chaincode-api.md §1 Item / §2.4 / §2.6) on the mock chain. */

function makeCtx(): { chain: MockChainAdapter; contract: ContractService } {
  return makeChain();
}

const mint = (
  contract: ContractService,
  owner: string,
  id: string,
  typeId: string,
  quantity: number,
  m?: { nowISO?: string },
) =>
  contract.mintItem(
    SYSTEM_IDENTITY,
    { id, playerId: owner, typeId, quantity, uri: `minio://assets/items/${typeId}.png`, metadataHash: 'x'.repeat(64) },
    m,
  );

/** create -> activate -> submit -> settle (winner takes all unless outcome is DRAW). */
async function fight(contract: ContractService, id: string, wagerA: unknown, wagerB: unknown, outcome: string, playerA = 'ash', playerB = 'gary') {
  const wagerHash = computeWagerHash(playerA, playerB, wagerA as never, wagerB as never);
  await contract.createBattle(SYSTEM_IDENTITY, { id, playerA, playerB, wagerA: wagerA as never, wagerB: wagerB as never, wagerHash });
  await contract.activateBattle(SYSTEM_IDENTITY, id);
  await contract.submitBattleResult(SYSTEM_IDENTITY, id, outcome, 'r'.repeat(64), 'sig');
  await contract.confirmBattleResult(userIdentity(playerA), id, playerA);
  return contract.confirmBattleResult(userIdentity(playerB), id, playerB);
}

describe('mock chain: item stack merging (ItemContract)', () => {
  it('MintItem merges stacks of the same owner+typeId into the oldest one', async () => {
    const { chain, contract } = makeCtx();
    await registerPlayers(contract, 'ash', 'gary');
    const events: string[] = [];
    chain.onChainEvent((name) => events.push(name));
    await mint(contract, 'ash', 'i_a', 'poke-ball', 5, { nowISO: '2026-01-01T00:00:00.000Z' });
    const merged = await mint(contract, 'ash', 'i_b', 'poke-ball', 3, { nowISO: '2026-01-01T01:00:00.000Z' });
    expect(merged).toMatchObject({ id: 'i_a', quantity: 8, status: 'IDLE' });
    await expect(contract.getItem('i_b')).rejects.toThrow(/ITEM_NOT_FOUND/);
    expect(events).toContain('ItemMerged');
    // different typeId / owner stacks are untouched
    const other = await mint(contract, 'ash', 'i_c', 'great-ball', 2);
    const garyItems = await mint(contract, 'gary', 'i_g', 'poke-ball', 1);
    expect(other.quantity).toBe(2);
    expect(garyItems.quantity).toBe(1);
    expect((await contract.queryItemsByOwner('ash')).map((i) => i.id).sort()).toEqual(['i_a', 'i_c']);
  });

  it('MergeStacks is callable by the owner or system, refuses strangers, returns null when nothing to merge', async () => {
    const { contract } = makeCtx();
    await registerPlayers(contract, 'ash', 'gary');
    await mint(contract, 'ash', 'i_a', 'poke-ball', 5, { nowISO: '2026-01-01T00:00:00.000Z' });
    await mint(contract, 'gary', 'i_b', 'poke-ball', 2, { nowISO: '2026-01-01T02:00:00.000Z' });
    // TransferItem keeps whole-stack semantics and does not merge: ash now holds two stacks
    await contract.transferItem(userIdentity('gary'), 'i_b', 'ash');
    expect((await contract.queryItemsByOwner('ash')).length).toBe(2);

    await expect(contract.mergeStacks(userIdentity('gary'), 'ash', 'poke-ball')).rejects.toThrow(/NOT_OWNER/);
    const survivor = await contract.mergeStacks(userIdentity('ash'), 'ash', 'poke-ball');
    expect(survivor).toMatchObject({ id: 'i_a', quantity: 7 });
    expect((await contract.queryItemsByOwner('ash')).map((i) => i.id)).toEqual(['i_a']);

    const none = await contract.mergeStacks(SYSTEM_IDENTITY, 'gary', 'poke-ball');
    expect(none).toBeNull();
  });
});

describe('mock chain: partial wager (BattleContract)', () => {
  it('locks the parent stack whole when qty equals the current quantity (no child stack)', async () => {
    const { contract } = makeCtx();
    await registerPlayers(contract, 'ash', 'gary');
    await mint(contract, 'ash', 'i_part', 'potion', 10);
    const wagerA = { pokemonIds: [] as string[], items: [{ id: 'i_part', qty: 10 }], points: 50 };
    const wagerB = { pokemonIds: [] as string[], items: [], points: 50 };
    const wagerHash = computeWagerHash('ash', 'gary', wagerA, wagerB);
    const battle = await contract.createBattle(SYSTEM_IDENTITY, { id: 'b_whole', playerA: 'ash', playerB: 'gary', wagerA, wagerB, wagerHash });
    expect(battle.wagerA.items).toEqual([{ id: 'i_part', qty: 10 }]);
    expect(await contract.getItem('i_part')).toMatchObject({ quantity: 10, status: 'LOCKED_BATTLE', lockRef: 'b_whole' });
    await expect(contract.getItem(childStackId('i_part', 'b_whole'))).rejects.toThrow(/ITEM_NOT_FOUND/);
  });

  it('partial lock splits the parent stack and keeps it IDLE with a deterministic child id', async () => {
    const { contract } = makeCtx();
    await registerPlayers(contract, 'ash', 'gary');
    await mint(contract, 'ash', 'i_part', 'potion', 10);
    const wagerA = { pokemonIds: [] as string[], items: [{ id: 'i_part', qty: 3 }], points: 50 };
    const wagerB = { pokemonIds: [] as string[], itemIds: [], points: 50 };
    const wagerHash = computeWagerHash('ash', 'gary', wagerA, wagerB);
    await contract.createBattle(SYSTEM_IDENTITY, { id: 'b_split', playerA: 'ash', playerB: 'gary', wagerA, wagerB, wagerHash });

    const parent = await contract.getItem('i_part');
    expect(parent).toMatchObject({ quantity: 7, status: 'IDLE', lockRef: '' });
    const child = await contract.getItem(childStackId('i_part', 'b_split'));
    expect(child).toMatchObject({ id: 'i_part#wb_split', typeId: 'potion', ownerId: 'ash', quantity: 3, status: 'LOCKED_BATTLE', lockRef: 'b_split' });
    const battle = await contract.getBattle('b_split');
    expect(battle.wagerA.items).toEqual([{ id: 'i_part', qty: 3 }]);
    expect(battle.wagerB).toMatchObject({ items: [], points: 50 }); // legacy itemIds normalized to items[]
    expect((await contract.getPlayer('ash')).points).toBe(950);
  });

  it('rejects qty over holdings / non-positive / duplicates / mixed legacy fields', async () => {
    const { contract } = makeCtx();
    await registerPlayers(contract, 'ash', 'gary');
    await mint(contract, 'ash', 'i_part', 'potion', 10);
    const base = { pokemonIds: [] as string[], points: 0 };
    const create = (wagerA: unknown, hashStr?: string) =>
      contract.createBattle(SYSTEM_IDENTITY, {
        id: 'b_bad',
        playerA: 'ash',
        playerB: 'gary',
        wagerA: wagerA as never,
        wagerB: base,
        wagerHash: hashStr ?? 'f'.repeat(64),
      });

    const over = { ...base, items: [{ id: 'i_part', qty: 11 }] };
    await expect(create(over, computeWagerHash('ash', 'gary', over, base))).rejects.toThrow(/INSUFFICIENT_QUANTITY/);
    for (const qty of [0, -1, 1.5]) {
      await expect(create({ ...base, items: [{ id: 'i_part', qty }] })).rejects.toThrow(/INVALID_PARAM/);
    }
    await expect(create({ ...base, items: [{ id: 'i_part', qty: 1 }, { id: 'i_part', qty: 1 }] })).rejects.toThrow(/INVALID_PARAM/);
    await expect(create({ ...base, items: [{ id: 'i_part', qty: 1 }], itemIds: ['i_part'] })).rejects.toThrow(/INVALID_PARAM/);
    expect((await contract.getItem('i_part')).quantity).toBe(10);

    // DTO 默认值形态：items 与空 itemIds 并存按 items 处理
    const withEmptyLegacy = { ...base, items: [{ id: 'i_part', qty: 2 }], itemIds: [] as string[] };
    const battle = await contract.createBattle(SYSTEM_IDENTITY, {
      id: 'b_ok',
      playerA: 'ash',
      playerB: 'gary',
      wagerA: withEmptyLegacy as never,
      wagerB: base,
      wagerHash: computeWagerHash('ash', 'gary', withEmptyLegacy as never, base),
    });
    expect(battle.wagerA.items).toEqual([{ id: 'i_part', qty: 2 }]);
    expect(await contract.getItem('i_part')).toMatchObject({ quantity: 8, status: 'IDLE' });
    expect(await contract.getItem(childStackId('i_part', 'b_ok'))).toMatchObject({ quantity: 2, status: 'LOCKED_BATTLE' });
  });

  it('settle: the winner receives locked stacks and they merge into its oldest stack of that typeId', async () => {
    const { contract } = makeCtx();
    await registerPlayers(contract, 'ash', 'gary');
    await mint(contract, 'ash', 'i_ash', 'potion', 10, { nowISO: '2026-01-01T00:00:00.000Z' });
    await mint(contract, 'gary', 'i_gary', 'potion', 2, { nowISO: '2026-01-01T01:00:00.000Z' });

    const wagerA = { pokemonIds: [] as string[], items: [{ id: 'i_ash', qty: 3 }], points: 50 };
    const wagerB = { pokemonIds: [] as string[], itemIds: ['i_gary'], points: 50 };
    const done = await fight(contract, 'b_win', wagerA, wagerB, 'ash');
    expect(done.status).toBe('SETTLED');

    // ash kept 7, got the 3 back and took gary's 2 -> one stack of 12 (the oldest one survives)
    const stacks = (await contract.queryItemsByOwner('ash')).filter((i) => i.typeId === 'potion');
    expect(stacks).toHaveLength(1);
    expect(stacks[0]).toMatchObject({ id: 'i_ash', quantity: 12, status: 'IDLE', lockRef: '' });
    await expect(contract.getItem('i_gary')).rejects.toThrow(/ITEM_NOT_FOUND/);
    expect((await contract.queryItemsByOwner('gary')).filter((i) => i.typeId === 'potion')).toHaveLength(0);
  });

  it('DRAW: the child stack merges back into its parent stack', async () => {
    const { contract } = makeCtx();
    await registerPlayers(contract, 'ash', 'gary');
    await mint(contract, 'ash', 'i_part', 'potion', 10);
    const wagerA = { pokemonIds: [] as string[], items: [{ id: 'i_part', qty: 3 }], points: 50 };
    const wagerB = { pokemonIds: [] as string[], items: [], points: 50 };
    await fight(contract, 'b_draw', wagerA, wagerB, 'DRAW');

    expect(await contract.getItem('i_part')).toMatchObject({ ownerId: 'ash', quantity: 10, status: 'IDLE', lockRef: '' });
    await expect(contract.getItem(childStackId('i_part', 'b_draw'))).rejects.toThrow(/ITEM_NOT_FOUND/);
    expect((await contract.getPlayer('ash')).points).toBe(1000);
  });

  it('REFUND: restores the child as an independent IDLE stack when the parent moved away', async () => {
    const { contract } = makeCtx();
    await registerPlayers(contract, 'ash', 'gary');
    await mint(contract, 'ash', 'i_part', 'potion', 10);
    const wagerA = { pokemonIds: [] as string[], items: [{ id: 'i_part', qty: 3 }], points: 50 };
    const wagerB = { pokemonIds: [] as string[], items: [], points: 50 };
    const wagerHash = computeWagerHash('ash', 'gary', wagerA, wagerB);
    await contract.createBattle(SYSTEM_IDENTITY, { id: 'b_ref', playerA: 'ash', playerB: 'gary', wagerA, wagerB, wagerHash });
    await contract.transferItem(userIdentity('ash'), 'i_part', 'gary');
    await contract.disputeBattle(userIdentity('gary'), 'b_ref', 'gary', 'server timeout');
    const arbiter = userIdentity('arbiter', 'arbitrator', 'Org2MSP');
    const refunded = await contract.arbitrateBattle(arbiter, 'b_ref', 'REFUND', 'void');
    expect(refunded.status).toBe('REFUNDED');
    expect(await contract.getItem('i_part')).toMatchObject({ ownerId: 'gary', quantity: 7, status: 'IDLE' });
    const restored = await contract.getItem(childStackId('i_part', 'b_ref'));
    expect(restored).toMatchObject({ ownerId: 'ash', quantity: 3, status: 'IDLE', lockRef: '' });
    expect((await contract.getPlayer('ash')).points).toBe(1000);
  });

  it('legacy itemIds wagers still hash and lock as whole stacks', async () => {
    const { contract } = makeCtx();
    await registerPlayers(contract, 'ash', 'gary');
    await mint(contract, 'ash', 'i_old', 'poke-ball', 5);
    const wagerA = { pokemonIds: [] as string[], itemIds: ['i_old'], points: 10 };
    const wagerB = { pokemonIds: [] as string[], itemIds: [], points: 10 };
    const wagerHash = computeWagerHash('ash', 'gary', wagerA, wagerB);
    const battle = await contract.createBattle(SYSTEM_IDENTITY, { id: 'b_old', playerA: 'ash', playerB: 'gary', wagerA, wagerB, wagerHash });
    expect(battle.wagerA).toEqual({ pokemonIds: [], items: [{ id: 'i_old', qty: 0 }], points: 10 });
    expect(await contract.getItem('i_old')).toMatchObject({ quantity: 5, status: 'LOCKED_BATTLE', lockRef: 'b_old' });
  });
});

describe('mock chain: RandomContract meta (commit context)', () => {
  it('stores and returns the optional meta, rejecting >256 bytes', async () => {
    const { contract } = makeCtx();
    await registerPlayers(contract, 'ash');
    const meta = JSON.stringify({ difficulty: 1.25, paidDecoy: true });
    const commit = await contract.commitRandom(SYSTEM_IDENTITY, {
      eventId: 'ev_meta',
      purpose: 'battle',
      playerId: 'ash',
      commitHash: 'a'.repeat(64),
      clientSeed: 'b'.repeat(32),
      meta,
    });
    expect(commit.meta).toBe(meta);
    expect((await contract.getRandom('ev_meta')).meta).toBe(meta);
    const plain = await contract.commitRandom(SYSTEM_IDENTITY, {
      eventId: 'ev_plain',
      purpose: 'capture',
      playerId: 'ash',
      commitHash: 'a'.repeat(64),
      clientSeed: 'b'.repeat(32),
    });
    expect(plain.meta).toBe('');
    await expect(
      contract.commitRandom(SYSTEM_IDENTITY, {
        eventId: 'ev_long',
        purpose: 'capture',
        playerId: 'ash',
        commitHash: 'a'.repeat(64),
        clientSeed: 'b'.repeat(32),
        meta: 'x'.repeat(257),
      }),
    ).rejects.toThrow(/INVALID_PARAM/);
  });
});
