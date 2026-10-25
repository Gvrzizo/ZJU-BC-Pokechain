import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateTradeDto } from '../src/trades/dto/trades.dto';
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
    // C5：request 只预检不锁定，接收方仍可自由使用/转移
    expect((await contract.getItem(ball.id)).status).toBe('IDLE');

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

  it('创建交易不会锁住对方资产（C5）：B 的资产保持 IDLE，B 可立即转走', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const pika = await seedPokemon(chain, 'ash', { id: 'p_victim_ash' });
    const geodude = await seedPokemon(chain, 'gary', { id: 'p_victim_gary' });
    const ash = userIdentity('ash');
    const gary = userIdentity('gary');
    // ash 请求 gary 的宝可梦 → 只锁 ash 自己的 offer
    await contract.createTrade(ash, {
      id: 't_c5',
      fromId: 'ash',
      toId: 'gary',
      offer: { pokemonIds: [pika.id], itemIds: [], points: 0 },
      request: { pokemonIds: [geodude.id], itemIds: [], points: 0 },
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect((await contract.getPokemon(pika.id)).status).toBe('LOCKED_TRADE');
    expect((await contract.getPokemon(geodude.id)).status).toBe('IDLE');
    expect((await contract.getPokemon(geodude.id)).lockRef).toBe('');
    // gary 完全不知道这笔交易也能正常转走自己的宝可梦
    await contract.transferPokemon(gary, geodude.id, 'ash');
    expect((await contract.getPokemon(geodude.id)).ownerId).toBe('ash');
    // 取消后 ash 的 offer 解锁，gary 的资产从未被锁
    const cancelled = await contract.cancelTrade(ash, 't_c5', 'ash');
    expect(cancelled.status).toBe('CANCELLED');
    expect((await contract.getPokemon(pika.id)).status).toBe('IDLE');
  });

  it('执行时 request 已被转走：抛 NOT_OWNER，offer 仍锁定、交易仍 OPEN（不半结算）', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary', 'eve');
    const pika = await seedPokemon(chain, 'ash', { id: 'p_race_ash' });
    const geodude = await seedPokemon(chain, 'gary', { id: 'p_race_gary' });
    const ash = userIdentity('ash');
    const gary = userIdentity('gary');
    const eve = userIdentity('eve');
    await contract.createTrade(ash, {
      id: 't_race',
      fromId: 'ash',
      toId: 'gary',
      offer: { pokemonIds: [pika.id], itemIds: [], points: 0 },
      request: { pokemonIds: [geodude.id], itemIds: [], points: 0 },
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await contract.confirmTrade(ash, 't_race', 'ash');
    await contract.transferPokemon(gary, geodude.id, 'eve');
    await expect(contract.confirmTrade(gary, 't_race', 'gary')).rejects.toThrow(/NOT_OWNER/);
    const trade = await contract.getTrade('t_race');
    expect(trade.status).toBe('OPEN');
    expect(trade.confirmations).toEqual({ from: true, to: false });
    expect((await contract.getPokemon(pika.id)).status).toBe('LOCKED_TRADE');
    expect((await contract.getPokemon(geodude.id)).ownerId).toBe('eve');
    expect((await contract.getPlayer('ash')).points).toBe(1000);
  });

  it('旧交易兼容：request 已被本单锁定（LOCKED_TRADE/lockRef）仍可执行', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const pika = await seedPokemon(chain, 'ash', { id: 'p_old_ash' });
    const geodude = await seedPokemon(chain, 'gary', { id: 'p_old_gary' });
    const ash = userIdentity('ash');
    const gary = userIdentity('gary');
    await contract.createTrade(ash, {
      id: 't_old',
      fromId: 'ash',
      toId: 'gary',
      offer: { pokemonIds: [pika.id], itemIds: [], points: 0 },
      request: { pokemonIds: [geodude.id], itemIds: [], points: 0 },
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    // 模拟旧版本账本状态：request 资产被本交易锁定
    (chain as unknown as { put: (k: string, v: unknown) => void }).put(`pokemon:${geodude.id}`, {
      ...(await contract.getPokemon(geodude.id)),
      status: 'LOCKED_TRADE',
      lockRef: 't_old',
    });
    await contract.confirmTrade(ash, 't_old', 'ash');
    const done = await contract.confirmTrade(gary, 't_old', 'gary');
    expect(done.status).toBe('EXECUTED');
    expect((await contract.getPokemon(geodude.id)).ownerId).toBe('ash');
    expect((await contract.getPokemon(geodude.id)).status).toBe('IDLE');
  });

  it('TTL 上限：expiresAt 距 nowISO 超过 7 天被拒（INVALID_PARAM），且不留锁', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const pika = await seedPokemon(chain, 'ash', { id: 'p_ttl' });
    const ash = userIdentity('ash');
    const now = new Date();
    await expect(
      contract.createTrade(ash, {
        id: 't_ttl',
        fromId: 'ash',
        toId: 'gary',
        offer: { pokemonIds: [pika.id], itemIds: [], points: 0 },
        request: { pokemonIds: [], itemIds: [], points: 0 },
        expiresAt: new Date(now.getTime() + 8 * 24 * 3600 * 1000).toISOString(),
      }),
    ).rejects.toThrow(/INVALID_PARAM/);
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

  it('DTO：ttlSeconds 限 10 秒 - 7 天（超上限 400，链码同样兜底 7 天）', async () => {
    const base = {
      toPlayerId: 'gary',
      offer: { pokemonIds: [], itemIds: [], points: 0 },
      request: { pokemonIds: [], itemIds: [], points: 0 },
    };
    const build = (ttlSeconds: number) => plainToInstance(CreateTradeDto, { ...base, ttlSeconds });
    expect(await validate(build(7 * 24 * 3600))).toHaveLength(0);
    expect(await validate(build(10))).toHaveLength(0);
    const tooLong = await validate(build(7 * 24 * 3600 + 1));
    expect(tooLong.length).toBeGreaterThan(0);
    expect(JSON.stringify(tooLong)).toContain('ttlSeconds');
    expect((await validate(build(9))).length).toBeGreaterThan(0);
  });

  it('non-owner transfer is rejected (NOT_OWNER)', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const pika = await seedPokemon(chain, 'ash', { id: 'p_own' });
    await expect(contract.transferPokemon(userIdentity('gary'), pika.id, 'gary')).rejects.toThrow(/NOT_OWNER/);
  });
});
