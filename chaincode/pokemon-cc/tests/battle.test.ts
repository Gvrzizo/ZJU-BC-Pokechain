import { hash, expectCode, ORG1, ORG2, T1, T2, T3, T4, World } from './helpers/harness';
import { AssetBundle } from '../src/common/model';

const WAGER_A: AssetBundle = { pokemonIds: ['p_1'], itemIds: ['i_1'], points: 50 };
const WAGER_B: AssetBundle = { pokemonIds: ['p_2'], itemIds: [], points: 50 };
const WAGER_A_JSON = JSON.stringify(WAGER_A);
const WAGER_B_JSON = JSON.stringify(WAGER_B);
const RESULT_HASH = hash('battle-result');
const SIG = 'server-signature';

async function setupWorld(): Promise<World> {
  const w = new World();
  await w.registerPlayer('u_ash', ORG1);
  await w.registerPlayer('u_gary', ORG2);
  await w.registerPlayer('u_eve', ORG1);
  await w.capturePokemon('p_1', 'u_ash');
  await w.capturePokemon('p_2', 'u_gary');
  await w.mintItem('i_1', 'u_ash', 5);
  return w;
}

async function createBattle(w: World, id = 'b_1'): Promise<void> {
  const wagerHash = w.wagerHash('u_ash', 'u_gary', WAGER_A, WAGER_B);
  await w.run(() => w.battle.CreateBattle(w.systemCtx(), id, 'u_ash', 'u_gary', WAGER_A_JSON, WAGER_B_JSON, wagerHash, T2, `idem-cb-${id}`));
}

async function activateBattle(w: World, id = 'b_1'): Promise<void> {
  await w.run(() => w.battle.ActivateBattle(w.systemCtx(), id, T2, `idem-act-${id}`));
}

async function submitResult(w: World, winnerId: string, id = 'b_1'): Promise<void> {
  await w.run(() => w.battle.SubmitResult(w.systemCtx(), id, winnerId, RESULT_HASH, SIG, T3, `idem-sub-${id}`));
}

describe('BattleContract（押注锁定 + 签名结果 + 原子结算 + 仲裁）', () => {
  let w: World;
  beforeEach(async () => {
    w = await setupWorld();
  });

  test('CreateBattle：wagerHash 校验、资产 LOCKED_BATTLE、积分立即扣入 escrow → CREATED', async () => {
    await createBattle(w);
    const b = await w.getBattle('b_1');
    expect(b.status).toBe('CREATED');
    expect(b.escrow).toEqual({ pointsA: 50, pointsB: 50 });
    expect((await w.getPokemon('p_1')).status).toBe('LOCKED_BATTLE');
    expect((await w.getPokemon('p_1')).lockRef).toBe('b_1');
    expect((await w.getItem('i_1')).status).toBe('LOCKED_BATTLE');
    expect((await w.getPokemon('p_2')).status).toBe('LOCKED_BATTLE');
    expect((await w.getPlayer('u_ash')).points).toBe(950);
    expect((await w.getPlayer('u_gary')).points).toBe(950);
    expect(w.eventNames()).toContain('BattleCreated');
  });

  test('CreateBattle：wagerHash 不符抛 WAGER_HASH_MISMATCH；同人抛 SAME_PLAYER；余额不足抛 INSUFFICIENT_POINTS', async () => {
    await expectCode(
      w.run(() => w.battle.CreateBattle(w.systemCtx(), 'b_x', 'u_ash', 'u_gary', WAGER_A_JSON, WAGER_B_JSON, hash('wrong'), T2, 'idem-cbx')),
      'WAGER_HASH_MISMATCH',
    );
    const selfHash = w.wagerHash('u_ash', 'u_ash', WAGER_A, WAGER_B);
    await expectCode(
      w.run(() => w.battle.CreateBattle(w.systemCtx(), 'b_y', 'u_ash', 'u_ash', WAGER_A_JSON, WAGER_B_JSON, selfHash, T2, 'idem-cby')),
      'SAME_PLAYER',
    );
    const richA: AssetBundle = { pokemonIds: [], itemIds: [], points: 5000 };
    const richHash = w.wagerHash('u_ash', 'u_gary', richA, WAGER_B);
    await expectCode(
      w.run(() =>
        w.battle.CreateBattle(w.systemCtx(), 'b_z', 'u_ash', 'u_gary', JSON.stringify(richA), WAGER_B_JSON, richHash, T2, 'idem-cbz'),
      ),
      'INSUFFICIENT_POINTS',
    );
  });

  test('CreateBattle：锁定中资产不可再押注（ASSET_LOCKED）；非 system/当事人创建抛 FORBIDDEN', async () => {
    await createBattle(w, 'b_1');
    const wagerHash = w.wagerHash('u_ash', 'u_gary', WAGER_A, WAGER_B);
    await expectCode(
      w.run(() => w.battle.CreateBattle(w.systemCtx(), 'b_2', 'u_ash', 'u_gary', WAGER_A_JSON, WAGER_B_JSON, wagerHash, T2, 'idem-cb2')),
      'ASSET_LOCKED',
    );
    const emptyA = JSON.stringify({ pokemonIds: [], itemIds: [], points: 0 });
    const h2 = w.wagerHash('u_ash', 'u_gary', { pokemonIds: [], itemIds: [], points: 0 }, { pokemonIds: [], itemIds: [], points: 0 });
    // 非当事人的普通玩家（A、B 之外的 C）创建被拒
    await expectCode(
      w.run(() => w.battle.CreateBattle(w.ctxAs('u_eve'), 'b_3', 'u_ash', 'u_gary', emptyA, emptyA, h2, T2, 'idem-cb3')),
      'FORBIDDEN',
    );
    // 无 hf.EnrollmentID 的证书同样被拒（不回退 mspId）
    await expectCode(
      w.run(() => w.battle.CreateBattle(w.ctx(ORG1), 'b_4', 'u_ash', 'u_gary', emptyA, emptyA, h2, T2, 'idem-cb4')),
      'FORBIDDEN',
    );
  });

  test('ActivateBattle/SubmitResult：仅 system；状态机 CREATED→ACTIVE→RESULT_SUBMITTED', async () => {
    await createBattle(w);
    await expectCode(w.run(() => w.battle.ActivateBattle(w.ctxAs('u_ash'), 'b_1', T2, 'idem-a1')), 'FORBIDDEN');
    await expectCode(w.run(() => w.battle.SubmitResult(w.systemCtx(), 'b_1', 'u_ash', RESULT_HASH, SIG, T2, 'idem-s0')), 'BAD_STATE');
    await activateBattle(w);
    await expectCode(w.run(() => w.battle.SubmitResult(w.ctxAs('u_gary'), 'b_1', 'u_ash', RESULT_HASH, SIG, T3, 'idem-s1')), 'FORBIDDEN');
    await expectCode(w.run(() => w.battle.SubmitResult(w.systemCtx(), 'b_1', 'u_eve', RESULT_HASH, SIG, T3, 'idem-s2')), 'INVALID_WINNER');
    await submitResult(w, 'u_ash');
    const b = await w.getBattle('b_1');
    expect(b.status).toBe('RESULT_SUBMITTED');
    expect(b.result).toMatchObject({ winnerId: 'u_ash', resultHash: RESULT_HASH, serverSig: SIG, serverSubmitted: true });
    expect(w.eventNames()).toEqual(expect.arrayContaining(['BattleActivated', 'BattleResultSubmitted']));
  });

  test('ConfirmResult：双方确认后原子结算——赢家得全部押注资产与积分、战绩 +1', async () => {
    await createBattle(w);
    await activateBattle(w);
    await submitResult(w, 'u_ash');
    const afterA = JSON.parse(await w.run(() => w.battle.ConfirmResult(w.ctxAs('u_ash'), 'b_1', 'u_ash', T3, 'idem-cr1')));
    expect(afterA.status).toBe('RESULT_SUBMITTED');
    expect(afterA.result.confirmations).toEqual({ A: true, B: false });
    const done = JSON.parse(await w.run(() => w.battle.ConfirmResult(w.ctxAs('u_gary'), 'b_1', 'u_gary', T3, 'idem-cr2')));
    expect(done.status).toBe('SETTLED');
    expect(done.settledAt).toBe(T3);
    // 赢家 ash 得双方押注资产
    expect((await w.getPokemon('p_1')).ownerId).toBe('u_ash');
    expect((await w.getPokemon('p_2')).ownerId).toBe('u_ash');
    expect((await w.getItem('i_1')).ownerId).toBe('u_ash');
    // 全部解锁
    for (const id of ['p_1', 'p_2']) {
      expect((await w.getPokemon(id)).status).toBe('IDLE');
    }
    expect((await w.getItem('i_1')).status).toBe('IDLE');
    // 积分：ash 950+100=1050，gary 950
    expect((await w.getPlayer('u_ash')).points).toBe(1050);
    expect((await w.getPlayer('u_gary')).points).toBe(950);
    // 战绩
    expect((await w.getPlayer('u_ash')).wins).toBe(1);
    expect((await w.getPlayer('u_gary')).losses).toBe(1);
    expect(w.eventNames()).toEqual(expect.arrayContaining(['BattleConfirmed', 'BattleSettled']));
    // H4：BattleSettled 带双方 playerId，结算另发双方 PointsChanged（排行榜靠它刷新）
    const settledEvents = w.stub.committedEvents
      .filter((e) => e.name === 'BattleSettled')
      .map((e) => JSON.parse(e.payload));
    expect(settledEvents[settledEvents.length - 1]).toMatchObject({
      id: 'b_1',
      winnerId: 'u_ash',
      playerA: 'u_ash',
      playerB: 'u_gary',
    });
    const pointsEvents = w.stub.committedEvents
      .filter((e) => e.name === 'PointsChanged')
      .map((e) => JSON.parse(e.payload));
    expect(pointsEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerId: 'u_ash', delta: 100, balance: 1050, reason: 'battle:b_1' }),
        expect.objectContaining({ playerId: 'u_gary', delta: 0, balance: 950, reason: 'battle:b_1' }),
      ]),
    );
  });

  test('ConfirmResult/Dispute：同组织其他玩家不能替当事人确认/争议（NOT_OWNER）', async () => {
    await createBattle(w);
    await activateBattle(w);
    await submitResult(w, 'u_ash');
    // u_eve 与 ash 同属 Org1MSP：只看 mspId 会被放行，故必须按 hf.EnrollmentID 拒绝
    await expectCode(
      w.run(() => w.battle.ConfirmResult(w.ctxAs('u_eve'), 'b_1', 'u_ash', T3, 'idem-cr-forge1')),
      'NOT_OWNER',
    );
    await expectCode(
      w.run(() => w.battle.ConfirmResult(w.ctx(ORG1), 'b_1', 'u_ash', T3, 'idem-cr-forge2')),
      'NOT_OWNER',
    );
    expect((await w.getBattle('b_1')).result.confirmations).toEqual({ A: false, B: false });
    // 争议入口同样按本人校验（非当事人先被 NOT_PARTY 拦下）
    await expectCode(w.run(() => w.battle.Dispute(w.ctxAs('u_eve'), 'b_1', 'u_ash', 'x', T3, 'idem-d-forge')), 'NOT_OWNER');
    expect((await w.getBattle('b_1')).status).toBe('RESULT_SUBMITTED');
  });

  test('DRAW：各自取回押注资产与 escrow 积分，不记胜负', async () => {
    await createBattle(w);
    await activateBattle(w);
    await submitResult(w, 'DRAW');
    await w.run(() => w.battle.ConfirmResult(w.ctxAs('u_ash'), 'b_1', 'u_ash', T3, 'idem-cr3'));
    const done = JSON.parse(await w.run(() => w.battle.ConfirmResult(w.ctxAs('u_gary'), 'b_1', 'u_gary', T3, 'idem-cr4')));
    expect(done.status).toBe('SETTLED');
    expect((await w.getPokemon('p_1')).ownerId).toBe('u_ash');
    expect((await w.getPokemon('p_2')).ownerId).toBe('u_gary');
    expect((await w.getItem('i_1')).ownerId).toBe('u_ash');
    expect((await w.getPlayer('u_ash')).points).toBe(1000);
    expect((await w.getPlayer('u_gary')).points).toBe(1000);
    expect((await w.getPlayer('u_ash')).wins).toBe(0);
    expect((await w.getPlayer('u_gary')).losses).toBe(0);
  });

  test('SettleBattle：RESULT_SUBMITTED 后 system 兜底结算；非 RESULT_SUBMITTED 抛 BAD_STATE', async () => {
    await createBattle(w);
    await expectCode(w.run(() => w.battle.SettleBattle(w.systemCtx(), 'b_1', T2, 'idem-sb0')), 'BAD_STATE');
    await activateBattle(w);
    await submitResult(w, 'u_gary');
    const done = JSON.parse(await w.run(() => w.battle.SettleBattle(w.systemCtx(), 'b_1', T4, 'idem-sb1')));
    expect(done.status).toBe('SETTLED');
    expect((await w.getPokemon('p_1')).ownerId).toBe('u_gary');
    expect((await w.getPlayer('u_gary')).points).toBe(1050);
    expect((await w.getPlayer('u_gary')).wins).toBe(1);
  });

  test('SettleBattle 幂等：同一 idemKey 重放返回相同结果且不重复结算', async () => {
    await createBattle(w);
    await activateBattle(w);
    await submitResult(w, 'u_gary');
    const first = await w.run(() => w.battle.SettleBattle(w.systemCtx(), 'b_1', T4, 'idem-sb2'));
    const second = await w.run(() => w.battle.SettleBattle(w.systemCtx(), 'b_1', T4, 'idem-sb2'));
    expect(second).toBe(first);
    expect((await w.getPlayer('u_gary')).points).toBe(1050);
    expect((await w.getPlayer('u_gary')).wins).toBe(1);
  });

  test('Forfeit：system 宣判，对方立即获胜结算，并写入 result.winnerId/resultHash/serverSubmitted', async () => {
    await createBattle(w);
    await activateBattle(w);
    const done = JSON.parse(await w.run(() => w.battle.Forfeit(w.systemCtx(), 'b_1', 'u_gary', 'disconnect', T3, 'idem-f1')));
    expect(done.status).toBe('SETTLED');
    // C6：认输也要写结果，否则真链结算页/排行榜读到空 winner
    expect(done.result).toMatchObject({ winnerId: 'u_ash', serverSubmitted: true });
    expect(done.result.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(done.result.resultHash).toBe(hash(`forfeit|b_1|u_gary|disconnect`));
    expect(done.arbiterNote).toBe('FORFEIT: disconnect');
    expect((await w.getPokemon('p_2')).ownerId).toBe('u_ash');
    expect((await w.getPlayer('u_ash')).points).toBe(1050);
    expect((await w.getPlayer('u_ash')).wins).toBe(1);
    expect((await w.getPlayer('u_gary')).losses).toBe(1);
    expect(w.eventNames()).toContain('BattleSettled');
    await expectCode(w.run(() => w.battle.Forfeit(w.ctxAs('u_ash'), 'b_1', 'u_gary', 'x', T3, 'idem-f2')), 'FORBIDDEN');
  });

  test('Forfeit 在 RESULT_SUBMITTED 时只补 winner，不覆盖已提交的 serverSig/resultHash', async () => {
    await createBattle(w);
    await activateBattle(w);
    await submitResult(w, 'u_ash');
    const submitted = await w.getBattle('b_1');
    expect(submitted.status).toBe('RESULT_SUBMITTED');
    const done = JSON.parse(await w.run(() => w.battle.Forfeit(w.systemCtx(), 'b_1', 'u_gary', 'disconnect', T4, 'idem-f3')));
    expect(done.status).toBe('SETTLED');
    expect(done.result.winnerId).toBe('u_ash');
    expect(done.result.resultHash).toBe(submitted.result.resultHash);
    expect(done.result.resultHash).toBe(RESULT_HASH);
    expect(done.result.serverSig).toBe(SIG);
    expect(done.result.serverSubmitted).toBe(true);
    expect((await w.getPokemon('p_2')).ownerId).toBe('u_ash');
  });

  test('Dispute→Arbitrate（赢家结局）：仅 Org2 arbitrator 可仲裁', async () => {
    await createBattle(w);
    await activateBattle(w);
    await submitResult(w, 'u_gary');
    const disputed = JSON.parse(await w.run(() => w.battle.Dispute(w.ctxAs('u_ash'), 'b_1', 'u_ash', 'result looks wrong', T3, 'idem-d1')));
    expect(disputed.status).toBe('DISPUTED');
    expect(disputed.disputeReason).toBe('result looks wrong');
    // 资产保持锁定冻结
    expect((await w.getPokemon('p_1')).status).toBe('LOCKED_BATTLE');
    // 非 arbitrator：普通玩家与 Org2 非 arbitrator 身份都被拒
    await expectCode(w.run(() => w.battle.Arbitrate(w.ctxAs('u_ash'), 'b_1', 'u_ash', 'note', T4, 'idem-ar1')), 'FORBIDDEN');
    await expectCode(w.run(() => w.battle.Arbitrate(w.ctx(ORG2, 'player', 'u_eve'), 'b_1', 'u_ash', 'note', T4, 'idem-ar2')), 'FORBIDDEN');
    await expectCode(w.run(() => w.battle.Arbitrate(w.systemCtx(), 'b_1', 'u_ash', 'note', T4, 'idem-ar3')), 'FORBIDDEN');
    // arbitrator 判 ash 胜
    const done = JSON.parse(await w.run(() => w.battle.Arbitrate(w.arbitratorCtx(), 'b_1', 'u_ash', 'evidence reviewed', T4, 'idem-ar4')));
    expect(done.status).toBe('SETTLED');
    expect(done.arbiterNote).toBe('evidence reviewed');
    expect((await w.getPokemon('p_2')).ownerId).toBe('u_ash');
    expect((await w.getPlayer('u_ash')).points).toBe(1050);
    expect(w.eventNames()).toEqual(expect.arrayContaining(['BattleArbitrated', 'BattleSettled']));
  });

  test('Dispute→Arbitrate（REFUND）：全额退款 → REFUNDED', async () => {
    await createBattle(w);
    await activateBattle(w);
    await w.run(() => w.battle.Dispute(w.ctxAs('u_gary'), 'b_1', 'u_gary', 'server timeout', T3, 'idem-d2'));
    const done = JSON.parse(await w.run(() => w.battle.Arbitrate(w.arbitratorCtx(), 'b_1', 'REFUND', 'match void', T4, 'idem-ar5')));
    expect(done.status).toBe('REFUNDED');
    expect((await w.getPokemon('p_1')).ownerId).toBe('u_ash');
    expect((await w.getPokemon('p_2')).ownerId).toBe('u_gary');
    expect((await w.getItem('i_1')).ownerId).toBe('u_ash');
    expect((await w.getPlayer('u_ash')).points).toBe(1000);
    expect((await w.getPlayer('u_gary')).points).toBe(1000);
    expect((await w.getPlayer('u_ash')).wins).toBe(0);
    expect((await w.getPokemon('p_1')).status).toBe('IDLE');
  });

  test('Dispute：非当事人抛 NOT_PARTY；已 SETTLED 不可争议', async () => {
    await createBattle(w);
    await activateBattle(w);
    await expectCode(w.run(() => w.battle.Dispute(w.ctxAs('u_ash'), 'b_1', 'u_eve', 'not my battle', T3, 'idem-d3')), 'NOT_PARTY');
    await submitResult(w, 'u_ash');
    await w.run(() => w.battle.SettleBattle(w.systemCtx(), 'b_1', T4, 'idem-sb9'));
    await expectCode(w.run(() => w.battle.Dispute(w.ctxAs('u_ash'), 'b_1', 'u_ash', 'too late', T4, 'idem-d4')), 'BAD_STATE');
  });

  test('对战锁定期间资产不可转移/交易（ASSET_LOCKED）', async () => {
    await createBattle(w);
    await expectCode(w.run(() => w.pokemon.Transfer(w.ctxAs('u_ash'), 'p_1', 'u_gary', T3, 'idem-lk1')), 'ASSET_LOCKED');
    const offer = JSON.stringify({ pokemonIds: ['p_1'], itemIds: [], points: 0 });
    const empty = JSON.stringify({ pokemonIds: [], itemIds: [], points: 0 });
    await expectCode(
      w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_9', 'u_ash', 'u_gary', offer, empty, '2026-01-02T00:00:00.000Z', T3, 'idem-lk2')),
      'ASSET_LOCKED',
    );
  });

  test('旧格式 itemIds 兼容：解析层归一为整堆（qty=0），整堆 LOCKED_BATTLE', async () => {
    await createBattle(w);
    const b = await w.getBattle('b_1');
    expect(b.wagerA.items).toEqual([{ id: 'i_1', qty: 0 }]);
    expect(b.wagerB.items).toEqual([]);
    expect(await w.getItem('i_1')).toMatchObject({ quantity: 5, status: 'LOCKED_BATTLE', lockRef: 'b_1' });
  });

  test('CreateBattle 部分押注：原堆叠减量保持 IDLE，生成子堆叠 <parentId>#w<battleId> 置 LOCKED_BATTLE', async () => {
    await w.mintItem('i_10', 'u_ash', 10, T1, 'potion');
    const wagerA = { pokemonIds: ['p_1'], items: [{ id: 'i_10', qty: 3 }], points: 50 };
    const wagerHash = w.wagerHash('u_ash', 'u_gary', wagerA, WAGER_B);
    await w.run(() =>
      w.battle.CreateBattle(w.systemCtx(), 'b_part', 'u_ash', 'u_gary', JSON.stringify(wagerA), WAGER_B_JSON, wagerHash, T2, 'idem-cb-part'),
    );
    expect(await w.getItem('i_10')).toMatchObject({ quantity: 7, status: 'IDLE', lockRef: '' });
    expect(await w.getItem('i_10#wb_part')).toMatchObject({
      docType: 'item', id: 'i_10#wb_part', typeId: 'potion', ownerId: 'u_ash', quantity: 3, status: 'LOCKED_BATTLE', lockRef: 'b_part',
    });
    const b = await w.getBattle('b_part');
    expect(b.wagerA.items).toEqual([{ id: 'i_10', qty: 3 }]);
    expect(b.escrow).toEqual({ pointsA: 50, pointsB: 50 });
  });

  test('wager 兼容形态：items 与非空 itemIds 并存视为歧义拒绝；与空 itemIds 并存按 items 处理', async () => {
    await w.mintItem('i_10', 'u_ash', 10, T1, 'potion');
    const wagerA = { pokemonIds: ['p_1'], items: [{ id: 'i_10', qty: 2 }], itemIds: [], points: 50 };
    const wagerHash = w.wagerHash('u_ash', 'u_gary', wagerA, WAGER_B);
    await w.run(() =>
      w.battle.CreateBattle(w.systemCtx(), 'b_mix', 'u_ash', 'u_gary', JSON.stringify(wagerA), WAGER_B_JSON, wagerHash, T2, 'idem-cb-mix'),
    );
    expect(await w.getItem('i_10')).toMatchObject({ quantity: 8, status: 'IDLE' });
    expect(await w.getItem('i_10#wb_mix')).toMatchObject({ quantity: 2, status: 'LOCKED_BATTLE' });
    const bad = { pokemonIds: [], items: [{ id: 'i_10', qty: 1 }], itemIds: ['i_10'], points: 0 };
    await expectCode(
      w.run(() => w.battle.CreateBattle(w.systemCtx(), 'b_mix2', 'u_ash', 'u_gary', JSON.stringify(bad), WAGER_B_JSON, hash('x'), T2, 'idem-cb-mix2')),
      'INVALID_PARAM',
    );
    expect((await w.getBattle('b_mix')).wagerA.items).toEqual([{ id: 'i_10', qty: 2 }]);
  });

  test('CreateBattle 部分押注：qty 越界/非法/重复/混用旧字段全部拒绝', async () => {
    await w.mintItem('i_10', 'u_ash', 10, T1, 'potion');
    const create = (wagerA: unknown, hashStr: string) =>
      w.run(() =>
        w.battle.CreateBattle(w.systemCtx(), 'b_bad', 'u_ash', 'u_gary', JSON.stringify(wagerA), WAGER_B_JSON, hashStr, T2, 'idem-cb-bad'),
      );
    // 超过持有量
    const over = { pokemonIds: [], items: [{ id: 'i_10', qty: 11 }], points: 0 };
    await expectCode(create(over, w.wagerHash('u_ash', 'u_gary', over, WAGER_B)), 'INSUFFICIENT_QUANTITY');
    // qty 非 safeInt/≤0（显式 items 必须 ≥1）
    for (const qty of [0, -1, 1.5]) {
      await expectCode(create({ pokemonIds: [], items: [{ id: 'i_10', qty }], points: 0 }, hash('x')), 'INVALID_PARAM');
    }
    // id 重复 / 缺 id / 同 id 出现在双方押注
    await expectCode(create({ pokemonIds: [], items: [{ id: 'i_10', qty: 1 }, { id: 'i_10', qty: 2 }], points: 0 }, hash('x')), 'INVALID_PARAM');
    await expectCode(create({ pokemonIds: [], items: [{ qty: 1 }], points: 0 }, hash('x')), 'INVALID_PARAM');
    // items 与旧 itemIds 混用
    await expectCode(create({ pokemonIds: [], items: [{ id: 'i_10', qty: 1 }], itemIds: ['i_10'], points: 0 }, hash('x')), 'INVALID_PARAM');
    // 资产未归一/锁定期间不可再押注
    expect((await w.getItem('i_10')).quantity).toBe(10);
  });

  test('settle 赢家：锁定堆叠转移后与同 typeId 的 IDLE 堆叠合并（含子堆叠归并）', async () => {
    await w.mintItem('i_10', 'u_ash', 10, T1, 'potion');
    await w.mintItem('i_g', 'u_gary', 2, T2, 'potion');
    const wagerA = { pokemonIds: ['p_1'], items: [{ id: 'i_10', qty: 3 }], points: 50 };
    const wagerB = { pokemonIds: ['p_2'], itemIds: ['i_g'], points: 50 };
    const wagerHash = w.wagerHash('u_ash', 'u_gary', wagerA, wagerB);
    await w.run(() =>
      w.battle.CreateBattle(w.systemCtx(), 'b_win', 'u_ash', 'u_gary', JSON.stringify(wagerA), JSON.stringify(wagerB), wagerHash, T2, 'idem-cb-win'),
    );
    await activateBattle(w, 'b_win');
    await submitResult(w, 'u_ash', 'b_win');
    await w.run(() => w.battle.ConfirmResult(w.ctxAs('u_ash'), 'b_win', 'u_ash', T3, 'idem-cr-w1'));
    const done = JSON.parse(await w.run(() => w.battle.ConfirmResult(w.ctxAs('u_gary'), 'b_win', 'u_gary', T3, 'idem-cr-w2')));
    expect(done.status).toBe('SETTLED');
    // ash 的 7（原堆叠）+ gary 的 2 + 子堆叠 3 = 12，全部并入最早创建的 i_10
    expect(await w.getItem('i_10')).toMatchObject({ ownerId: 'u_ash', quantity: 12, status: 'IDLE', lockRef: '' });
    await expectCode(w.getItem('i_10#wb_win'), 'ITEM_NOT_FOUND');
    await expectCode(w.getItem('i_g'), 'ITEM_NOT_FOUND');
    const items = JSON.parse(await w.run(() => w.item.QueryByOwner(w.systemCtx(), 'u_ash')));
    expect(items.filter((x: { typeId: string }) => x.typeId === 'potion')).toHaveLength(1);
  });

  test('settle DRAW：子堆叠数量并回原堆叠', async () => {
    await w.mintItem('i_10', 'u_ash', 10, T1, 'potion');
    const wagerA = { pokemonIds: ['p_1'], items: [{ id: 'i_10', qty: 3 }], points: 50 };
    const wagerHash = w.wagerHash('u_ash', 'u_gary', wagerA, WAGER_B);
    await w.run(() =>
      w.battle.CreateBattle(w.systemCtx(), 'b_draw2', 'u_ash', 'u_gary', JSON.stringify(wagerA), WAGER_B_JSON, wagerHash, T2, 'idem-cb-draw2'),
    );
    await activateBattle(w, 'b_draw2');
    await submitResult(w, 'DRAW', 'b_draw2');
    await w.run(() => w.battle.SettleBattle(w.systemCtx(), 'b_draw2', T3, 'idem-sb-draw2'));
    expect(await w.getItem('i_10')).toMatchObject({ ownerId: 'u_ash', quantity: 10, status: 'IDLE', lockRef: '' });
    await expectCode(w.getItem('i_10#wb_draw2'), 'ITEM_NOT_FOUND');
    expect((await w.getPlayer('u_ash')).points).toBe(1000);
  });

  test('settle REFUND：原堆叠已不在该玩家名下时，子堆叠恢复为独立 IDLE 堆叠', async () => {
    await w.mintItem('i_10', 'u_ash', 10, T1, 'potion');
    const wagerA = { pokemonIds: ['p_1'], items: [{ id: 'i_10', qty: 3 }], points: 50 };
    const wagerHash = w.wagerHash('u_ash', 'u_gary', wagerA, WAGER_B);
    await w.run(() =>
      w.battle.CreateBattle(w.systemCtx(), 'b_ref', 'u_ash', 'u_gary', JSON.stringify(wagerA), WAGER_B_JSON, wagerHash, T2, 'idem-cb-ref'),
    );
    // 原堆叠（剩下的 7）在对战期间被转走 → 退款时无法并回
    await w.run(() => w.item.TransferItem(w.ctxAs('u_ash'), 'i_10', 'u_gary', T2, 'idem-ti-ref'));
    await w.run(() => w.battle.Dispute(w.ctxAs('u_gary'), 'b_ref', 'u_gary', 'x', T3, 'idem-d-ref'));
    const done = JSON.parse(await w.run(() => w.battle.Arbitrate(w.arbitratorCtx(), 'b_ref', 'REFUND', 'void', T4, 'idem-ar-ref')));
    expect(done.status).toBe('REFUNDED');
    expect(await w.getItem('i_10')).toMatchObject({ ownerId: 'u_gary', quantity: 7, status: 'IDLE' });
    expect(await w.getItem('i_10#wb_ref')).toMatchObject({ ownerId: 'u_ash', quantity: 3, status: 'IDLE', lockRef: '' });
    expect((await w.getPlayer('u_ash')).points).toBe(1000);
  });

  test('QueryByPlayer：A/B 双方可查', async () => {
    await createBattle(w);
    const aList = JSON.parse(await w.run(() => w.battle.QueryByPlayer(w.systemCtx(), 'u_ash')));
    const bList = JSON.parse(await w.run(() => w.battle.QueryByPlayer(w.systemCtx(), 'u_gary')));
    const eList = JSON.parse(await w.run(() => w.battle.QueryByPlayer(w.systemCtx(), 'u_eve')));
    expect(aList).toHaveLength(1);
    expect(bList).toHaveLength(1);
    expect(eList).toHaveLength(0);
  });
});
