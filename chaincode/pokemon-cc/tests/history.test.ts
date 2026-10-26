import { expectCode, ORG1, T1, T2, World } from './helpers/harness';

/** [FEAT:history] 宝可梦履历：账本历史查询（只读）。 */
describe('HistoryContract（账本历史）', () => {
  let w: World;

  beforeEach(async () => {
    w = new World();
    await w.registerPlayer('u_ash', ORG1);
    await w.registerPlayer('u_gary', ORG1);
  });

  test('从未存在的宝可梦：抛 POKEMON_NOT_FOUND', async () => {
    await expectCode(w.getHistory('p_missing'), 'POKEMON_NOT_FOUND');
  });

  test('铸造 + 转移：按时间倒序返回，字段是摘要而非完整状态', async () => {
    await w.capturePokemon('p_1', 'u_ash', T1);
    await w.run(() => w.pokemon.Transfer(w.ctxAs('u_ash'), 'p_1', 'u_gary', T2, 'idem-hist-transfer'));

    const { summary, entries } = await w.getHistory('p_1');
    expect(summary).toMatchObject({ firstOwner: 'u_ash', currentOwner: 'u_gary', transfers: 1, versions: 2, truncated: false });
    expect(entries).toHaveLength(2);
    // 最新在前：转移后的版本
    expect(entries[0]).toMatchObject({ ownerId: 'u_gary', speciesId: 25, level: 5, status: 'IDLE' });
    expect(entries[1]).toMatchObject({ ownerId: 'u_ash', status: 'IDLE' });
    // 摘要里不出现明细字段
    expect(entries[0]).not.toHaveProperty('ivs');
    expect(entries[0]).not.toHaveProperty('evs');
    expect(entries[0]).not.toHaveProperty('moves');
    // 每条都有区块时间与交易 id
    expect(typeof entries[0].at).toBe('string');
    expect(String(entries[0].at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(String(entries[0].txId)).toMatch(/^mock-tx-/);
  });

  test('maxEntries 只截断明细，summary 仍按完整历史统计', async () => {
    await w.capturePokemon('p_1', 'u_ash', T1);
    await w.run(() => w.pokemon.Transfer(w.ctxAs('u_ash'), 'p_1', 'u_gary', T2, 'idem-hist-tr-1'));

    const { summary, entries } = await w.getHistory('p_1', 1);
    expect(entries).toHaveLength(1);
    expect(entries[0].ownerId).toBe('u_gary');
    // 关键：初训家与转手次数不受截断影响
    expect(summary).toMatchObject({ firstOwner: 'u_ash', currentOwner: 'u_gary', transfers: 1, versions: 2, truncated: true });
  });

  test('maxEntries 非法值拒绝', async () => {
    await w.capturePokemon('p_1', 'u_ash', T1);
    await expectCode(w.getHistory('p_1', 0), 'INVALID_PARAM');
  });

  test('放生后历史仍可查（status=RELEASED）', async () => {
    await w.capturePokemon('p_1', 'u_ash', T1);
    await w.run(() => w.pokemon.Release(w.ctxAs('u_ash'), 'p_1', T2, 'idem-hist-release'));
    const { summary, entries } = await w.getHistory('p_1');
    expect(entries[0]).toMatchObject({ ownerId: '', status: 'RELEASED' });
    expect(entries).toHaveLength(2);
    expect(summary.currentOwner).toBe('');
    expect(summary.transfers).toBe(1); // 放生也让 ownerId 变化
  });

  test('成长产生的版本也进历史（等级变化可见）', async () => {
    await w.capturePokemon('p_1', 'u_ash', T1);
    // ApplyGrowth 仅 system（后端扣费校验后代签）
    await w.run(() =>
      w.pokemon.ApplyGrowth(w.systemCtx(), 'p_1', JSON.stringify({ level: 6, exp: 216 }), T2, 'idem-hist-growth'),
    );
    const { entries } = await w.getHistory('p_1');
    expect(entries[0]).toMatchObject({ ownerId: 'u_ash', level: 6 });
    expect(entries[1]).toMatchObject({ level: 5 });
  });
});
