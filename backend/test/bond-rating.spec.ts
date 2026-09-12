import { sha256hex } from '../src/common/utils/crypto.util';
import { computeWagerHash } from '../src/fabric/chain.adapter';
import {
  ADMIN_IDENTITY,
  SYSTEM_IDENTITY,
  makeChain,
  registerPlayers,
  seedPokemon,
  userIdentity,
} from './helpers';

const SERVER_SEED = 'aa'.repeat(32);
const CLIENT_SEED = 'bb'.repeat(16);

/** Mint through the mock capture flow (commit → reveal → MintFromCapture), like the real chaincode. */
async function capturePokemon(contract: ReturnType<typeof makeChain>['contract'], id: string, owner: string) {
  const eventId = `ev_${id}`;
  await contract.commitRandom(SYSTEM_IDENTITY, {
    eventId,
    purpose: 'capture',
    playerId: owner,
    commitHash: sha256hex(SERVER_SEED),
    clientSeed: CLIENT_SEED,
  });
  await contract.revealAndVerify(SYSTEM_IDENTITY, eventId, SERVER_SEED);
  return contract.mintFromCapture(SYSTEM_IDENTITY, {
    id,
    playerId: owner,
    speciesId: 25,
    name: 'pikachu',
    ivs: { hp: 10, atk: 12, def: 8, spatk: 15, spdef: 14, speed: 20 },
    nature: 'hardy',
    ability: 'static',
    shiny: false,
    moves: ['thunder-shock'],
    dnaHash: sha256hex(`dna-${id}`),
    eventId,
  });
}

describe('mock chain: Pokemon.bond (chaincode-api.md §1 Pokemon)', () => {
  it('capture mints with bond=50 (starter shares MintFromCapture)', async () => {
    const { contract } = makeChain();
    await registerPlayers(contract, 'ash');
    const pokemon = await capturePokemon(contract, 'p_mint', 'ash');
    expect(pokemon.bond).toBe(50);
    expect((await contract.getPokemon('p_mint')).bond).toBe(50);
  });

  it('transferPokemon resets bond to 30 on the new owner', async () => {
    const { contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    await capturePokemon(contract, 'p_transfer', 'ash');
    await contract.bondUp(SYSTEM_IDENTITY, ['p_transfer'], 50, 'training');
    expect((await contract.getPokemon('p_transfer')).bond).toBe(100);
    const moved = await contract.transferPokemon(userIdentity('ash'), 'p_transfer', 'gary');
    expect(moved.ownerId).toBe('gary');
    expect(moved.bond).toBe(30);
  });

  it('trade execution resets the bond of both exchanged pokemon', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const pika = await seedPokemon(chain, 'ash', { id: 'p_t1', bond: 200 });
    const eevee = await seedPokemon(chain, 'gary', { id: 'p_t2', bond: 120 });
    const ash = userIdentity('ash');
    const gary = userIdentity('gary');
    await contract.createTrade(ash, {
      id: 't_bond',
      fromId: 'ash',
      toId: 'gary',
      offer: { pokemonIds: [pika.id], itemIds: [], points: 0 },
      request: { pokemonIds: [eevee.id], itemIds: [], points: 0 },
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await contract.confirmTrade(ash, 't_bond', 'ash');
    const done = await contract.confirmTrade(gary, 't_bond', 'gary');
    expect(done.status).toBe('EXECUTED');
    expect((await contract.getPokemon(pika.id)).ownerId).toBe('gary');
    expect((await contract.getPokemon(eevee.id)).ownerId).toBe('ash');
    expect((await contract.getPokemon(pika.id)).bond).toBe(30);
    expect((await contract.getPokemon(eevee.id)).bond).toBe(30);
  });

  it('battle settlement resets the pokemon won from the loser but keeps the winner own bond', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const mine = await seedPokemon(chain, 'ash', { id: 'p_own', bond: 180 });
    const theirs = await seedPokemon(chain, 'gary', { id: 'p_stake', bond: 90 });
    const wagerA = { pokemonIds: [mine.id], itemIds: [], points: 0 };
    const wagerB = { pokemonIds: [theirs.id], itemIds: [], points: 0 };
    const wagerHash = computeWagerHash('ash', 'gary', wagerA, wagerB);
    await contract.createBattle(SYSTEM_IDENTITY, { id: 'b_bond', playerA: 'ash', playerB: 'gary', wagerA, wagerB, wagerHash });
    await contract.activateBattle(SYSTEM_IDENTITY, 'b_bond');
    await contract.submitBattleResult(SYSTEM_IDENTITY, 'b_bond', 'ash', 'r'.repeat(64), 'sig');
    await contract.confirmBattleResult(userIdentity('ash'), 'b_bond', 'ash');
    const settled = await contract.confirmBattleResult(userIdentity('gary'), 'b_bond', 'gary');
    expect(settled.status).toBe('SETTLED');
    expect((await contract.getPokemon(mine.id)).ownerId).toBe('ash');
    expect((await contract.getPokemon(mine.id)).bond).toBe(180);
    expect((await contract.getPokemon(theirs.id)).ownerId).toBe('ash');
    expect((await contract.getPokemon(theirs.id)).bond).toBe(30);
  });

  it('DRAW returns the wagers without touching bond', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const mine = await seedPokemon(chain, 'ash', { id: 'p_draw_own', bond: 180 });
    const theirs = await seedPokemon(chain, 'gary', { id: 'p_draw_stake', bond: 90 });
    const wagerA = { pokemonIds: [mine.id], itemIds: [], points: 0 };
    const wagerB = { pokemonIds: [theirs.id], itemIds: [], points: 0 };
    const wagerHash = computeWagerHash('ash', 'gary', wagerA, wagerB);
    await contract.createBattle(SYSTEM_IDENTITY, { id: 'b_bond_draw', playerA: 'ash', playerB: 'gary', wagerA, wagerB, wagerHash });
    await contract.activateBattle(SYSTEM_IDENTITY, 'b_bond_draw');
    await contract.submitBattleResult(SYSTEM_IDENTITY, 'b_bond_draw', 'DRAW', 'r'.repeat(64), 'sig');
    await contract.confirmBattleResult(userIdentity('ash'), 'b_bond_draw', 'ash');
    await contract.confirmBattleResult(userIdentity('gary'), 'b_bond_draw', 'gary');
    expect((await contract.getPokemon(mine.id)).bond).toBe(180);
    expect((await contract.getPokemon(theirs.id)).bond).toBe(90);
  });

  it('bondUp accumulates, caps at 255 and rejects roles/bounds/released pokemon', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const pika = await seedPokemon(chain, 'ash', { id: 'p_bond', bond: 50 });

    expect((await contract.bondUp(SYSTEM_IDENTITY, [pika.id], 50, 'daily-walk'))[0].bond).toBe(100);
    for (let i = 0; i < 4; i++) {
      await contract.bondUp(SYSTEM_IDENTITY, [pika.id], 50, 'daily-walk');
    }
    expect((await contract.getPokemon(pika.id)).bond).toBe(255);

    await expect(contract.bondUp(userIdentity('ash'), [pika.id], 10, 'cheat')).rejects.toThrow(/NOT_AUTHORIZED/);
    await expect(contract.bondUp(SYSTEM_IDENTITY, [pika.id], 0, 'walk')).rejects.toThrow(/INVALID_PARAM/);
    await expect(contract.bondUp(SYSTEM_IDENTITY, [pika.id], 51, 'walk')).rejects.toThrow(/INVALID_PARAM/);
    await expect(contract.bondUp(SYSTEM_IDENTITY, [], 10, 'walk')).rejects.toThrow(/INVALID_PARAM/);
    await expect(contract.bondUp(SYSTEM_IDENTITY, [pika.id, pika.id], 10, 'walk')).rejects.toThrow(/INVALID_PARAM/);
    await expect(contract.bondUp(SYSTEM_IDENTITY, ['p_nobody'], 10, 'walk')).rejects.toThrow(/POKEMON_NOT_FOUND/);

    const released = await seedPokemon(chain, 'ash', { id: 'p_gone' });
    await contract.releasePokemon(userIdentity('ash'), released.id);
    await expect(contract.bondUp(SYSTEM_IDENTITY, [released.id], 10, 'walk')).rejects.toThrow(/BAD_STATE/);
  });

  it('applyGrowth raises IVs (crown item) but never lowers them (IV_DECREASE)', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash');
    const pika = await seedPokemon(chain, 'ash', { id: 'p_iv' });
    const grown = await contract.applyGrowth(SYSTEM_IDENTITY, pika.id, { ivs: { hp: 31 } });
    expect(grown.ivs).toEqual({ hp: 31, atk: 10, def: 10, spatk: 10, spdef: 10, speed: 10 });
    await expect(contract.applyGrowth(SYSTEM_IDENTITY, pika.id, { ivs: { hp: 30 } })).rejects.toThrow(/IV_DECREASE/);
    await expect(contract.applyGrowth(SYSTEM_IDENTITY, pika.id, { ivs: { hp: 32 } })).rejects.toThrow(/INVALID_PARAM/);
    expect((await contract.getPokemon(pika.id)).ivs.hp).toBe(31);
  });
});

describe('mock chain: Player.rating (chaincode-api.md §1 Player)', () => {
  it('registration defaults to rating=1000 and getPlayer returns it', async () => {
    const { contract } = makeChain();
    await registerPlayers(contract, 'ash');
    expect((await contract.getPlayer('ash')).rating).toBe(1000);
  });

  it('updateRating is system-only and enforces the 0-99999 range', async () => {
    const { contract } = makeChain();
    await registerPlayers(contract, 'ash');
    expect((await contract.updateRating(SYSTEM_IDENTITY, 'ash', 0, 'placement')).rating).toBe(0);
    expect((await contract.updateRating(SYSTEM_IDENTITY, 'ash', 99999, 'battle-win')).rating).toBe(99999);
    await expect(contract.updateRating(userIdentity('ash'), 'ash', 1200, 'cheat')).rejects.toThrow(/NOT_AUTHORIZED/);
    await expect(contract.updateRating(ADMIN_IDENTITY, 'ash', 1200, 'cheat')).rejects.toThrow(/NOT_AUTHORIZED/);
    await expect(contract.updateRating(SYSTEM_IDENTITY, 'ash', -1, 'bad')).rejects.toThrow(/INVALID_PARAM/);
    await expect(contract.updateRating(SYSTEM_IDENTITY, 'ash', 100000, 'bad')).rejects.toThrow(/INVALID_PARAM/);
    await expect(contract.updateRating(SYSTEM_IDENTITY, 'nobody', 1200, 'bad')).rejects.toThrow(/PLAYER_NOT_FOUND/);
    const player = await contract.getPlayer('ash');
    expect(player.rating).toBe(99999);
    expect(player.points).toBe(1000);
  });

  it('legacy records without bond/rating read back as the defaults', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash');
    const pika = await seedPokemon(chain, 'ash', { id: 'p_legacy', bond: 50 });
    const put = (chain as unknown as { put: (k: string, v: unknown) => void }).put.bind(chain);
    const player = await contract.getPlayer('ash');
    delete (player as unknown as Record<string, unknown>).rating;
    put('player:ash', player);
    const raw = await contract.getPokemon(pika.id);
    delete (raw as unknown as Record<string, unknown>).bond;
    put(`pokemon:${pika.id}`, raw);

    expect((await contract.getPlayer('ash')).rating).toBe(1000);
    expect((await contract.getPokemon(pika.id)).bond).toBe(50);
  });
});
