import RedisMock from 'ioredis-mock';
import { BattleManagerService } from '../src/battles/battle-manager.service';
import { BattlesService, BattleRoom } from '../src/battles/battles.service';
import { SigningService } from '../src/battles/signing.service';
import { BattleLog } from '../src/battles/entities/battle-log.entity';
import { DisputeRecord } from '../src/battles/entities/dispute-record.entity';
import { AuditLog } from '../src/admin/entities/audit-log.entity';
import { sha256hex } from '../src/common/utils/crypto.util';
import { computeWagerHash } from '../src/fabric/chain.adapter';
import {
  SYSTEM_IDENTITY,
  makeBlocks,
  makeChain,
  makeConfig,
  makeHpService,
  makeRedis,
  mockRepo,
  registerPlayers,
  seedPokemon,
  userIdentity,
} from './helpers';

/**
 * 重启对账（BattlesService.reconcileRooms）：内存引擎随进程消失后，Redis 房间
 * 按链上状态收尾——终态关房 / RESULT_SUBMITTED 兜底结算 / CREATED 直接取消退款 /
 * ACTIVE 以 DRAW 退款；运行期对停滞房间先隐藏再后台对账。见 docs/backend-api.md §5。
 */

const RECONCILE_CONFIG = {
  battle: {
    turnTimeoutMs: 30_000,
    disconnectTimeoutMs: 60_000,
    entryGraceMs: 90_000,
    settleFallbackMs: 120_000,
    reconcileStaleMs: 600_000,
  },
};

const POINTS = 20;
const MON = (pokemonId: string, speciesId: number) => ({
  pokemonId,
  speciesId,
  level: 20,
  ivs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 },
  moves: ['tackle'],
});

// ioredis-mock 的所有实例共享同一份数据：每个用例前只清 battle 相关键，
// 避免房间/大厅缓存跨用例泄漏（不动其他 spec 可能依赖的 mockchain:* 状态）
beforeEach(async () => {
  const redis = new RedisMock();
  const keys = await redis.keys('battle:*');
  if (keys.length > 0) await redis.del(...keys);
  await redis.del('cache:battle:lobby');
});

type Shared = {
  chain: ReturnType<typeof makeChain>['chain'];
  contract: ReturnType<typeof makeChain>['contract'];
  redis: ReturnType<typeof makeRedis>;
};

/** 链 + Redis + manager + BattlesService（对账不经过 gateway）；boot=true 时走 onModuleInit。 */
function makeStack(boot = false, shared?: Shared) {
  const { chain, contract } = shared ?? makeChain();
  const redis = shared?.redis ?? makeRedis();
  const manager = new BattleManagerService(
    contract,
    redis,
    new SigningService(makeConfig({ serverSigningKey: '' })),
    makeConfig(RECONCILE_CONFIG),
    mockRepo<BattleLog>() as never,
  );
  const audits = mockRepo<AuditLog>();
  const battles = new BattlesService(
    contract,
    redis,
    manager,
    { mustFindByUsername: async (u: string) => ({ username: u, fabricMspId: 'Org2MSP' }) } as never,
    makeBlocks(makeConfig(RECONCILE_CONFIG)),
    makeHpService(redis),
    audits as never,
    mockRepo<DisputeRecord>() as never,
    makeConfig(RECONCILE_CONFIG),
  );
  if (boot) battles.onModuleInit();
  return { chain, contract, redis, manager, battles, audits };
}

type Stack = ReturnType<typeof makeStack>;

/** 模拟进程重启：同一份链状态与 Redis，换一个没有引擎的内存注册表。 */
function restart(stack: Stack): Stack {
  return makeStack(false, { chain: stack.chain, contract: stack.contract, redis: stack.redis });
}

/** ash/gary 各押一只宝可梦 + points 确认开战：链上 ACTIVE、房间 ACTIVE、引擎活在本堆栈。 */
async function activateRoom(stack: Stack, battleId: string) {
  await registerPlayers(stack.contract, 'ash', 'gary');
  const wageredA = await seedPokemon(stack.chain, 'ash', { id: `${battleId}_wa` });
  const wageredB = await seedPokemon(stack.chain, 'gary', { id: `${battleId}_wb` });
  const teamA = await seedPokemon(stack.chain, 'ash', { id: `${battleId}_ta` });
  const teamB = await seedPokemon(stack.chain, 'gary', { id: `${battleId}_tb` });
  const wagerA = { pokemonIds: [wageredA.id], items: [], points: POINTS };
  const wagerB = { pokemonIds: [wageredB.id], items: [], points: POINTS };
  const wagerHash = computeWagerHash('ash', 'gary', wagerA, wagerB);
  await stack.contract.createBattle(SYSTEM_IDENTITY, { id: battleId, playerA: 'ash', playerB: 'gary', wagerA, wagerB, wagerHash });
  await stack.contract.activateBattle(SYSTEM_IDENTITY, battleId);
  await stack.manager.startBattle(battleId, 'ash', 'gary', [MON(teamA.id, 25)], [MON(teamB.id, 9)]);
  const room: BattleRoom = {
    id: `r_${battleId}`,
    mode: '1v1',
    playerA: 'ash',
    playerB: 'gary',
    wagerA,
    wagerB,
    teamA: [teamA.id],
    teamB: [teamB.id],
    confirmations: { A: true, B: true },
    status: 'ACTIVE',
    battleId,
    createdAt: new Date().toISOString(),
  };
  await stack.redis.setJson(`battle:room:${room.id}`, room, 3600);
  await stack.redis.sadd('battle:rooms', room.id);
  return { room, wageredA, wageredB };
}

describe('battle room reconciliation on startup (重启对账)', () => {
  it('SETTLED：链上已终态的残留房间只关房出列，不再做链上操作', async () => {
    const stack = makeStack();
    const { room } = await activateRoom(stack, 'b_rc_settled');
    await stack.contract.submitBattleResult(SYSTEM_IDENTITY, 'b_rc_settled', 'gary', 'r'.repeat(64), 'sig');
    await stack.contract.settleBattle(SYSTEM_IDENTITY, 'b_rc_settled');
    const pointsBefore = (await stack.contract.getPlayer('ash')).points;

    const after = restart(stack);
    await after.battles.reconcileRooms('startup');

    expect((await after.battles.getRoom(room.id)).status).toBe('FINISHED');
    expect(await after.battles.listRooms()).toHaveLength(0);
    expect((await after.contract.getPlayer('ash')).points).toBe(pointsBefore); // 幂等，分数不变
  });

  it('RESULT_SUBMITTED：兜底 SettleBattle，赢家结算后关房', async () => {
    const stack = makeStack();
    const { room } = await activateRoom(stack, 'b_rc_submitted');
    // 引擎已 SubmitResult，但确认/兜底都还没发生就重启
    await stack.contract.submitBattleResult(SYSTEM_IDENTITY, 'b_rc_submitted', 'gary', 'r'.repeat(64), 'sig');

    const after = restart(stack);
    await after.battles.reconcileRooms('startup');

    const battle = await after.contract.getBattle('b_rc_submitted');
    expect(battle.status).toBe('SETTLED');
    expect(battle.result.winnerId).toBe('gary');
    expect((await after.contract.getPlayer('gary')).points).toBe(1020); // 980 + 40 escrow
    expect((await after.battles.getRoom(room.id)).status).toBe('FINISHED');
    expect(await after.battles.listRooms()).toHaveLength(0);
  });

  it('ACTIVE（引擎随重启丢失）：按服务中断 DRAW 退款，资产解锁归还并关房', async () => {
    const stack = makeStack();
    const { room, wageredA, wageredB } = await activateRoom(stack, 'b_rc_active');
    expect((await stack.contract.getPokemon(wageredA.id)).status).toBe('LOCKED_BATTLE');

    const after = restart(stack);
    expect(await after.battles.listRooms()).toHaveLength(1); // 重启瞬间还看不到结果，先按原样列出
    await after.battles.reconcileRooms('startup');

    const battle = await after.contract.getBattle('b_rc_active');
    expect(battle.status).toBe('SETTLED');
    expect(battle.result.winnerId).toBe('DRAW');
    // resultHash 带服务端对账标记（链上 result 没有备注字段）
    expect(battle.result.resultHash).toBe(sha256hex(`server-restart|b_rc_active`));
    expect(battle.result.serverSubmitted).toBe(true);
    expect(battle.escrow).toEqual({ pointsA: 0, pointsB: 0 });
    expect((await after.contract.getPokemon(wageredA.id)).ownerId).toBe('ash');
    expect((await after.contract.getPokemon(wageredA.id)).status).toBe('IDLE');
    expect((await after.contract.getPokemon(wageredB.id)).ownerId).toBe('gary');
    expect((await after.contract.getPokemon(wageredB.id)).status).toBe('IDLE');
    expect((await after.contract.getPlayer('ash')).points).toBe(1000);
    expect((await after.contract.getPlayer('gary')).points).toBe(1000);
    expect((await after.battles.getRoom(room.id)).status).toBe('FINISHED');
    expect(await after.battles.listRooms()).toHaveLength(0);
    expect(after.audits.rows[0]).toMatchObject({ action: 'battle.reconcile', target: 'b_rc_active' });
  });

  it('CREATED（确认押注中途重启）：CancelBattle 直接退款（REFUNDED），锁定资产解锁', async () => {
    const stack = makeStack();
    await registerPlayers(stack.contract, 'ash', 'gary');
    const wageredA = await seedPokemon(stack.chain, 'ash', { id: 'p_rc_c_a' });
    const wageredB = await seedPokemon(stack.chain, 'gary', { id: 'p_rc_c_b' });
    const wagerA = { pokemonIds: [wageredA.id], items: [], points: POINTS };
    const wagerB = { pokemonIds: [wageredB.id], items: [], points: POINTS };
    const wagerHash = computeWagerHash('ash', 'gary', wagerA, wagerB);
    // 模拟 CreateBattle 成功、ActivateBattle 之前进程退出：房间仍是 JOINED
    await stack.contract.createBattle(SYSTEM_IDENTITY, { id: 'b_rc_created', playerA: 'ash', playerB: 'gary', wagerA, wagerB, wagerHash });
    const room: BattleRoom = {
      id: 'r_rc_created',
      mode: '1v1',
      playerA: 'ash',
      playerB: 'gary',
      wagerA,
      wagerB,
      teamA: [wageredA.id],
      teamB: [wageredB.id],
      confirmations: { A: true, B: true },
      status: 'JOINED',
      battleId: 'b_rc_created',
      createdAt: new Date().toISOString(),
    };
    await stack.redis.setJson(`battle:room:${room.id}`, room, 3600);
    await stack.redis.sadd('battle:rooms', room.id);

    const after = restart(stack);
    await after.battles.reconcileRooms('startup');

    const battle = await after.contract.getBattle('b_rc_created');
    expect(battle.status).toBe('REFUNDED');
    expect(battle.result.winnerId).toBe('REFUND');
    expect(battle.result.resultHash).toBe(sha256hex('cancel|b_rc_created|server-restart'));
    expect((await after.contract.getPokemon(wageredA.id)).ownerId).toBe('ash');
    expect((await after.contract.getPokemon(wageredA.id)).status).toBe('IDLE');
    expect((await after.contract.getPlayer('ash')).points).toBe(1000);
    expect((await after.battles.getRoom(room.id)).status).toBe('FINISHED');
    expect(await after.battles.listRooms()).toHaveLength(0);
  });

  it('仲裁中（DISPUTED）的房间只关房，资产保持冻结待裁决', async () => {
    const stack = makeStack();
    const { room, wageredA } = await activateRoom(stack, 'b_rc_disputed');
    await stack.contract.disputeBattle(userIdentity('ash'), 'b_rc_disputed', 'ash', 'suspicious');

    const after = restart(stack);
    await after.battles.reconcileRooms('startup');

    expect((await after.contract.getBattle('b_rc_disputed')).status).toBe('DISPUTED');
    expect((await after.contract.getPokemon(wageredA.id)).status).toBe('LOCKED_BATTLE');
    expect((await after.battles.getRoom(room.id)).status).toBe('FINISHED');
  });

  it('单个房间对账失败不阻断其他房间（链上查不到 battle → 只关房）', async () => {
    const stack = makeStack();
    await registerPlayers(stack.contract, 'ash', 'gary');
    const ghost: BattleRoom = {
      id: 'r_rc_ghost',
      mode: '1v1',
      playerA: 'ash',
      playerB: 'gary',
      wagerA: { pokemonIds: [], items: [], points: 0 },
      wagerB: { pokemonIds: [], items: [], points: 0 },
      teamA: [],
      teamB: [],
      confirmations: { A: true, B: true },
      status: 'ACTIVE',
      battleId: 'b_rc_missing',
      createdAt: new Date().toISOString(),
    };
    await stack.redis.setJson(`battle:room:${ghost.id}`, ghost, 3600);
    await stack.redis.sadd('battle:rooms', ghost.id);
    const { room } = await activateRoom(stack, 'b_rc_ok');

    const after = restart(stack);
    await after.battles.reconcileRooms('startup');

    expect((await after.battles.getRoom(ghost.id)).status).toBe('FINISHED');
    expect((await after.contract.getBattle('b_rc_ok')).status).toBe('SETTLED');
    expect((await after.battles.getRoom(room.id)).status).toBe('FINISHED');
  });

  it('链不可读（非 BATTLE_NOT_FOUND）时保留房间，不误关', async () => {
    const stack = makeStack();
    const { room } = await activateRoom(stack, 'b_rc_offline');
    const after = restart(stack);
    jest.spyOn(after.contract, 'getBattle').mockRejectedValueOnce(new Error('PEER_UNAVAILABLE: connection refused'));

    await after.battles.reconcileRooms('startup');

    expect((await after.battles.getRoom(room.id)).status).toBe('ACTIVE');
    expect((await after.contract.getBattle('b_rc_offline')).status).toBe('ACTIVE');
  });

  it('onModuleInit 自动跑启动对账（fire-and-forget，可与显式调用 join）', async () => {
    const stack = makeStack();
    const { room } = await activateRoom(stack, 'b_rc_boot');
    const after = makeStack(true, { chain: stack.chain, contract: stack.contract, redis: stack.redis });

    await after.battles.reconcileRooms('startup');
    expect((await after.contract.getBattle('b_rc_boot')).status).toBe('SETTLED');
    expect((await after.battles.getRoom(room.id)).status).toBe('FINISHED');
  });
});

describe('lobby runtime fallback for stuck rooms (运行期兜底)', () => {
  it('ACTIVE 房间无引擎且超过阈值：隐藏并后台对账（DRAW 退款、房间出列）', async () => {
    const stack = makeStack();
    const { room } = await activateRoom(stack, 'b_rc_stale');
    const after = restart(stack);
    // 手动把房间写成"很久没推进过"（模拟重启前留下的 updatedAt）
    const stored = (await after.redis.getJson<BattleRoom>(`battle:room:${room.id}`))!;
    stored.updatedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    await after.redis.setJson(`battle:room:${room.id}`, stored, 3600);

    expect(await after.battles.listRooms()).toHaveLength(0); // 不再显示幽灵"战斗中"房间
    await after.battles.reconcileRooms('runtime'); // 同一次后台对账（listRooms 已触发）
    const battle = await after.contract.getBattle('b_rc_stale');
    expect(battle.status).toBe('SETTLED');
    expect(battle.result.winnerId).toBe('DRAW');
    expect((await after.battles.getRoom(room.id)).status).toBe('FINISHED');
  });

  it('ACTIVE 房间无引擎但未超过阈值：仍可见（短时间内允许回到战斗）', async () => {
    const stack = makeStack();
    const { room } = await activateRoom(stack, 'b_rc_fresh');
    const after = restart(stack);

    const rooms = await after.battles.listRooms();
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ id: room.id, status: 'ACTIVE', battleId: 'b_rc_fresh' });
    expect((await after.contract.getBattle('b_rc_fresh')).status).toBe('ACTIVE');
  });

  it('本进程还有活引擎的 ACTIVE 房间：列表可见且对账不碰它', async () => {
    const stack = makeStack();
    const { room } = await activateRoom(stack, 'b_rc_live');

    const rooms = await stack.battles.listRooms();
    expect(rooms).toHaveLength(1);
    expect(rooms[0].id).toBe(room.id);

    await stack.battles.reconcileRooms('startup');
    expect((await stack.contract.getBattle('b_rc_live')).status).toBe('ACTIVE');
    expect((await stack.battles.getRoom(room.id)).status).toBe('ACTIVE');
  });
});
