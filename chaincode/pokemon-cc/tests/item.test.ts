import { keyOf } from '../src/common/keys';
import { expectCode, hash, ORG1, ORG2, T1, T2, World } from './helpers/harness';

describe('ItemContract', () => {
  let w: World;
  beforeEach(async () => {
    w = new World();
    await w.registerPlayer('u_ash', ORG1);
    await w.registerPlayer('u_gary', ORG2);
  });

  test('MintItem：admin/system 铸造，事件 ItemMinted', async () => {
    await w.mintItem('i_1', 'u_ash', 5);
    const i = await w.getItem('i_1');
    expect(i).toMatchObject({ docType: 'item', id: 'i_1', typeId: 'poke-ball', ownerId: 'u_ash', quantity: 5, status: 'IDLE', lockRef: '' });
    expect(i.createdAt).toBe(T1);
    expect(w.eventNames()).toContain('ItemMinted');
  });

  test('MintItem：普通玩家被拒 FORBIDDEN；quantity 必须 ≥1；id 重复抛 ITEM_EXISTS', async () => {
    await expectCode(
      w.run(() => w.item.MintItem(w.ctxAs('u_ash'), 'i_1', 'u_ash', 'poke-ball', '5', 'u', 'a'.repeat(64), T1, 'idem-x1')),
      'FORBIDDEN',
    );
    await expectCode(
      w.run(() => w.item.MintItem(w.systemCtx(), 'i_1', 'u_ash', 'poke-ball', '0', 'u', 'a'.repeat(64), T1, 'idem-x2')),
      'INVALID_PARAM',
    );
    await w.mintItem('i_1', 'u_ash', 5);
    await expectCode(
      w.run(() => w.item.MintItem(w.systemCtx(), 'i_1', 'u_ash', 'poke-ball', '1', 'u', 'b'.repeat(64), T1, 'idem-x3')),
      'ITEM_EXISTS',
    );
  });

  test('MintItem 自动合并：同 owner+typeId 的 IDLE 堆叠累加到最早创建的堆叠，其余删除并抛 ItemMerged', async () => {
    await w.mintItem('i_1', 'u_ash', 5);
    const merged = JSON.parse(
      await w.run(() =>
        w.item.MintItem(w.systemCtx(), 'i_2', 'u_ash', 'poke-ball', '3', 'minio://assets/items/poke-ball.png', hash('meta-i_2'), T2, 'idem-mint-i_2b'),
      ),
    );
    // 返回值是合并后的幸存堆叠（i_1 创建更早）
    expect(merged).toMatchObject({ id: 'i_1', quantity: 8 });
    expect((await w.getItem('i_1')).quantity).toBe(8);
    await expectCode(w.getItem('i_2'), 'ITEM_NOT_FOUND');
    const ev = w.stub.committedEvents.filter((e) => e.name === 'ItemMerged');
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0].payload)).toMatchObject({ ownerId: 'u_ash', typeId: 'poke-ball', id: 'i_1', quantity: 8 });
    // 不同 owner / 不同 typeId 的堆叠不参与合并
    await w.mintItem('i_3', 'u_gary', 4);
    await w.mintItem('i_4', 'u_ash', 1, T2, 'great-ball');
    expect((await w.getItem('i_1')).quantity).toBe(8);
    expect((await w.getItem('i_3')).quantity).toBe(4);
    expect((await w.getItem('i_4')).quantity).toBe(1);
  });

  test('MintItem 自动合并：旧记录缺 createdAt 视为最早，锁定堆叠不参与', async () => {
    // 旧账本记录（无 createdAt）
    w.stub.beginTx();
    await w.stub.putState(
      keyOf('item', 'i_legacy'),
      Buffer.from(
        JSON.stringify({
          docType: 'item', id: 'i_legacy', typeId: 'poke-ball', ownerId: 'u_ash', quantity: 2,
          uri: 'minio://assets/items/poke-ball.png', metadataHash: hash('legacy'), status: 'IDLE', lockRef: '',
        }),
      ),
    );
    w.stub.commitTx();
    await w.mintItem('i_new', 'u_ash', 5);
    expect((await w.getItem('i_legacy')).quantity).toBe(7);
    await expectCode(w.getItem('i_new'), 'ITEM_NOT_FOUND');
    // LOCKED 堆叠不参与合并：i_legacy 被管理员转走后由 gary 锁定交易，不会并入 ash 的堆叠
    await w.mintItem('i_gary', 'u_gary', 1);
    await w.run(() => w.item.TransferItem(w.ctxAs('u_ash'), 'i_legacy', 'u_gary', T2, 'idem-ti-legacy'));
    const offer = JSON.stringify({ pokemonIds: [], itemIds: ['i_legacy'], points: 0 });
    const empty = JSON.stringify({ pokemonIds: [], itemIds: [], points: 0 });
    await w.run(() => w.trade.CreateTrade(w.ctxAs('u_gary'), 't_lock', 'u_gary', 'u_ash', offer, empty, '2026-01-02T00:00:00.000Z', T2, 'idem-t-lock'));
    expect((await w.getItem('i_legacy')).status).toBe('LOCKED_TRADE');
    expect((await w.getItem('i_gary')).quantity).toBe(1);
    await w.mintItem('i_gary2', 'u_gary', 3);
    // 只有 IDLE 的 i_gary(1) 参与合并成 4；锁定中的 i_legacy(7) 保持原样
    expect((await w.getItem('i_gary')).quantity).toBe(4);
    expect((await w.getItem('i_legacy')).quantity).toBe(7);
    expect((await w.getItem('i_legacy')).status).toBe('LOCKED_TRADE');
  });

  test('MergeStacks：owner 本人或 system 可调用；非 owner 抛 NOT_OWNER；无可合并堆叠返回 null', async () => {
    await w.mintItem('i_ash', 'u_ash', 5);
    await w.mintItem('i_gary', 'u_gary', 2);
    // TransferItem 保持整堆语义、不触发合并 → gary 转入后 ash 名下出现两个同 type 堆叠
    await w.run(() => w.item.TransferItem(w.ctxAs('u_gary'), 'i_gary', 'u_ash', T2, 'idem-ti-m1'));
    expect((await w.getItem('i_ash')).quantity).toBe(5);
    const merged = JSON.parse(await w.run(() => w.item.MergeStacks(w.ctxAs('u_ash'), 'u_ash', 'poke-ball', T2, 'idem-ms1')));
    expect(merged).toMatchObject({ id: 'i_ash', quantity: 7 }); // i_ash 的 createdAt 更早
    await expectCode(w.getItem('i_gary'), 'ITEM_NOT_FOUND');
    // system 亦可调用
    await w.mintItem('i_ash2', 'u_ash', 1);
    await w.run(() => w.item.MergeStacks(w.systemCtx(), 'u_ash', 'poke-ball', T2, 'idem-ms2'));
    expect((await w.getItem('i_ash')).quantity).toBe(8);
    // 非 owner 抛 NOT_OWNER（gary 试图合并 ash 的堆叠）
    await expectCode(w.run(() => w.item.MergeStacks(w.ctxAs('u_gary'), 'u_ash', 'poke-ball', T2, 'idem-ms3')), 'NOT_OWNER');
    // 无 IDLE 堆叠 → null
    const none = await w.run(() => w.item.MergeStacks(w.systemCtx(), 'u_gary', 'poke-ball', T2, 'idem-ms4'));
    expect(none).toBe('null');
  });

  test('TransferItem：owner 整堆转移；非 owner 抛 NOT_OWNER', async () => {
    await w.mintItem('i_1', 'u_ash', 5);
    const i = JSON.parse(await w.run(() => w.item.TransferItem(w.ctxAs('u_ash'), 'i_1', 'u_gary', T2, 'idem-ti1')));
    expect(i).toMatchObject({ ownerId: 'u_gary', quantity: 5 });
    await expectCode(w.run(() => w.item.TransferItem(w.ctxAs('u_ash'), 'i_1', 'u_ash', T2, 'idem-ti2')), 'NOT_OWNER');
  });

  test('ConsumeItem：owner/system 扣减；到 0 保留记录 quantity=0；超量抛 INSUFFICIENT_QUANTITY', async () => {
    await w.mintItem('i_1', 'u_ash', 5);
    let i = JSON.parse(await w.run(() => w.item.ConsumeItem(w.ctxAs('u_ash'), 'i_1', '2', 'use', T2, 'idem-ci1')));
    expect(i.quantity).toBe(3);
    i = JSON.parse(await w.run(() => w.item.ConsumeItem(w.systemCtx(), 'i_1', '3', 'system-use', T2, 'idem-ci2')));
    expect(i.quantity).toBe(0);
    expect((await w.getItem('i_1')).quantity).toBe(0);
    await expectCode(w.run(() => w.item.ConsumeItem(w.ctxAs('u_ash'), 'i_1', '1', 'use', T2, 'idem-ci3')), 'INSUFFICIENT_QUANTITY');
  });

  test('ConsumeItem：非 owner 且非 system 抛 NOT_OWNER', async () => {
    await w.mintItem('i_1', 'u_ash', 5);
    await expectCode(w.run(() => w.item.ConsumeItem(w.ctxAs('u_gary'), 'i_1', '1', 'steal', T2, 'idem-ci4')), 'NOT_OWNER');
  });

  test('QueryByOwner 富查询', async () => {
    await w.mintItem('i_1', 'u_ash', 5);
    await w.mintItem('i_2', 'u_ash', 3); // 与 i_1 同 typeId → 自动合并进 i_1
    await w.mintItem('i_3', 'u_gary', 1);
    const list = JSON.parse(await w.run(() => w.item.QueryByOwner(w.systemCtx(), 'u_ash')));
    expect(list.map((x: { id: string }) => x.id).sort()).toEqual(['i_1']);
    expect(list[0].quantity).toBe(8);
    expect(JSON.parse(await w.run(() => w.item.QueryByOwner(w.systemCtx(), 'u_gary')))).toHaveLength(1);
  });
});
