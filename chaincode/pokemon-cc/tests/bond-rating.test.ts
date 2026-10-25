import { AssetBundle } from '../src/common/model';
import { expectCode, EXPIRES, hash, ORG1, ORG2, T1, T2, T3, T4, World } from './helpers/harness';

const BOND_DEFAULT = 50;
const BOND_RESET = 30;

async function setupWorld(): Promise<World> {
  const w = new World();
  await w.registerPlayer('u_ash', ORG1);
  await w.registerPlayer('u_gary', ORG2);
  await w.capturePokemon('p_1', 'u_ash');
  await w.capturePokemon('p_2', 'u_gary');
  return w;
}

describe('Pokemon.bond（羁绊值：铸造 50 / 易主重置 30 / BondUp）', () => {
  let w: World;
  beforeEach(async () => {
    w = await setupWorld();
  });

  test('MintFromCapture：铸造默认 bond=50（捕捉与新手礼包同走该交易）', async () => {
    expect((await w.getPokemon('p_1')).bond).toBe(BOND_DEFAULT);
    expect((await w.getPokemon('p_2')).bond).toBe(BOND_DEFAULT);
  });

  test('旧记录缺 bond 字段：读取按铸造默认值兼容，转移时同样重置', async () => {
    const legacy = await w.getPokemon('p_1');
    delete legacy.bond;
    await w.run(() => w.stub.putState('pokemon:p_1', Buffer.from(JSON.stringify(legacy))));
    expect((await w.getPokemon('p_1')).bond).toBe(BOND_DEFAULT);
    await w.run(() => w.pokemon.Transfer(w.ctxAs('u_ash'), 'p_1', 'u_gary', T3, 'idem-legacy-bond'));
    expect((await w.getPokemon('p_1')).bond).toBe(BOND_RESET);
  });

  test('Transfer：易主 bond 重置为 30（提升到 100 后转移清零）', async () => {
    await w.run(() => w.pokemon.BondUp(w.systemCtx(), JSON.stringify(['p_1']), '50', 'training', T3, 'idem-bond-p1'));
    expect((await w.getPokemon('p_1')).bond).toBe(100);
    const p = JSON.parse(await w.run(() => w.pokemon.Transfer(w.ctxAs('u_ash'), 'p_1', 'u_gary', T3, 'idem-t-bond')));
    expect(p.ownerId).toBe('u_gary');
    expect(p.bond).toBe(BOND_RESET);
    expect((await w.getPokemon('p_1')).bond).toBe(BOND_RESET);
    expect(w.eventNames()).toContain('PokemonTransferred');
  });

  test('Transfer：转给自己不算易主，bond 保持', async () => {
    await w.run(() => w.pokemon.BondUp(w.systemCtx(), JSON.stringify(['p_1']), '20', 'training', T3, 'idem-bond-self'));
    const p = JSON.parse(await w.run(() => w.pokemon.Transfer(w.ctxAs('u_ash'), 'p_1', 'u_ash', T3, 'idem-self-transfer')));
    expect(p.bond).toBe(70);
  });

  test('Trade：双方宝可梦交换后各自 bond 重置为 30', async () => {
    await w.run(() => w.pokemon.BondUp(w.systemCtx(), JSON.stringify(['p_1', 'p_2']), '50', 'training', T2, 'idem-bond-trade'));
    const offer = JSON.stringify({ pokemonIds: ['p_1'], itemIds: [], points: 0 });
    const request = JSON.stringify({ pokemonIds: ['p_2'], itemIds: [], points: 0 });
    await w.run(() => w.trade.CreateTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', 'u_gary', offer, request, EXPIRES, T3, 'idem-trade-bond-1'));
    await w.run(() => w.trade.ConfirmTrade(w.ctxAs('u_ash'), 't_1', 'u_ash', T4, 'idem-trade-bond-2'));
    await w.run(() => w.trade.ConfirmTrade(w.ctxAs('u_gary'), 't_1', 'u_gary', T4, 'idem-trade-bond-3'));
    expect((await w.getPokemon('p_1')).ownerId).toBe('u_gary');
    expect((await w.getPokemon('p_2')).ownerId).toBe('u_ash');
    expect((await w.getPokemon('p_1')).bond).toBe(BOND_RESET);
    expect((await w.getPokemon('p_2')).bond).toBe(BOND_RESET);
  });

  test('Battle 结算：易主的押注宝可梦 bond→30，赢家自有宝可梦保持', async () => {
    await w.run(() => w.pokemon.BondUp(w.systemCtx(), JSON.stringify(['p_1', 'p_2']), '50', 'training', T2, 'idem-bond-battle'));
    const wagerA: AssetBundle = { pokemonIds: ['p_1'], itemIds: [], points: 0 };
    const wagerB: AssetBundle = { pokemonIds: ['p_2'], itemIds: [], points: 0 };
    const wagerHash = w.wagerHash('u_ash', 'u_gary', wagerA, wagerB);
    await w.run(() =>
      w.battle.CreateBattle(w.systemCtx(), 'b_1', 'u_ash', 'u_gary', JSON.stringify(wagerA), JSON.stringify(wagerB), wagerHash, T3, 'idem-bb-1'),
    );
    await w.run(() => w.battle.ActivateBattle(w.systemCtx(), 'b_1', T3, 'idem-bb-2'));
    await w.run(() => w.battle.SubmitResult(w.systemCtx(), 'b_1', 'u_ash', hash('battle-result'), 'sig', T3, 'idem-bb-3'));
    await w.run(() => w.battle.ConfirmResult(w.ctxAs('u_ash'), 'b_1', 'u_ash', T4, 'idem-bb-4'));
    await w.run(() => w.battle.ConfirmResult(w.ctxAs('u_gary'), 'b_1', 'u_gary', T4, 'idem-bb-5'));
    expect((await w.getBattle('b_1')).status).toBe('SETTLED');
    expect((await w.getPokemon('p_1')).ownerId).toBe('u_ash');
    expect((await w.getPokemon('p_1')).bond).toBe(100);
    expect((await w.getPokemon('p_2')).ownerId).toBe('u_ash');
    expect((await w.getPokemon('p_2')).bond).toBe(BOND_RESET);
  });

  test('Battle DRAW：各自取回押注宝可梦，bond 不重置', async () => {
    const wagerA: AssetBundle = { pokemonIds: ['p_1'], itemIds: [], points: 0 };
    const wagerB: AssetBundle = { pokemonIds: ['p_2'], itemIds: [], points: 0 };
    const wagerHash = w.wagerHash('u_ash', 'u_gary', wagerA, wagerB);
    await w.run(() =>
      w.battle.CreateBattle(w.systemCtx(), 'b_draw', 'u_ash', 'u_gary', JSON.stringify(wagerA), JSON.stringify(wagerB), wagerHash, T3, 'idem-bd-1'),
    );
    await w.run(() => w.battle.ActivateBattle(w.systemCtx(), 'b_draw', T3, 'idem-bd-2'));
    await w.run(() => w.battle.SubmitResult(w.systemCtx(), 'b_draw', 'DRAW', hash('draw'), 'sig', T3, 'idem-bd-3'));
    await w.run(() => w.battle.ConfirmResult(w.ctxAs('u_ash'), 'b_draw', 'u_ash', T4, 'idem-bd-4'));
    await w.run(() => w.battle.ConfirmResult(w.ctxAs('u_gary'), 'b_draw', 'u_gary', T4, 'idem-bd-5'));
    expect((await w.getPokemon('p_1')).ownerId).toBe('u_ash');
    expect((await w.getPokemon('p_2')).ownerId).toBe('u_gary');
    expect((await w.getPokemon('p_1')).bond).toBe(BOND_DEFAULT);
    expect((await w.getPokemon('p_2')).bond).toBe(BOND_DEFAULT);
  });

  test('BondUp：批量提升每只 +delta，上限 255 截断，事件 BondChanged', async () => {
    await w.run(() => w.pokemon.BondUp(w.systemCtx(), JSON.stringify(['p_1', 'p_2']), '50', 'daily-walk', T3, 'idem-bond-many'));
    expect((await w.getPokemon('p_1')).bond).toBe(100);
    expect((await w.getPokemon('p_2')).bond).toBe(100);
    // 100 → 150 → 200 → 250 → 300 截断为 255
    for (let i = 0; i < 4; i++) {
      await w.run(() => w.pokemon.BondUp(w.systemCtx(), JSON.stringify(['p_1']), '50', 'daily-walk', T3, `idem-bond-cap-${i}`));
    }
    expect((await w.getPokemon('p_1')).bond).toBe(255);
    expect(w.eventNames().filter((n) => n === 'BondChanged')).toHaveLength(6);
  });

  test('BondUp：仅 system；delta 1-50；空/重复/不存在 id 与 RELEASED 全部拒绝', async () => {
    const call = (ids: string[], delta: string, key: string, reason = 'walk') =>
      w.run(() => w.pokemon.BondUp(w.systemCtx(), JSON.stringify(ids), delta, reason, T3, key));
    await expectCode(
      w.run(() => w.pokemon.BondUp(w.ctxAs('u_ash'), JSON.stringify(['p_1']), '10', 'walk', T3, 'idem-b1')),
      'FORBIDDEN',
    );
    await expectCode(call(['p_1'], '0', 'idem-b2'), 'INVALID_PARAM');
    await expectCode(call(['p_1'], '51', 'idem-b3'), 'INVALID_PARAM');
    await expectCode(call(['p_1'], '10', 'idem-b4', ''), 'INVALID_PARAM');
    await expectCode(call([], '10', 'idem-b5'), 'INVALID_PARAM');
    await expectCode(call(['p_1', 'p_1'], '10', 'idem-b6'), 'INVALID_PARAM');
    await expectCode(call(['p_x'], '10', 'idem-b7'), 'POKEMON_NOT_FOUND');
    // 放生后不可再提升（Released 保留记录但已无 owner）
    await w.run(() => w.pokemon.Release(w.ctxAs('u_gary'), 'p_2', T3, 'idem-rel-bond'));
    await expectCode(call(['p_2'], '10', 'idem-b8'), 'BAD_STATE');
    // 失败调用不落库
    expect((await w.getPokemon('p_1')).bond).toBe(BOND_DEFAULT);
    expect((await w.getPokemon('p_2')).bond).toBe(BOND_DEFAULT);
  });

  test('BondUp：锁定中的宝可梦同样可提升（只禁止 RELEASED）', async () => {
    const wagerA: AssetBundle = { pokemonIds: ['p_1'], itemIds: [], points: 0 };
    const empty: AssetBundle = { pokemonIds: [], itemIds: [], points: 0 };
    const wagerHash = w.wagerHash('u_ash', 'u_gary', wagerA, empty);
    await w.run(() =>
      w.battle.CreateBattle(w.systemCtx(), 'b_lock', 'u_ash', 'u_gary', JSON.stringify(wagerA), JSON.stringify(empty), wagerHash, T3, 'idem-block-1'),
    );
    expect((await w.getPokemon('p_1')).status).toBe('LOCKED_BATTLE');
    await w.run(() => w.pokemon.BondUp(w.systemCtx(), JSON.stringify(['p_1']), '10', 'training', T3, 'idem-bond-locked'));
    expect((await w.getPokemon('p_1')).bond).toBe(60);
  });
});

describe('Player.rating（排位分：默认 1000 / UpdateRating）', () => {
  let w: World;
  beforeEach(() => {
    w = new World();
  });

  test('RegisterPlayer：初始 rating=1000，GetPlayer 原样返回', async () => {
    await w.registerPlayer('u_ash', ORG1);
    const p = await w.getPlayer('u_ash');
    expect(p.rating).toBe(1000);
    expect(p.points).toBe(1000);
  });

  test('UpdateRating：仅 system；0/99999 边界合法，越界/非整数/不存在拒绝，发 RatingChanged', async () => {
    await w.registerPlayer('u_ash', ORG1);
    await expectCode(w.run(() => w.player.UpdateRating(w.ctxAs('u_ash'), 'u_ash', '1200', 'battle', T2, 'idem-r1')), 'FORBIDDEN');
    await expectCode(w.run(() => w.player.UpdateRating(w.adminCtx(), 'u_ash', '1200', 'battle', T2, 'idem-r1b')), 'FORBIDDEN');
    const low = JSON.parse(await w.run(() => w.player.UpdateRating(w.systemCtx(), 'u_ash', '0', 'placement', T2, 'idem-r2')));
    expect(low.rating).toBe(0);
    const high = JSON.parse(await w.run(() => w.player.UpdateRating(w.systemCtx(), 'u_ash', '99999', 'battle-win', T2, 'idem-r3')));
    expect(high.rating).toBe(99999);
    await expectCode(w.run(() => w.player.UpdateRating(w.systemCtx(), 'u_ash', '-1', 'x', T2, 'idem-r4')), 'INVALID_PARAM');
    await expectCode(w.run(() => w.player.UpdateRating(w.systemCtx(), 'u_ash', '100000', 'x', T2, 'idem-r5')), 'INVALID_PARAM');
    await expectCode(w.run(() => w.player.UpdateRating(w.systemCtx(), 'u_ash', '12.5', 'x', T2, 'idem-r6')), 'INVALID_PARAM');
    await expectCode(w.run(() => w.player.UpdateRating(w.systemCtx(), 'u_nobody', '1200', 'x', T2, 'idem-r7')), 'PLAYER_NOT_FOUND');
    expect(w.eventNames()).toContain('RatingChanged');
    expect((await w.getPlayer('u_ash')).rating).toBe(99999);
    // rating 与 points 相互独立
    expect((await w.getPlayer('u_ash')).points).toBe(1000);
  });

  test('旧记录缺 rating 字段：按默认 1000 读取', async () => {
    await w.registerPlayer('u_ash', ORG1);
    const legacy = await w.getPlayer('u_ash');
    delete legacy.rating;
    await w.run(() => w.stub.putState('player:u_ash', Buffer.from(JSON.stringify(legacy))));
    expect((await w.getPlayer('u_ash')).rating).toBe(1000);
    const updated = await w.run(() => w.player.UpdateRating(w.systemCtx(), 'u_ash', '1100', 'battle', T1, 'idem-r-legacy'));
    expect(JSON.parse(updated).rating).toBe(1100);
  });
});
