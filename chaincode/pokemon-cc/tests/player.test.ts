import { expectCode, ORG1, ORG2, T1, T2, World } from './helpers/harness';

describe('PlayerContract', () => {
  let w: World;
  beforeEach(() => {
    w = new World();
  });

  test('注册玩家（admin 代注册）：初始 points=1000、role=player、mspId 取调用者，发 PlayerRegistered 事件', async () => {
    const res = await w.run(() => w.player.RegisterPlayer(w.adminCtx(), 'u_ash', '小智', T1, 'idem-1'));
    const p = JSON.parse(res);
    expect(p).toMatchObject({
      docType: 'player',
      playerId: 'u_ash',
      mspId: ORG1,
      nickname: '小智',
      role: 'player',
      points: 1000,
      wins: 0,
      losses: 0,
      createdAt: T1,
    });
    expect(w.eventNames()).toContain('PlayerRegistered');
  });

  test('重复注册抛 PLAYER_EXISTS', async () => {
    await w.registerPlayer('u_ash', ORG1);
    await expectCode(w.run(() => w.player.RegisterPlayer(w.adminCtx(), 'u_ash', 'x', T1, 'idem-2')), 'PLAYER_EXISTS');
  });

  test('注册玩家：仅 admin/system；普通玩家证书冒名注册被拒 FORBIDDEN（防抢注 username）', async () => {
    await expectCode(
      w.run(() => w.player.RegisterPlayer(w.ctxAs('u_mallory'), 'u_ash', 'x', T1, 'idem-reg-player')),
      'FORBIDDEN',
    );
    await expectCode(
      w.run(() => w.player.RegisterPlayer(w.ctx(ORG1), 'u_ash', 'x', T1, 'idem-reg-none')),
      'FORBIDDEN',
    );
    await w.run(() => w.player.RegisterPlayer(w.systemCtx(), 'u_ash', '小智', T1, 'idem-reg-system'));
    expect((await w.getPlayer('u_ash')).points).toBe(1000);
  });

  test('AddPoints：admin 加分/扣分，事件 PointsChanged', async () => {
    await w.registerPlayer('u_ash', ORG1);
    let p = JSON.parse(await w.run(() => w.player.AddPoints(w.adminCtx(), 'u_ash', '500', 'quest', T2, 'idem-3')));
    expect(p.points).toBe(1500);
    p = JSON.parse(await w.run(() => w.player.AddPoints(w.systemCtx(), 'u_ash', '-200', 'fee', T2, 'idem-4')));
    expect(p.points).toBe(1300);
    expect(w.eventNames()).toContain('PointsChanged');
  });

  test('AddPoints：余额不得为负，抛 INSUFFICIENT_POINTS', async () => {
    await w.registerPlayer('u_ash', ORG1);
    await expectCode(
      w.run(() => w.player.AddPoints(w.adminCtx(), 'u_ash', '-1001', 'fee', T2, 'idem-5')),
      'INSUFFICIENT_POINTS',
    );
    expect((await w.getPlayer('u_ash')).points).toBe(1000);
  });

  test('AddPoints：非 admin/system 被拒 FORBIDDEN', async () => {
    await w.registerPlayer('u_ash', ORG1);
    await expectCode(w.run(() => w.player.AddPoints(w.ctxAs('u_ash'), 'u_ash', '1', 'x', T2, 'idem-6')), 'FORBIDDEN');
  });

  test('GrantRole：仅 admin；非法角色抛 INVALID_PARAM', async () => {
    await w.registerPlayer('u_ash', ORG1);
    await expectCode(w.run(() => w.player.GrantRole(w.ctxAs('u_ash'), 'u_ash', 'admin', T2, 'idem-7')), 'FORBIDDEN');
    await expectCode(w.run(() => w.player.GrantRole(w.adminCtx(), 'u_ash', 'superuser', T2, 'idem-8')), 'INVALID_PARAM');
    const p = JSON.parse(await w.run(() => w.player.GrantRole(w.adminCtx(), 'u_ash', 'admin', T2, 'idem-9')));
    expect(p.role).toBe('admin');
    expect(w.eventNames()).toContain('RoleGranted');
  });

  test('TransferPoints：本人转账成功', async () => {
    await w.registerPlayer('u_ash', ORG1);
    await w.registerPlayer('u_gary', ORG2);
    const res = JSON.parse(await w.run(() => w.player.TransferPoints(w.ctxAs('u_ash'), 'u_ash', 'u_gary', '300', T2, 'idem-10')));
    expect(res).toMatchObject({ fromBalance: 700, toBalance: 1300 });
    expect((await w.getPlayer('u_ash')).points).toBe(700);
    expect((await w.getPlayer('u_gary')).points).toBe(1300);
  });

  test('TransferPoints：同 Org1 的其他玩家不能转走本人积分（hf.EnrollmentID 不匹配）抛 NOT_OWNER', async () => {
    await w.registerPlayer('u_ash', ORG1);
    await w.registerPlayer('u_gary', ORG1);
    // u_gary 与 u_ash 同属 Org1MSP：只看 mspId 会被放行，故必须按 enrollmentId 拒绝
    await expectCode(
      w.run(() => w.player.TransferPoints(w.ctxAs('u_gary'), 'u_ash', 'u_gary', '100', T2, 'idem-11')),
      'NOT_OWNER',
    );
    // 缺 hf.EnrollmentID 的证书同样拒绝（不回退 mspId）
    await expectCode(
      w.run(() => w.player.TransferPoints(w.ctx(ORG1), 'u_ash', 'u_gary', '100', T2, 'idem-11b')),
      'NOT_OWNER',
    );
    expect((await w.getPlayer('u_ash')).points).toBe(1000);
    expect((await w.getPlayer('u_gary')).points).toBe(1000);
  });

  test('TransferPoints：本人证书不能从他人账户扣款（A 冒充 B 的转出）抛 NOT_OWNER', async () => {
    await w.registerPlayer('u_ash', ORG1);
    await w.registerPlayer('u_gary', ORG1);
    await expectCode(
      w.run(() => w.player.TransferPoints(w.ctxAs('u_ash'), 'u_gary', 'u_ash', '100', T2, 'idem-14')),
      'NOT_OWNER',
    );
    expect((await w.getPlayer('u_gary')).points).toBe(1000);
    expect((await w.getPlayer('u_ash')).points).toBe(1000);
  });

  test('TransferPoints：amount 必须 >0 且余额充足', async () => {
    await w.registerPlayer('u_ash', ORG1);
    await w.registerPlayer('u_gary', ORG2);
    await expectCode(w.run(() => w.player.TransferPoints(w.ctxAs('u_ash'), 'u_ash', 'u_gary', '0', T2, 'idem-12')), 'INVALID_PARAM');
    await expectCode(
      w.run(() => w.player.TransferPoints(w.ctxAs('u_ash'), 'u_ash', 'u_gary', '1001', T2, 'idem-13')),
      'INSUFFICIENT_POINTS',
    );
  });

  test('GetPlayer：不存在抛 PLAYER_NOT_FOUND', async () => {
    await expectCode(w.run(() => w.player.GetPlayer(w.systemCtx(), 'u_nobody')), 'PLAYER_NOT_FOUND');
  });
});
