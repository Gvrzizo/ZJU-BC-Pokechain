import { expectCode, EXPIRES, ORG1, ORG2, T1, T2, T3, T4, World } from './helpers/harness';

const OFFER_FULL = JSON.stringify({ pokemonIds: ['p_1'], itemIds: ['i_1'], points: 100 });
const REQUEST_FULL = JSON.stringify({ pokemonIds: ['p_2'], itemIds: [], points: 200 });
const OFFER_PTS = JSON.stringify({ pokemonIds: [], itemIds: [], points: 100 });
const REQUEST_PTS = JSON.stringify({ pokemonIds: [], itemIds: [], points: 200 });
const EMPTY = JSON.stringify({ pokemonIds: [], itemIds: [], points: 0 });

async function setupWorld(): Promise<World> {
  const w = new World();
  await w.registerPlayer('u_ash', ORG1);
  await w.registerPlayer('u_gary', ORG2);
  await w.registerPlayer('u_eve', ORG2);
  await w.capturePokemon('p_1', 'u_ash');
  await w.capturePokemon('p_2', 'u_gary');
  await w.mintItem('i_1', 'u_ash', 5);
  return w;
}

describe('TradeContract（双方确认 + 原子结算）', () => {
  let w: World;
  beforeEach(async () => {
    w = await setupWorld();
  });

  test('CreateTrade：校验并锁定全部资产（LOCKED_TRADE/lockRef），积分不动，写 manifestHash', async () => {
    const res = JSON.parse(await w.run(() => w.trade.CreateTrade(w.ctx(ORG1), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t1')));
    expect(res.status).toBe('OPEN');
    expect(res.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await w.getPokemon('p_1')).status).toBe('LOCKED_TRADE');
    expect((await w.getPokemon('p_1')).lockRef).toBe('t_1');
    expect((await w.getItem('i_1')).status).toBe('LOCKED_TRADE');
    expect((await w.getPokemon('p_2')).status).toBe('LOCKED_TRADE');
    // 积分创建时不动
    expect((await w.getPlayer('u_ash')).points).toBe(1000);
    expect((await w.getPlayer('u_gary')).points).toBe(1000);
    expect(w.eventNames()).toContain('TradeCreated');
  });

  test('CreateTrade：双花拒绝——锁定资产再 CreateTrade 抛 ASSET_LOCKED', async () => {
    await w.run(() => w.trade.CreateTrade(w.ctx(ORG1), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t2'));
    const offer2 = JSON.stringify({ pokemonIds: ['p_1'], itemIds: [], points: 0 });
    await expectCode(
      w.run(() => w.trade.CreateTrade(w.ctx(ORG1), 't_2', 'u_ash', 'u_gary', offer2, EMPTY, EXPIRES, T2, 'idem-t3')),
      'ASSET_LOCKED',
    );
  });

  test('CreateTrade：非 fromId 本人创建抛 NOT_OWNER；资产不属于对应方抛 NOT_OWNER；余额不足抛 INSUFFICIENT_POINTS', async () => {
    await expectCode(
      w.run(() => w.trade.CreateTrade(w.ctx(ORG2), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t4')),
      'NOT_OWNER',
    );
    // offer 里放了属于 gary 的 p_2
    const badOffer = JSON.stringify({ pokemonIds: ['p_2'], itemIds: [], points: 0 });
    await expectCode(
      w.run(() => w.trade.CreateTrade(w.ctx(ORG1), 't_2', 'u_ash', 'u_gary', badOffer, EMPTY, EXPIRES, T2, 'idem-t5')),
      'NOT_OWNER',
    );
    // ash 只有 1000 分
    const richOffer = JSON.stringify({ pokemonIds: [], itemIds: [], points: 1001 });
    await expectCode(
      w.run(() => w.trade.CreateTrade(w.ctx(ORG1), 't_3', 'u_ash', 'u_gary', richOffer, EMPTY, EXPIRES, T2, 'idem-t6')),
      'INSUFFICIENT_POINTS',
    );
  });

  test('ConfirmTrade：双方确认后同一交易内原子执行——归属与积分交换、资产解锁、EXECUTED', async () => {
    await w.run(() => w.trade.CreateTrade(w.ctx(ORG1), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t7'));
    const afterFirst = JSON.parse(await w.run(() => w.trade.ConfirmTrade(w.ctx(ORG1), 't_1', 'u_ash', T3, 'idem-t8')));
    expect(afterFirst.status).toBe('OPEN');
    expect(afterFirst.confirmations).toEqual({ from: true, to: false });
    expect((await w.getPokemon('p_1')).status).toBe('LOCKED_TRADE');
    const done = JSON.parse(await w.run(() => w.trade.ConfirmTrade(w.ctx(ORG2), 't_1', 'u_gary', T3, 'idem-t9')));
    expect(done.status).toBe('EXECUTED');
    // 归属交换
    expect((await w.getPokemon('p_1')).ownerId).toBe('u_gary');
    expect((await w.getPokemon('p_1')).status).toBe('IDLE');
    expect((await w.getPokemon('p_2')).ownerId).toBe('u_ash');
    expect((await w.getItem('i_1')).ownerId).toBe('u_gary');
    expect((await w.getItem('i_1')).status).toBe('IDLE');
    // 积分：ash 付 100 收 200 → 1100；gary 收 100 付 200 → 900
    expect((await w.getPlayer('u_ash')).points).toBe(1100);
    expect((await w.getPlayer('u_gary')).points).toBe(900);
  });

  test('ConfirmTrade：执行时余额不足整体回滚——交易仍 OPEN、资产仍锁定、确认标志不残留', async () => {
    await w.run(() => w.trade.CreateTrade(w.ctx(ORG1), 't_1', 'u_ash', 'u_gary', OFFER_PTS, REQUEST_PTS, EXPIRES, T2, 'idem-t10'));
    // gary 把积分转走，执行时付不起 request.points=200
    await w.run(() => w.player.TransferPoints(w.ctx(ORG2), 'u_gary', 'u_eve', '900', T2, 'idem-drain'));
    await w.run(() => w.trade.ConfirmTrade(w.ctx(ORG1), 't_1', 'u_ash', T3, 'idem-t11'));
    await expectCode(w.run(() => w.trade.ConfirmTrade(w.ctx(ORG2), 't_1', 'u_gary', T3, 'idem-t12')), 'INSUFFICIENT_POINTS');
    const trade = await w.getTrade('t_1');
    expect(trade.status).toBe('OPEN');
    expect(trade.confirmations).toEqual({ from: true, to: false });
    expect((await w.getPlayer('u_ash')).points).toBe(1000);
    expect((await w.getPlayer('u_gary')).points).toBe(100);
  });

  test('ConfirmTrade：非当事人抛 NOT_PARTY；冒名当事人（mspId 不符）抛 NOT_OWNER', async () => {
    await w.run(() => w.trade.CreateTrade(w.ctx(ORG1), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t13'));
    await expectCode(w.run(() => w.trade.ConfirmTrade(w.ctx(ORG2), 't_1', 'u_eve', T3, 'idem-t14')), 'NOT_PARTY');
    await expectCode(w.run(() => w.trade.ConfirmTrade(w.ctx(ORG2), 't_1', 'u_ash', T3, 'idem-t15')), 'NOT_OWNER');
  });

  test('CancelTrade：任一方取消，解锁全部资产 → CANCELLED', async () => {
    await w.run(() => w.trade.CreateTrade(w.ctx(ORG1), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t16'));
    const res = JSON.parse(await w.run(() => w.trade.CancelTrade(w.ctx(ORG2), 't_1', 'u_gary', T3, 'idem-t17')));
    expect(res.status).toBe('CANCELLED');
    expect((await w.getPokemon('p_1')).status).toBe('IDLE');
    expect((await w.getPokemon('p_1')).lockRef).toBe('');
    expect((await w.getItem('i_1')).status).toBe('IDLE');
    expect((await w.getPokemon('p_2')).status).toBe('IDLE');
    expect(w.eventNames()).toContain('TradeCancelled');
    // 终态后不可再确认
    await expectCode(w.run(() => w.trade.ConfirmTrade(w.ctx(ORG1), 't_1', 'u_ash', T3, 'idem-t18')), 'TRADE_NOT_OPEN');
  });

  test('ExpireTrade：未到期抛 TRADE_NOT_EXPIRED；到期任何人可触发，解锁 → EXPIRED', async () => {
    await w.run(() => w.trade.CreateTrade(w.ctx(ORG1), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t19'));
    await expectCode(w.run(() => w.trade.ExpireTrade(w.ctx(ORG2), 't_1', T3, 'idem-t20')), 'TRADE_NOT_EXPIRED');
    const res = JSON.parse(await w.run(() => w.trade.ExpireTrade(w.ctx(ORG2), 't_1', EXPIRES, 'idem-t21')));
    expect(res.status).toBe('EXPIRED');
    expect((await w.getPokemon('p_1')).status).toBe('IDLE');
    expect((await w.getItem('i_1')).status).toBe('IDLE');
    expect(w.eventNames()).toContain('TradeExpired');
  });

  test('ConfirmTrade：确认时已过期 → 转 EXPIRED 并解锁，不执行', async () => {
    await w.run(() => w.trade.CreateTrade(w.ctx(ORG1), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t22'));
    const res = JSON.parse(await w.run(() => w.trade.ConfirmTrade(w.ctx(ORG1), 't_1', 'u_ash', EXPIRES, 'idem-t23')));
    expect(res.status).toBe('EXPIRED');
    expect((await w.getPokemon('p_1')).status).toBe('IDLE');
    expect((await w.getPlayer('u_ash')).points).toBe(1000);
    expect(w.eventNames()).toContain('TradeExpired');
  });

  test('QueryByPlayer：from/to 双向可查', async () => {
    await w.run(() => w.trade.CreateTrade(w.ctx(ORG1), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t24'));
    const ashTrades = JSON.parse(await w.run(() => w.trade.QueryByPlayer(w.systemCtx(), 'u_ash')));
    const garyTrades = JSON.parse(await w.run(() => w.trade.QueryByPlayer(w.systemCtx(), 'u_gary')));
    const eveTrades = JSON.parse(await w.run(() => w.trade.QueryByPlayer(w.systemCtx(), 'u_eve')));
    expect(ashTrades).toHaveLength(1);
    expect(garyTrades).toHaveLength(1);
    expect(eveTrades).toHaveLength(0);
  });

  test('已用时间戳确定性：nowISO 非法抛 INVALID_TIME', async () => {
    await expectCode(
      w.run(() => w.trade.CreateTrade(w.ctx(ORG1), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, 'not-a-time', 'idem-t25')),
      'INVALID_TIME',
    );
  });
});
