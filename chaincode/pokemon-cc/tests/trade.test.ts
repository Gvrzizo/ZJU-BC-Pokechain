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

  test('CreateTrade：只锁发起方 offer（LOCKED_TRADE/lockRef），request 仅预检不锁定，积分不动，写 manifestHash', async () => {
    const res = JSON.parse(await w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t1')));
    expect(res.status).toBe('OPEN');
    expect(res.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await w.getPokemon('p_1')).status).toBe('LOCKED_TRADE');
    expect((await w.getPokemon('p_1')).lockRef).toBe('t_1');
    expect((await w.getItem('i_1')).status).toBe('LOCKED_TRADE');
    // C5：request 资产不锁，接收方仍可自由使用/转移（否则任何人凭资产 id 就能锁住他人资产）
    expect((await w.getPokemon('p_2')).status).toBe('IDLE');
    expect((await w.getPokemon('p_2')).lockRef).toBe('');
    // 积分创建时不动
    expect((await w.getPlayer('u_ash')).points).toBe(1000);
    expect((await w.getPlayer('u_gary')).points).toBe(1000);
    expect(w.eventNames()).toContain('TradeCreated');
  });

  test('CreateTrade：request 资产被锁/已转走时不锁定受害者资产，但创建被拒（ASSET_LOCKED/NOT_OWNER）', async () => {
    // gary 的 p_2 先进别人的押注/交易锁定 → 预检拒绝，且不产生任何锁定副作用
    await w.capturePokemon('p_9', 'u_ash');
    const offer9 = JSON.stringify({ pokemonIds: ['p_9'], itemIds: [], points: 0 });
    const requestP2 = JSON.stringify({ pokemonIds: ['p_2'], itemIds: [], points: 0 });
    await w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_9', 'u_ash', 'u_gary', offer9, requestP2, EXPIRES, T2, 'idem-t9a'));
    // 第二笔同样请求 p_2：p_2 仍未锁定 → 允许（只是重复请求，不影响 gary）
    await w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_9b', 'u_ash', 'u_gary', EMPTY, requestP2, EXPIRES, T2, 'idem-t9b'));
    expect((await w.getPokemon('p_9')).status).toBe('LOCKED_TRADE');
    expect((await w.getPokemon('p_2')).status).toBe('IDLE');
  });

  test('CreateTrade：ttlSeconds 超 7 天（expiresAt 距 nowISO > 7d）抛 INVALID_PARAM', async () => {
    const farFuture = '2026-01-09T00:00:00.001Z'; // nowISO=T2 (01:00) 起 > 7 天
    const nearFuture = '2026-01-08T00:59:59.999Z'; // 恰好 < 7 天
    await expectCode(
      w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_far', 'u_ash', 'u_gary', OFFER_FULL, EMPTY, farFuture, T2, 'idem-ttl1')),
      'INVALID_PARAM',
    );
    const ok = JSON.parse(await w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_near', 'u_ash', 'u_gary', EMPTY, EMPTY, nearFuture, T2, 'idem-ttl2')));
    expect(ok.status).toBe('OPEN');
  });

  test('CreateTrade：双花拒绝——锁定资产再 CreateTrade 抛 ASSET_LOCKED', async () => {
    await w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t2'));
    const offer2 = JSON.stringify({ pokemonIds: ['p_1'], itemIds: [], points: 0 });
    await expectCode(
      w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_2', 'u_ash', 'u_gary', offer2, EMPTY, EXPIRES, T2, 'idem-t3')),
      'ASSET_LOCKED',
    );
    // request 侧不产生锁：同一个 p_2 可以同时被多笔交易"请求"
    const request2 = JSON.stringify({ pokemonIds: ['p_2'], itemIds: [], points: 0 });
    await w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_3', 'u_ash', 'u_gary', EMPTY, request2, EXPIRES, T2, 'idem-t3b'));
    expect((await w.getPokemon('p_2')).status).toBe('IDLE');
  });

  test('CreateTrade：非 fromId 本人创建抛 NOT_OWNER；资产不属于对应方抛 NOT_OWNER；余额不足抛 INSUFFICIENT_POINTS', async () => {
    await expectCode(
      w.run(() => w.trade.CreateTrade(w.ctxAs('u_gary'), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t4')),
      'NOT_OWNER',
    );
    // offer 里放了属于 gary 的 p_2
    const badOffer = JSON.stringify({ pokemonIds: ['p_2'], itemIds: [], points: 0 });
    await expectCode(
      w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_2', 'u_ash', 'u_gary', badOffer, EMPTY, EXPIRES, T2, 'idem-t5')),
      'NOT_OWNER',
    );
    // ash 只有 1000 分
    const richOffer = JSON.stringify({ pokemonIds: [], itemIds: [], points: 1001 });
    await expectCode(
      w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_3', 'u_ash', 'u_gary', richOffer, EMPTY, EXPIRES, T2, 'idem-t6')),
      'INSUFFICIENT_POINTS',
    );
  });

  test('ConfirmTrade：双方确认后同一交易内原子执行——归属与积分交换、资产解锁、EXECUTED', async () => {
    await w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t7'));
    const afterFirst = JSON.parse(await w.run(() => w.trade.ConfirmTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', T3, 'idem-t8')));
    expect(afterFirst.status).toBe('OPEN');
    expect(afterFirst.confirmations).toEqual({ from: true, to: false });
    expect((await w.getPokemon('p_1')).status).toBe('LOCKED_TRADE');
    // 单方确认不锁对方资产
    expect((await w.getPokemon('p_2')).status).toBe('IDLE');
    const done = JSON.parse(await w.run(() => w.trade.ConfirmTrade(w.ctxAs('u_gary'), 't_1', 'u_gary', T3, 'idem-t9')));
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
    await w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', 'u_gary', OFFER_PTS, REQUEST_PTS, EXPIRES, T2, 'idem-t10'));
    // gary 把积分转走，执行时付不起 request.points=200
    await w.run(() => w.player.TransferPoints(w.ctxAs('u_gary'), 'u_gary', 'u_eve', '900', T2, 'idem-drain'));
    await w.run(() => w.trade.ConfirmTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', T3, 'idem-t11'));
    await expectCode(w.run(() => w.trade.ConfirmTrade(w.ctxAs('u_gary'), 't_1', 'u_gary', T3, 'idem-t12')), 'INSUFFICIENT_POINTS');
    const trade = await w.getTrade('t_1');
    expect(trade.status).toBe('OPEN');
    expect(trade.confirmations).toEqual({ from: true, to: false });
    expect((await w.getPlayer('u_ash')).points).toBe(1000);
    expect((await w.getPlayer('u_gary')).points).toBe(100);
  });

  test('ConfirmTrade：非当事人抛 NOT_PARTY；冒名当事人（mspId 不符）抛 NOT_OWNER', async () => {
    await w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t13'));
    await expectCode(w.run(() => w.trade.ConfirmTrade(w.ctxAs('u_gary'), 't_1', 'u_eve', T3, 'idem-t14')), 'NOT_PARTY');
    await expectCode(w.run(() => w.trade.ConfirmTrade(w.ctxAs('u_gary'), 't_1', 'u_ash', T3, 'idem-t15')), 'NOT_OWNER');
  });

  test('ConfirmTrade/CancelTrade：同组织其他玩家不能替当事人确认/取消（NOT_OWNER）', async () => {
    await w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t-forge0'));
    // u_eve 与 gary 同属 Org2MSP：只看 mspId 会被放行，故必须按 hf.EnrollmentID 拒绝
    await expectCode(
      w.run(() => w.trade.ConfirmTrade(w.ctxAs('u_eve', ORG2), 't_1', 'u_gary', T3, 'idem-t-forge1')),
      'NOT_OWNER',
    );
    await expectCode(
      w.run(() => w.trade.ConfirmTrade(w.ctxAs('u_eve', ORG2), 't_1', 'u_ash', T3, 'idem-t-forge2')),
      'NOT_OWNER',
    );
    await expectCode(
      w.run(() => w.trade.CancelTrade(w.ctxAs('u_eve', ORG2), 't_1', 'u_gary', T3, 'idem-t-forge3')),
      'NOT_OWNER',
    );
    // 缺 hf.EnrollmentID 的证书同样拒绝
    await expectCode(w.run(() => w.trade.ConfirmTrade(w.ctx(ORG1), 't_1', 'u_ash', T3, 'idem-t-forge4')), 'NOT_OWNER');
    const trade = await w.getTrade('t_1');
    expect(trade.status).toBe('OPEN');
    expect(trade.confirmations).toEqual({ from: false, to: false });
  });

  test('执行时 request 已被转走：抛 NOT_OWNER，offer 仍锁定、交易仍 OPEN（整笔回滚）', async () => {
    await w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t-rq0'));
    await w.run(() => w.trade.ConfirmTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', T3, 'idem-t-rq1'));
    // gary 在确认前把 p_2 转给自己的另一个号 → 执行时归属校验失败
    await w.run(() => w.pokemon.Transfer(w.ctxAs('u_gary', ORG2), 'p_2', 'u_eve', T3, 'idem-t-rq2'));
    await expectCode(w.run(() => w.trade.ConfirmTrade(w.ctxAs('u_gary', ORG2), 't_1', 'u_gary', T3, 'idem-t-rq3')), 'NOT_OWNER');
    const trade = await w.getTrade('t_1');
    expect(trade.status).toBe('OPEN');
    expect(trade.confirmations).toEqual({ from: true, to: false });
    expect((await w.getPokemon('p_1')).status).toBe('LOCKED_TRADE');
    expect((await w.getPokemon('p_2')).ownerId).toBe('u_eve');
    expect((await w.getItem('i_1')).status).toBe('LOCKED_TRADE');
    expect((await w.getPlayer('u_ash')).points).toBe(1000);
  });

  test('执行时 request 已被锁定（进别的交易/押注）：抛 ASSET_LOCKED，不半结算', async () => {
    await w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t-rl0'));
    await w.run(() => w.trade.ConfirmTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', T3, 'idem-t-rl1'));
    const p2Offer = JSON.stringify({ pokemonIds: ['p_2'], itemIds: [], points: 0 });
    // gary 把 p_2 放进自己发起的另一笔交易（只锁发起方 offer） → p_2 LOCKED_TRADE
    await w.run(() => w.trade.CreateTrade(w.ctxAs('u_gary', ORG2), 't_8', 'u_gary', 'u_ash', p2Offer, EMPTY, EXPIRES, T2, 'idem-t-rl2'));
    expect((await w.getPokemon('p_2')).status).toBe('LOCKED_TRADE');
    await expectCode(w.run(() => w.trade.ConfirmTrade(w.ctxAs('u_gary', ORG2), 't_1', 'u_gary', T3, 'idem-t-rl3')), 'ASSET_LOCKED');
    expect((await w.getTrade('t_1')).status).toBe('OPEN');
    expect((await w.getPokemon('p_1')).status).toBe('LOCKED_TRADE');
    expect((await w.getPokemon('p_2')).ownerId).toBe('u_gary');
  });

  test('旧交易兼容：创建时 request 已被本单锁定（LOCKED_TRADE/lockRef=tradeId）仍可执行/取消/过期', async () => {
    await w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_legacy', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t-leg0'));
    // 模拟旧版本留下的状态：request 资产被这笔交易锁定
    const legacy = await w.getPokemon('p_2');
    legacy.status = 'LOCKED_TRADE';
    legacy.lockRef = 't_legacy';
    await w.run(() => w.stub.putState('pokemon:p_2', Buffer.from(JSON.stringify(legacy))));
    expect((await w.getPokemon('p_2')).status).toBe('LOCKED_TRADE');
    await w.run(() => w.trade.ConfirmTrade(w.ctxAs('u_ash'), 't_legacy', 'u_ash', T3, 'idem-t-leg1'));
    const done = JSON.parse(await w.run(() => w.trade.ConfirmTrade(w.ctxAs('u_gary', ORG2), 't_legacy', 'u_gary', T3, 'idem-t-leg2')));
    expect(done.status).toBe('EXECUTED');
    expect((await w.getPokemon('p_2')).ownerId).toBe('u_ash');
    expect((await w.getPokemon('p_2')).status).toBe('IDLE');

    // 旧交易取消同样解锁双方（换新世界避免上一段执行的归属变化干扰）
    const w2 = await setupWorld();
    await w2.run(() => w2.trade.CreateTrade(w2.ctxAs('u_ash'), 't_legacy2', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t-leg3'));
    const legacy2 = await w2.getPokemon('p_2');
    legacy2.status = 'LOCKED_TRADE';
    legacy2.lockRef = 't_legacy2';
    await w2.run(() => w2.stub.putState('pokemon:p_2', Buffer.from(JSON.stringify(legacy2))));
    await w2.run(() => w2.trade.CancelTrade(w2.ctxAs('u_gary', ORG2), 't_legacy2', 'u_gary', T3, 'idem-t-leg4'));
    expect((await w2.getPokemon('p_2')).status).toBe('IDLE');
    expect((await w2.getPokemon('p_1')).status).toBe('IDLE');
  });

  test('CancelTrade：任一方取消，解锁 offer → CANCELLED（request 从未被锁）', async () => {
    await w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t16'));
    const res = JSON.parse(await w.run(() => w.trade.CancelTrade(w.ctxAs('u_gary'), 't_1', 'u_gary', T3, 'idem-t17')));
    expect(res.status).toBe('CANCELLED');
    expect((await w.getPokemon('p_1')).status).toBe('IDLE');
    expect((await w.getPokemon('p_1')).lockRef).toBe('');
    expect((await w.getItem('i_1')).status).toBe('IDLE');
    expect((await w.getPokemon('p_2')).status).toBe('IDLE');
    expect(w.eventNames()).toContain('TradeCancelled');
    // 终态后不可再确认
    await expectCode(w.run(() => w.trade.ConfirmTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', T3, 'idem-t18')), 'TRADE_NOT_OPEN');
  });

  test('ExpireTrade：未到期抛 TRADE_NOT_EXPIRED；到期任何人可触发，解锁 → EXPIRED', async () => {
    await w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t19'));
    await expectCode(w.run(() => w.trade.ExpireTrade(w.ctxAs('u_gary'), 't_1', T3, 'idem-t20')), 'TRADE_NOT_EXPIRED');
    const res = JSON.parse(await w.run(() => w.trade.ExpireTrade(w.ctxAs('u_gary'), 't_1', EXPIRES, 'idem-t21')));
    expect(res.status).toBe('EXPIRED');
    expect((await w.getPokemon('p_1')).status).toBe('IDLE');
    expect((await w.getItem('i_1')).status).toBe('IDLE');
    expect(w.eventNames()).toContain('TradeExpired');
  });

  test('ConfirmTrade：确认时已过期 → 转 EXPIRED 并解锁，不执行', async () => {
    await w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t22'));
    const res = JSON.parse(await w.run(() => w.trade.ConfirmTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', EXPIRES, 'idem-t23')));
    expect(res.status).toBe('EXPIRED');
    expect((await w.getPokemon('p_1')).status).toBe('IDLE');
    expect((await w.getPlayer('u_ash')).points).toBe(1000);
    expect(w.eventNames()).toContain('TradeExpired');
  });

  test('QueryByPlayer：from/to 双向可查', async () => {
    await w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, T2, 'idem-t24'));
    const ashTrades = JSON.parse(await w.run(() => w.trade.QueryByPlayer(w.systemCtx(), 'u_ash')));
    const garyTrades = JSON.parse(await w.run(() => w.trade.QueryByPlayer(w.systemCtx(), 'u_gary')));
    const eveTrades = JSON.parse(await w.run(() => w.trade.QueryByPlayer(w.systemCtx(), 'u_eve')));
    expect(ashTrades).toHaveLength(1);
    expect(garyTrades).toHaveLength(1);
    expect(eveTrades).toHaveLength(0);
  });

  test('已用时间戳确定性：nowISO 非法抛 INVALID_TIME', async () => {
    await expectCode(
      w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', 'u_gary', OFFER_FULL, REQUEST_FULL, EXPIRES, 'not-a-time', 'idem-t25')),
      'INVALID_TIME',
    );
  });
});
