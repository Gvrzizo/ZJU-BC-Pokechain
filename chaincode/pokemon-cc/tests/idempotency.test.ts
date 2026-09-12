import { expectCode, hash, IVS_JSON, MOVES_JSON, ORG1, ORG2, T1, T2, T3, World } from './helpers/harness';

describe('幂等性（idemKey 重放不重复变更）', () => {
  let w: World;
  beforeEach(async () => {
    w = new World();
    await w.registerPlayer('u_ash', ORG1);
    await w.registerPlayer('u_gary', ORG2);
  });

  test('AddPoints 重放：返回相同结果，积分不重复加', async () => {
    const first = await w.run(() => w.player.AddPoints(w.systemCtx(), 'u_ash', '100', 'quest', T2, 'idem-replay-1'));
    const second = await w.run(() => w.player.AddPoints(w.systemCtx(), 'u_ash', '100', 'quest', T2, 'idem-replay-1'));
    expect(second).toBe(first);
    expect((await w.getPlayer('u_ash')).points).toBe(1100);
  });

  test('MintFromCapture 重放：同一 idemKey 不重复铸造、随机事件只消费一次', async () => {
    await w.commitReveal('ev_i', 'capture', 'u_ash');
    const args = (): Promise<string> =>
      w.pokemon.MintFromCapture(w.systemCtx(), 'p_1', 'u_ash', '25', '皮卡丘', IVS_JSON, 'hardy', 'static', 'false', MOVES_JSON, hash('dna-p_1'), 'ev_i', T2, 'idem-replay-2');
    const first = await w.run(args);
    const second = await w.run(args);
    expect(second).toBe(first);
    // 换 idemKey 重试：随机事件已 CONSUMED，拒绝
    await expectCode(
      w.run(() =>
        w.pokemon.MintFromCapture(w.systemCtx(), 'p_1b', 'u_ash', '25', '皮卡丘', IVS_JSON, 'hardy', 'static', 'false', MOVES_JSON, hash('dna-p_1b'), 'ev_i', T2, 'idem-replay-2b'),
      ),
      'RAND_CONSUMED',
    );
  });

  test('交易执行重放：ConfirmTrade 同 idemKey 不重复划转积分', async () => {
    await w.capturePokemon('p_1', 'u_ash');
    const offer = JSON.stringify({ pokemonIds: [], itemIds: [], points: 100 });
    const request = JSON.stringify({ pokemonIds: [], itemIds: [], points: 0 });
    await w.run(() => w.trade.CreateTrade(w.ctx(ORG1), 't_1', 'u_ash', 'u_gary', offer, request, '2026-01-02T00:00:00.000Z', T2, 'idem-ct-r'));
    const c1 = await w.run(() => w.trade.ConfirmTrade(w.ctx(ORG1), 't_1', 'u_ash', T3, 'idem-cf-a'));
    const c1replay = await w.run(() => w.trade.ConfirmTrade(w.ctx(ORG1), 't_1', 'u_ash', T3, 'idem-cf-a'));
    expect(c1replay).toBe(c1);
    const c2 = await w.run(() => w.trade.ConfirmTrade(w.ctx(ORG2), 't_1', 'u_gary', T3, 'idem-cf-b'));
    const c2replay = await w.run(() => w.trade.ConfirmTrade(w.ctx(ORG2), 't_1', 'u_gary', T3, 'idem-cf-b'));
    expect(c2replay).toBe(c2);
    expect((await w.getPlayer('u_ash')).points).toBe(900);
    expect((await w.getPlayer('u_gary')).points).toBe(1100);
    // 交易已 EXECUTED，换新 idemKey 再确认抛 TRADE_NOT_OPEN
    await expectCode(w.run(() => w.trade.ConfirmTrade(w.ctx(ORG2), 't_1', 'u_gary', T3, 'idem-cf-b2')), 'TRADE_NOT_OPEN');
  });

  test('幂等记录写入 idemp:<key>，docType=idemp', async () => {
    await w.run(() => w.player.AddPoints(w.systemCtx(), 'u_ash', '1', 'r', T1, 'idem-check-record'));
    const raw = await w.run(async () => (await w.stub.getState('idemp:idem-check-record')).toString());
    const rec = JSON.parse(raw);
    expect(rec.docType).toBe('idemp');
    expect(rec.key).toBe('idem-check-record');
    expect(typeof rec.result).toBe('string');
  });
});
