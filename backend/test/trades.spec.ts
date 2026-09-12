import { userIdentity, makeChain, mintBall, registerPlayers, seedPokemon } from './helpers';

describe('Trade flow on MockChain (full lifecycle)', () => {
  it('create locks assets -> both confirm -> atomic execution (owners + points)', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const pika = await seedPokemon(chain, 'ash', { id: 'p_trade_1' });
    const ball = await mintBall(contract, 'gary', 'i_trade_1', 'ultra-ball', 2);

    const ash = userIdentity('ash');
    const gary = userIdentity('gary');
    // ash gives pikachu + 50 points; gary gives the ball stack
    const trade = await contract.createTrade(ash, {
      id: 't_1',
      fromId: 'ash',
      toId: 'gary',
      offer: { pokemonIds: [pika.id], itemIds: [], points: 50 },
      request: { pokemonIds: [], itemIds: [ball.id], points: 0 },
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(trade.status).toBe('OPEN');
    expect((await contract.getPokemon(pika.id)).status).toBe('LOCKED_TRADE');
    expect((await contract.getItem(ball.id)).status).toBe('LOCKED_TRADE');

    await contract.confirmTrade(ash, trade.id, 'ash');
    const done = await contract.confirmTrade(gary, trade.id, 'gary');
    expect(done.status).toBe('EXECUTED');
    expect((await contract.getPokemon(pika.id)).ownerId).toBe('gary');
    expect((await contract.getItem(ball.id)).ownerId).toBe('ash');
    expect((await contract.getPlayer('ash')).points).toBe(950);
    expect((await contract.getPlayer('gary')).points).toBe(1050);
    // assets unlocked after execution
    expect((await contract.getPokemon(pika.id)).status).toBe('IDLE');
  });

  it('rejects double-spend of a locked asset with ASSET_LOCKED', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const pika = await seedPokemon(chain, 'ash', { id: 'p_lock' });
    const ash = userIdentity('ash');
    await contract.createTrade(ash, {
      id: 't_lock_1',
      fromId: 'ash',
      toId: 'gary',
      offer: { pokemonIds: [pika.id], itemIds: [], points: 0 },
      request: { pokemonIds: [], itemIds: [], points: 10 },
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await expect(
      contract.createTrade(ash, {
        id: 't_lock_2',
        fromId: 'ash',
        toId: 'gary',
        offer: { pokemonIds: [pika.id], itemIds: [], points: 0 },
        request: { pokemonIds: [], itemIds: [], points: 5 },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    ).rejects.toThrow(/ASSET_LOCKED/);
    // and direct transfer of the locked pokemon fails too
    await expect(contract.transferPokemon(ash, pika.id, 'gary')).rejects.toThrow(/ASSET_LOCKED/);
  });

  it('cancel unlocks all assets', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const pika = await seedPokemon(chain, 'ash', { id: 'p_cancel' });
    const ash = userIdentity('ash');
    const gary = userIdentity('gary');
    await contract.createTrade(ash, {
      id: 't_cancel',
      fromId: 'ash',
      toId: 'gary',
      offer: { pokemonIds: [pika.id], itemIds: [], points: 0 },
      request: { pokemonIds: [], itemIds: [], points: 0 },
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const cancelled = await contract.cancelTrade(gary, 't_cancel', 'gary');
    expect(cancelled.status).toBe('CANCELLED');
    expect((await contract.getPokemon(pika.id)).status).toBe('IDLE');
    expect((await contract.getPokemon(pika.id)).ownerId).toBe('ash');
  });

  it('confirming an expired trade marks it EXPIRED, unlocks and throws TRADE_EXPIRED', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const pika = await seedPokemon(chain, 'ash', { id: 'p_exp' });
    const ash = userIdentity('ash');
    const gary = userIdentity('gary');
    await contract.createTrade(ash, {
      id: 't_exp',
      fromId: 'ash',
      toId: 'gary',
      offer: { pokemonIds: [pika.id], itemIds: [], points: 0 },
      request: { pokemonIds: [], itemIds: [], points: 0 },
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    });
    await expect(
      contract.confirmTrade(gary, 't_exp', 'gary', {
        nowISO: new Date(Date.now() + 5000).toISOString(),
      }),
    ).rejects.toThrow(/TRADE_EXPIRED/);
    expect((await contract.getTrade('t_exp')).status).toBe('EXPIRED');
    expect((await contract.getPokemon(pika.id)).status).toBe('IDLE');
  });

  it('idempotent replay returns the first result without re-applying changes', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const ash = userIdentity('ash');
    const gary = userIdentity('gary');
    const t = await contract.createTrade(
      ash,
      {
        id: 't_idem',
        fromId: 'ash',
        toId: 'gary',
        offer: { pokemonIds: [], itemIds: [], points: 100 },
        request: { pokemonIds: [], itemIds: [], points: 0 },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      { idemKey: 'create-t_idem' },
    );
    // replay the create with the same idemKey — no error, no duplicate
    const replayedCreate = await contract.createTrade(
      ash,
      {
        id: 't_idem',
        fromId: 'ash',
        toId: 'gary',
        offer: { pokemonIds: [], itemIds: [], points: 100 },
        request: { pokemonIds: [], itemIds: [], points: 0 },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      { idemKey: 'create-t_idem' },
    );
    expect(replayedCreate.id).toBe(t.id);
    await contract.confirmTrade(ash, t.id, 'ash', { idemKey: 'confirm-ash' });
    await contract.confirmTrade(gary, t.id, 'gary', { idemKey: 'confirm-gary' });
    // replay gary's confirm: must NOT move the points again
    const replayed = await contract.confirmTrade(gary, t.id, 'gary', { idemKey: 'confirm-gary' });
    expect(replayed.status).toBe('EXECUTED');
    expect((await contract.getPlayer('ash')).points).toBe(900);
    expect((await contract.getPlayer('gary')).points).toBe(1100);
  });

  it('non-owner transfer is rejected (NOT_OWNER)', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const pika = await seedPokemon(chain, 'ash', { id: 'p_own' });
    await expect(contract.transferPokemon(userIdentity('gary'), pika.id, 'gary')).rejects.toThrow(/NOT_OWNER/);
  });
});
