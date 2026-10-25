import { HttpException } from '@nestjs/common';
import { BattleManagerService } from '../src/battles/battle-manager.service';
import { BattlesService } from '../src/battles/battles.service';
import { SigningService } from '../src/battles/signing.service';
import { BattleLog } from '../src/battles/entities/battle-log.entity';
import { DisputeRecord } from '../src/battles/entities/dispute-record.entity';
import { AuditLog } from '../src/admin/entities/audit-log.entity';
import { User } from '../src/users/entities/user.entity';
import { BattleRewardService } from '../src/ranked/battle-reward.service';
import { RankedBattleLauncher } from '../src/ranked/battle-launcher';
import { RankedBotService } from '../src/ranked/bot.service';
import { computeWagerHash } from '../src/fabric/chain.adapter';
import { BondService } from '../src/ranked/bond.service';
import { utcDate } from '../src/ranked/bot';
import { QUEUE_TTL_SEC, RankedService } from '../src/ranked/ranked.service';
import { eloUpdate, expectedScore, MATCH_WINDOW } from '../src/ranked/elo';
import {
  SYSTEM_IDENTITY,
  makeBlocks,
  makeChain,
  makeConfig,
  makeHpService,
  makePokemonService,
  makeRedis,
  mockRepo,
  registerPlayers,
  seedPokemon,
  userIdentity,
} from './helpers';

const BATTLE_CONFIG = {
  battle: {
    turnTimeoutMs: 30_000,
    disconnectTimeoutMs: 60_000,
    entryGraceMs: 90_000,
    settleFallbackMs: 300_000,
  },
};

const nickOf = (username: string) => `nick-${username}`;
const stacks: BattleRewardService[] = [];

/** 全栈：内存链/Redis + battles 房间流程 + ranked/bond/结算挂钩（不起 HTTP/WS）。 */
async function makeStack() {
  const { chain, contract } = makeChain();
  const redis = makeRedis();
  // ioredis-mock 在同进程内共享数据：每个用例开新栈前先清空，避免用例间串味
  await redis.client.flushall();
  const signing = new SigningService(makeConfig({ serverSigningKey: '' }));
  const manager = new BattleManagerService(contract, redis, signing, makeConfig(BATTLE_CONFIG), mockRepo<BattleLog>() as never);
  const users = {
    findByUsername: async (username: string) => ({ username, nickname: nickOf(username), role: 'player' }),
  };
  const battles = new BattlesService(
    contract,
    redis,
    manager,
    users as never,
    makeBlocks(makeConfig(BATTLE_CONFIG)),
    makeHpService(redis),
    mockRepo<AuditLog>() as never,
    mockRepo<DisputeRecord>() as never,
    makeConfig(BATTLE_CONFIG),
  );
  battles.onModuleInit();
  const userRepo = mockRepo<User>();
  const launcher = new RankedBattleLauncher(contract, manager, makeHpService(redis));
  const ranked = new RankedService(contract, redis, battles, users as never, launcher, makeHpService(redis), userRepo as never);
  const bonds = new BondService(contract, redis);
  const pokemon = makePokemonService(contract, redis);
  const rewards = new BattleRewardService(battles, contract, redis, ranked, bonds, pokemon, makeConfig(BATTLE_CONFIG));
  rewards.onModuleInit();
  const bots = new RankedBotService(contract, redis, manager, launcher, ranked, rewards);
  bots.onModuleInit();
  stacks.push(rewards);
  return { chain, contract, redis, manager, battles, ranked, bots, bonds, rewards, userRepo };
}

afterEach(() => {
  for (const rewards of stacks.splice(0)) rewards.onModuleDestroy();
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

/** 双方入队 → 配对（MATCH_PENDING）→ 双方接受 → 建房（MATCHED） */
async function matchRanked(stack: ReturnType<typeof makeStack>, pA: string, pB: string) {
  const first = await stack.ranked.enqueue(userIdentity('ash'), [pA]);
  const pending = await stack.ranked.enqueue(userIdentity('gary'), [pB]);
  await stack.ranked.accept(userIdentity('ash'));
  const second = await stack.ranked.accept(userIdentity('gary'));
  const status = second.state === 'MATCHED' ? second : await stack.ranked.status(userIdentity('ash'));
  return { first, second, pending, status };
}

/** 提交结果 + 双方确认（第二次确认链上 SETTLED，BattlesService 会广播 settled） */
async function settleThroughConfirm(
  stack: ReturnType<typeof makeStack>,
  battleId: string,
  winnerId: string,
) {
  await stack.contract.submitBattleResult(SYSTEM_IDENTITY, battleId, winnerId, 'r'.repeat(64), 'sig');
  await stack.battles.confirmResult(userIdentity('ash'), battleId);
  return stack.battles.confirmResult(userIdentity('gary'), battleId);
}

/** 链上直接兜底结算（等价于 2 分钟无人确认后的 SettleBattle） */
async function chainSettle(contract: ReturnType<typeof makeChain>['contract'], battleId: string, winnerId: string) {
  await contract.submitBattleResult(SYSTEM_IDENTITY, battleId, winnerId, 'r'.repeat(64), 'sig', {
    idemKey: `${battleId}-test-result`,
  });
  return contract.settleBattle(SYSTEM_IDENTITY, battleId, { idemKey: `${battleId}-test-settle` });
}

async function seedTeams(chain: ReturnType<typeof makeChain>['chain'], contract: ReturnType<typeof makeChain>['contract']) {
  await registerPlayers(contract, 'ash', 'gary');
  const pa = await seedPokemon(chain, 'ash', { id: 'p_rank_a', bond: 50 });
  const pb = await seedPokemon(chain, 'gary', { id: 'p_rank_b', bond: 50 });
  return { pa, pb };
}

describe('ELO 计算（docs/backend-api.md §11）', () => {
  it('期望分：同分 0.5，对手高出 400 分约 0.909', () => {
    expect(expectedScore(1000, 1000)).toBeCloseTo(0.5, 6);
    expect(expectedScore(1400, 1000)).toBeCloseTo(1 / (1 + 10 ** -1), 6);
    expect(expectedScore(1000, 1400)).toBeCloseTo(1 / (1 + 10 ** 1), 6);
    expect(expectedScore(1400, 1000) + expectedScore(1000, 1400)).toBeCloseTo(1, 6);
  });

  it('K=32：同分胜负 ±16，平局 0', () => {
    const win = eloUpdate(1000, 1000, 'A');
    expect(win.a.after).toBe(1016);
    expect(win.a.delta).toBe(16);
    expect(win.b.after).toBe(984);
    expect(win.b.delta).toBe(-16);
    const draw = eloUpdate(1000, 1000, 'DRAW');
    expect(draw.a.after).toBe(1000);
    expect(draw.b.after).toBe(1000);
  });

  it('低分击败高分涨得多（冷门），平局按 0.5 期望结算', () => {
    const upset = eloUpdate(1000, 1400, 'A');
    expect(upset.a.delta).toBeGreaterThan(eloUpdate(1000, 1000, 'A').a.delta);
    expect(upset.b.delta).toBe(-upset.a.delta);
    const draw = eloUpdate(1000, 1400, 'DRAW');
    expect(draw.a.delta).toBe(13); // 32 × (0.5 − 1/(1+10)) ≈ 13.09
    expect(draw.b.delta).toBe(-13);
  });

  it('结果夹在 0-99999，且对给定入参可重放（纯函数）', () => {
    expect(eloUpdate(0, 20000, 'B').a.after).toBe(0);
    expect(eloUpdate(99999, 0, 'A').a.after).toBe(99999);
    expect(eloUpdate(1000, 1100, 'A')).toEqual(eloUpdate(1000, 1100, 'A'));
  });
});

describe('排位匹配（docs/backend-api.md §11）', () => {
  it('±200 分内即时配对：建房 wager=0、双方自动确认、写入排位记录', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    const { second } = await matchRanked(stack, pa.id, pb.id);
    expect(second.state).toBe('MATCHED');
    const battleId = second.battleId as string;
    const roomId = second.roomId as string;
    expect(second.opponent?.playerId).toBe('ash');
    expect(second.opponent?.rating).toBe(1000);

    const room = await stack.battles.getRoom(roomId);
    expect(room.status).toBe('ACTIVE');
    expect(room.battleId).toBe(battleId);
    expect(room.wagerA).toEqual({ pokemonIds: [], items: [], points: 0 });
    expect(room.wagerB).toEqual({ pokemonIds: [], items: [], points: 0 });

    const record = await stack.ranked.battleRecord(battleId);
    expect(record).toMatchObject({
      playerA: 'ash',
      playerB: 'gary',
      teamA: [pa.id],
      teamB: [pb.id],
      state: 'PENDING',
    });

    // 双方都已出队，另一方查询同样是 MATCHED（前端据此跳转 /battle/:id）
    expect(await stack.redis.get('ranked:queue:ash')).toBeNull();
    expect(await stack.redis.client.zcard('ranked:queue')).toBe(0);
    const statusA = await stack.ranked.status(userIdentity('ash'));
    expect(statusA).toMatchObject({ state: 'MATCHED', battleId });
  });

  it('入队时队伍重复（同一只占多槽）→ 400 DUPLICATE_TEAM，不写队列', async () => {
    const stack = await makeStack();
    const { pa } = await seedTeams(stack.chain, stack.contract);
    const err = await stack.ranked
      .enqueue(userIdentity('ash'), [pa.id, pa.id])
      .catch((e: HttpException) => e);
    expect(err.message).toMatch(/^DUPLICATE_TEAM:/);
    expect(err.getStatus()).toBe(400);
    expect(await stack.redis.client.zcard('ranked:queue')).toBe(0);
    expect((await stack.ranked.status(userIdentity('ash'))).state).toBe('IDLE');
  });

  it('分差超过 ±200 不配对（各自排队中）', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    await stack.contract.updateRating(SYSTEM_IDENTITY, 'gary', 1000 + MATCH_WINDOW + 1, 'test');
    const first = await stack.ranked.enqueue(userIdentity('ash'), [pa.id]);
    const second = await stack.ranked.enqueue(userIdentity('gary'), [pb.id]);
    expect(first.state).toBe('QUEUED');
    expect(second).toMatchObject({ state: 'QUEUED', rating: 1201, queueSize: 2 });
    expect(await stack.ranked.tryMatch()).toBeNull();
  });

  it('排队条目过期（TTL 到）→ 轮询返回 TIMEOUT 并清掉 ZSET 残留', async () => {
    const stack = await makeStack();
    const { pa } = await seedTeams(stack.chain, stack.contract);
    await stack.ranked.enqueue(userIdentity('ash'), [pa.id]);
    await stack.redis.del('ranked:queue:ash'); // 模拟 TTL 到期
    const status = await stack.ranked.status(userIdentity('ash'));
    expect(status.state).toBe('TIMEOUT');
    expect(status.message).toContain(String(QUEUE_TTL_SEC));
    expect(await stack.redis.client.zcard('ranked:queue')).toBe(0);
    expect((await stack.ranked.status(userIdentity('ash'))).state).toBe('IDLE');
  });

  it('取消排队回到 IDLE', async () => {
    const stack = await makeStack();
    const { pa } = await seedTeams(stack.chain, stack.contract);
    await stack.ranked.enqueue(userIdentity('ash'), [pa.id]);
    expect((await stack.ranked.status(userIdentity('ash'))).state).toBe('QUEUED');
    expect((await stack.ranked.cancel(userIdentity('ash'))).state).toBe('IDLE');
    expect((await stack.ranked.status(userIdentity('ash'))).state).toBe('IDLE');
  });

  it('队伍校验：非本人 / 锁定中 / 不存在 的宝可梦不能排队', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    await expect(stack.ranked.enqueue(userIdentity('ash'), [pb.id])).rejects.toThrow(/NOT_OWNER/);
    const locked = await seedPokemon(stack.chain, 'ash', { id: 'p_locked', status: 'LOCKED_BATTLE', lockRef: 'b_x' });
    await expect(stack.ranked.enqueue(userIdentity('ash'), [locked.id])).rejects.toThrow(/ASSET_LOCKED/);
    await expect(stack.ranked.enqueue(userIdentity('ash'), [pa.id, 'p_missing'])).rejects.toThrow(/NOT_OWNER/);
  });

  it('配对失败（排队后队伍被锁定）→ 双方出队并带 ERROR 提示', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    await stack.ranked.enqueue(userIdentity('ash'), [pa.id]);
    // ash 排队后把宝可梦押进一场交易：配对时校验失败，双方都要出队
    await stack.contract.createTrade(userIdentity('ash'), {
      id: 't_lock',
      fromId: 'ash',
      toId: 'gary',
      offer: { pokemonIds: [pa.id], itemIds: [], points: 0 },
      request: { pokemonIds: [], itemIds: [], points: 0 },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const status = await stack.ranked.enqueue(userIdentity('gary'), [pb.id]);
    expect(status.state).toBe('ERROR');
    expect(status.message).toContain('LOCKED_TRADE');
    expect(await stack.redis.client.zcard('ranked:queue')).toBe(0);
    expect((await stack.ranked.status(userIdentity('ash'))).state).toBe('ERROR');
  });
});

describe('排位结算挂钩（docs/backend-api.md §11）', () => {
  it('排位房 SETTLED → 双方 rating 按 ELO 更新、参战队伍加羁绊、写结算面板数据', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    const { second } = await matchRanked(stack, pa.id, pb.id);
    const battleId = second.battleId as string;

    const settled = await settleThroughConfirm(stack, battleId, 'ash');
    expect(settled.status).toBe('SETTLED');

    const applied = await waitFor(async () => {
      const outcome = await stack.ranked.outcome(battleId);
      return outcome.status === undefined && !!outcome.ratings?.length;
    });
    expect(applied).toBe(true);

    const outcome = await stack.ranked.outcome(battleId);
    expect(outcome.ranked).toBe(true);
    expect(outcome.winnerId).toBe('ash');
    expect(outcome.ratings).toEqual([
      { playerId: 'ash', before: 1000, after: 1016, delta: 16 },
      { playerId: 'gary', before: 1000, after: 984, delta: -16 },
    ]);
    // 链上 rating 真的变了（updateRating 由 system 代发）
    expect((await stack.contract.getPlayer('ash')).rating).toBe(1016);
    expect((await stack.contract.getPlayer('gary')).rating).toBe(984);
    // 羁绊：赢家队 +2、输家队 +1（长线化，docs/backend-api.md §11）
    expect(outcome.bonds).toEqual([
      expect.objectContaining({ pokemonId: pa.id, side: 'A', result: 'WIN', before: 50, after: 52, delta: 2 }),
      expect.objectContaining({ pokemonId: pb.id, side: 'B', result: 'LOSS', before: 50, after: 51, delta: 1 }),
    ]);
    expect((await stack.contract.getPokemon(pa.id)).bond).toBe(52);
    expect((await stack.contract.getPokemon(pb.id)).bond).toBe(51);
    // 排行榜 / 战绩跟上
    const board = await stack.ranked.leaderboard(userIdentity('ash'));
    // PG 里没有该用户行时昵称回退 playerId（真实环境昵称来自 users 表）
    expect(board.top[0]).toMatchObject({ rank: 1, playerId: 'ash', rating: 1016, nickname: 'ash' });
    expect(board.top[1]).toMatchObject({ rank: 2, playerId: 'gary', rating: 984 });
    expect(board.me).toMatchObject({ rank: 1, rating: 1016, wins: 1, losses: 0 });
    const me = await stack.ranked.me(userIdentity('gary'));
    expect(me).toMatchObject({ rating: 984, wins: 0, losses: 1, rank: 2, total: 2 });
  });

  it('普通排位胜利：胜者参战队伍每只 +30 exp，重放/扫尾不叠加（H3）', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    const { second } = await matchRanked(stack, pa.id, pb.id);
    const battleId = second.battleId as string;
    await settleThroughConfirm(stack, battleId, 'ash');
    const applied = await waitFor(async () => {
      const outcome = await stack.ranked.outcome(battleId);
      return outcome.status === undefined && !!outcome.ratings?.length;
    });
    expect(applied).toBe(true);
    expect((await stack.contract.getPokemon(pa.id)).exp).toBe(30);
    expect((await stack.contract.getPokemon(pb.id)).exp).toBe(0);

    // 广播重放 + sweep 兜底都不应重复加经验（链上 idemKey `<battleId>-exp-<pokemonId>`）
    await stack.rewards.settle(battleId);
    await stack.rewards.sweep();
    expect((await stack.contract.getPokemon(pa.id)).exp).toBe(30);
  });

  it('房间（非排位）PvP：胜者队伍 +30 exp，DRAW 不发（H3）', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    const wager = { pokemonIds: [], itemIds: [], points: 0 };
    const wagerHash = computeWagerHash('ash', 'gary', wager, wager);
    await stack.contract.createBattle(SYSTEM_IDENTITY, {
      id: 'b_room_win',
      playerA: 'ash',
      playerB: 'gary',
      wagerA: wager,
      wagerB: wager,
      wagerHash,
    });
    await stack.contract.activateBattle(SYSTEM_IDENTITY, 'b_room_win');
    await chainSettle(stack.contract, 'b_room_win', 'ash');
    await stack.rewards.onSettled({
      battleId: 'b_room_win',
      roomId: 'room-win',
      playerA: 'ash',
      playerB: 'gary',
      teamA: [pa.id],
      teamB: [pb.id],
    });
    expect((await stack.contract.getPokemon(pa.id)).exp).toBe(30);
    expect((await stack.contract.getPokemon(pb.id)).exp).toBe(0);

    const drawWagerHash = computeWagerHash('ash', 'gary', wager, wager);
    await stack.contract.createBattle(SYSTEM_IDENTITY, {
      id: 'b_room_draw',
      playerA: 'ash',
      playerB: 'gary',
      wagerA: wager,
      wagerB: wager,
      wagerHash: drawWagerHash,
    });
    await stack.contract.activateBattle(SYSTEM_IDENTITY, 'b_room_draw');
    await chainSettle(stack.contract, 'b_room_draw', 'DRAW');
    await stack.rewards.onSettled({
      battleId: 'b_room_draw',
      roomId: 'room-draw',
      playerA: 'ash',
      playerB: 'gary',
      teamA: [pa.id],
      teamB: [pb.id],
    });
    // 平局不发经验（第一场仍是 30）
    expect((await stack.contract.getPokemon(pa.id)).exp).toBe(30);
    expect((await stack.contract.getPokemon(pb.id)).exp).toBe(0);
  });

  it('结算挂钩幂等：重复广播/重放不会叠加 rating 与羁绊', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    const { second } = await matchRanked(stack, pa.id, pb.id);
    const battleId = second.battleId as string;
    const payload = {
      battleId,
      roomId: second.roomId ?? null,
      playerA: 'ash',
      playerB: 'gary',
      teamA: [pa.id],
      teamB: [pb.id],
    };

    await settleThroughConfirm(stack, battleId, 'ash');
    // 广播是 fire-and-forget（settle 有临界区锁）：等首次结算真正落盘后再做幂等重放，
    // 否则重放会撞在锁上直接返回，断言看到的是"还没结算"。
    await waitFor(async () => (await stack.ranked.outcome(battleId)).ratings?.length === 2);
    await Promise.all([stack.rewards.onSettled(payload), stack.rewards.onSettled(payload)]);
    await stack.rewards.settle(battleId);
    await stack.rewards.sweep();
    // 再走一轮完整广播（等价于 end 广播 + confirmResult 双通知 / 兜底扫尾重试）
    await stack.rewards.onSettled(payload);
    await stack.rewards.settle(battleId);
    await stack.rewards.sweep();

    expect((await stack.contract.getPlayer('ash')).rating).toBe(1016);
    expect((await stack.contract.getPlayer('gary')).rating).toBe(984);
    // 重放既不加分也不重复占用当日羁绊额度（+2 / +1 只算一次）
    expect((await stack.contract.getPokemon(pa.id)).bond).toBe(52);
    expect((await stack.contract.getPokemon(pb.id)).bond).toBe(51);
  });

  it('兜底结算（广播时链上还是 RESULT_SUBMITTED）：先登记待办，sweep 补应用', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    const { second } = await matchRanked(stack, pa.id, pb.id);
    const battleId = second.battleId as string;

    await stack.contract.submitBattleResult(SYSTEM_IDENTITY, battleId, 'gary', 'r'.repeat(64), 'sig');
    await stack.rewards.onSettled({
      battleId,
      roomId: second.roomId ?? null,
      playerA: 'ash',
      playerB: 'gary',
      teamA: [pa.id],
      teamB: [pb.id],
    });
    // 链上还没 SETTLED：只登记待办，不发奖
    expect((await stack.ranked.outcome(battleId)).status).toBe('PENDING');
    expect((await stack.contract.getPlayer('gary')).rating).toBe(1000);
    expect(await stack.redis.smembers('rewards:pending')).toContain(battleId);

    await stack.contract.settleBattle(SYSTEM_IDENTITY, battleId, { idemKey: `${battleId}-fallback` });
    await stack.rewards.sweep(); // 定时兜底扫尾（测试里直接触发一轮）
    const applied = await waitFor(async () => (await stack.ranked.outcome(battleId)).status === undefined);
    expect(applied).toBe(true);
    const outcome = await stack.ranked.outcome(battleId);
    expect(outcome.ratings).toEqual([
      { playerId: 'ash', before: 1000, after: 984, delta: -16 },
      { playerId: 'gary', before: 1000, after: 1016, delta: 16 },
    ]);
    expect(await stack.redis.smembers('rewards:pending')).not.toContain(battleId);
  });

  it('仲裁退款（REFUNDED）不发排位与羁绊奖励', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    const { second } = await matchRanked(stack, pa.id, pb.id);
    const battleId = second.battleId as string;
    await stack.contract.disputeBattle(userIdentity('ash'), battleId, 'ash', 'connection');
    await stack.contract.arbitrateBattle(
      { mspId: 'Org2MSP', role: 'arbitrator', userId: 'arbiter' },
      battleId,
      'REFUND',
      'service outage',
    );
    await stack.rewards.onSettled({
      battleId,
      roomId: second.roomId ?? null,
      playerA: 'ash',
      playerB: 'gary',
      teamA: [pa.id],
      teamB: [pb.id],
    });
    expect((await stack.contract.getPlayer('ash')).rating).toBe(1000);
    expect((await stack.contract.getPokemon(pa.id)).bond).toBe(50);
    expect(await stack.redis.smembers('rewards:pending')).not.toContain(battleId);
    expect((await stack.ranked.outcome(battleId)).status).toBe('NONE');
  });

  it('普通（非排位）对局：只加羁绊，不改 rating', async () => {
    const stack = await makeStack();
    await registerPlayers(stack.contract, 'ash', 'gary');
    const pa = await seedPokemon(stack.chain, 'ash', { id: 'p_norm_a' });
    const pb = await seedPokemon(stack.chain, 'gary', { id: 'p_norm_b' });
    const room = await stack.battles.createRoom(userIdentity('ash'), {
      mode: '1v1',
      wager: { pokemonIds: [], itemIds: [], points: 50 },
      teamPokemonIds: [pa.id],
    });
    await stack.battles.joinRoom(userIdentity('gary'), room.id, {
      wager: { pokemonIds: [], itemIds: [], points: 50 },
      teamPokemonIds: [pb.id],
    });
    await stack.battles.confirmWager(userIdentity('ash'), room.id);
    const active = await stack.battles.confirmWager(userIdentity('gary'), room.id);

    await settleThroughConfirm(stack, active.battleId as string, 'gary');
    const applied = await waitFor(async () => (await stack.ranked.outcome(active.battleId as string)).status === undefined);
    expect(applied).toBe(true);

    const outcome = await stack.ranked.outcome(active.battleId as string);
    expect(outcome.ranked).toBe(false);
    expect(outcome.ratings).toEqual([]);
    expect(outcome.bonds).toHaveLength(2);
    expect(outcome.bonds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pokemonId: pa.id, side: 'A', result: 'LOSS', before: 50, after: 51 }),
        expect.objectContaining({ pokemonId: pb.id, side: 'B', result: 'WIN', before: 50, after: 52 }),
      ]),
    );
    expect((await stack.contract.getPlayer('ash')).rating).toBe(1000);
    expect((await stack.contract.getPlayer('gary')).rating).toBe(1000);
  });

  it('平局：双方 +1 羁绊，rating 按 0.5 期望各结算', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    const { second } = await matchRanked(stack, pa.id, pb.id);
    const battleId = second.battleId as string;
    await chainSettle(stack.contract, battleId, 'DRAW');
    await stack.rewards.onSettled({
      battleId,
      roomId: second.roomId ?? null,
      playerA: 'ash',
      playerB: 'gary',
      teamA: [pa.id],
      teamB: [pb.id],
    });
    const outcome = await stack.ranked.outcome(battleId);
    expect(outcome.ratings).toEqual([
      { playerId: 'ash', before: 1000, after: 1000, delta: 0 },
      { playerId: 'gary', before: 1000, after: 1000, delta: 0 },
    ]);
    expect(outcome.bonds).toEqual([
      expect.objectContaining({ pokemonId: pa.id, result: 'DRAW', after: 51 }),
      expect.objectContaining({ pokemonId: pb.id, result: 'DRAW', after: 51 }),
    ]);
  });
});

describe('羁绊挂钩（docs/backend-api.md §11）', () => {
  it('BondUp 幂等：同一场战斗重复发放不会叠加', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    const input = { battleId: 'b_bond', playerA: 'ash', playerB: 'gary', teamA: [pa.id], teamB: [pb.id], winnerId: 'ash' };
    const first = await stack.bonds.grantPvpBond(input);
    expect(first.map((c) => c.delta)).toEqual([2, 1]);
    const second = await stack.bonds.grantPvpBond(input);
    expect(second.every((c) => c.after === c.before)).toBe(true);
    expect((await stack.contract.getPokemon(pa.id)).bond).toBe(52);
    expect((await stack.contract.getPokemon(pb.id)).bond).toBe(51);
    // 重放不会重复占用当日额度：额度只记一条（field = 该次 BondUp 的 idemKey）
    expect(await stack.redis.client.hlen('bond:day:' + pa.id + ':' + utcDate())).toBe(1);
  });

  it('每日每宠上限 +6：当日额度用满后不再涨（PvP 与野怪共用同一额度）', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    const grant = (battleId: string) =>
      stack.bonds.grantPvpBond({ battleId, playerA: 'ash', playerB: 'gary', teamA: [pa.id], teamB: [pb.id], winnerId: 'ash' });

    // 3 胜 = 6 点（正好用满当日额度）
    await grant('b_cap_1');
    await grant('b_cap_2');
    await grant('b_cap_3');
    expect((await stack.contract.getPokemon(pa.id)).bond).toBe(56);
    expect(await stack.redis.client.hlen('bond:day:' + pa.id + ':' + utcDate())).toBe(3);

    // 第 4 胜：赢家队额度已满 → 该侧截断为 0（链上不动、不新增额度记录）；输家队仍有额度 → +1
    const capped = await grant('b_cap_4');
    expect(capped.filter((c) => c.pokemonId === pa.id)).toEqual([]);
    expect((await stack.contract.getPokemon(pa.id)).bond).toBe(56);
    expect(await stack.redis.client.hlen('bond:day:' + pa.id + ':' + utcDate())).toBe(3);

    // 输家队（+1）当天额度独立：4 场共 +4
    expect((await stack.contract.getPokemon(pb.id)).bond).toBe(54);
  });

  it('当日额度剩余不足时截断：已用 5 点 → 本场只 +1（不是 +2）', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    const key = 'bond:day:' + pa.id + ':' + utcDate();
    await stack.redis.client.hset(key, 'seed-grant', '5');

    const changes = await stack.bonds.grantPvpBond({
      battleId: 'b_partial',
      playerA: 'ash',
      playerB: 'gary',
      teamA: [pa.id],
      teamB: [pb.id],
      winnerId: 'ash',
    });
    expect(changes.find((c) => c.pokemonId === pa.id)).toMatchObject({ before: 50, after: 51, delta: 1 });
    expect((await stack.contract.getPokemon(pa.id)).bond).toBe(51);
    // 记账写的是"实际发放值"（1）而不是期望值（2）：当日合计 6 点
    const recorded = await stack.redis.client.hgetall(key);
    expect(Object.values(recorded).map(Number).reduce((a, b) => a + b, 0)).toBe(6);
    // 输家队额度独立，照常 +1
    expect((await stack.contract.getPokemon(pb.id)).bond).toBe(51);
  });

  it('255 截断：接近上限的宝可梦只加到 255', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    for (let i = 0; i < 5; i += 1) {
      await stack.contract.bondUp(SYSTEM_IDENTITY, [pa.id], 50, 'train', { idemKey: `bond-fill-${i}` });
    }
    expect((await stack.contract.getPokemon(pa.id)).bond).toBe(255);
    // 已满：BondUp 截断到 0（链上不报错，delta 为 0）
    const changes = await stack.bonds.grantPvpBond({
      battleId: 'b_cap',
      playerA: 'ash',
      playerB: 'gary',
      teamA: [pa.id],
      teamB: [pb.id],
      winnerId: 'ash',
    });
    expect(changes.find((c) => c.pokemonId === pa.id)).toMatchObject({ pokemonId: pa.id, delta: 0 });
    expect((await stack.contract.getPokemon(pa.id)).bond).toBe(255);
  });

  it('押注易主的宝可梦不再加"输家羁绊"（链上易主已重置为 30）', async () => {
    const stack = await makeStack();
    await registerPlayers(stack.contract, 'ash', 'gary');
    const wagered = await seedPokemon(stack.chain, 'ash', { id: 'p_wagered', bond: 50 });
    const kept = await seedPokemon(stack.chain, 'gary', { id: 'p_kept', bond: 50 });
    await stack.contract.transferPokemon(userIdentity('ash'), wagered.id, 'gary');
    const changes = await stack.bonds.grantPvpBond({
      battleId: 'b_handover',
      playerA: 'ash',
      playerB: 'gary',
      teamA: [wagered.id],
      teamB: [kept.id],
      winnerId: 'gary',
    });
    expect(changes.map((c) => c.pokemonId)).toEqual([kept.id]);
    expect((await stack.contract.getPokemon(wagered.id)).bond).toBe(30);
    expect((await stack.contract.getPokemon(kept.id)).bond).toBe(52);
  });

  it('未结算 / 不存在的对局没有结算面板数据（NONE）', async () => {
    const stack = await makeStack();
    expect((await stack.ranked.outcome('b_missing')).status).toBe('NONE');
  });
});

describe('排位排行榜（docs/backend-api.md §11）', () => {
  it('ZSET 为空时用 PG 用户表冷启动，链上 rating 为准', async () => {
    const stack = await makeStack();
    await registerPlayers(stack.contract, 'ash', 'gary');
    await stack.contract.updateRating(SYSTEM_IDENTITY, 'gary', 1500, 'seed');
    await stack.userRepo.save({ username: 'ash', nickname: '小智' } as never);
    await stack.userRepo.save({ username: 'gary', nickname: '小茂' } as never);

    const board = await stack.ranked.leaderboard(userIdentity('ash'));
    expect(board.top).toEqual([
      expect.objectContaining({ rank: 1, playerId: 'gary', rating: 1500, nickname: '小茂' }),
      expect.objectContaining({ rank: 2, playerId: 'ash', rating: 1000, nickname: '小智' }),
    ]);
    expect(board.me).toMatchObject({ rank: 2, playerId: 'ash', rating: 1000 });
  });

  it('链上 rating 与缓存不一致时以链上为准对账刷新', async () => {
    const stack = await makeStack();
    const { pa } = await seedTeams(stack.chain, stack.contract);
    await stack.redis.zadd('ranked:lb', 9999, 'ash'); // 脏缓存
    await stack.ranked.enqueue(userIdentity('ash'), [pa.id]);
    await stack.ranked.cancel(userIdentity('ash'));
    const board = await stack.ranked.leaderboard(userIdentity('ash'), true);
    expect(board.top.find((e) => e.playerId === 'ash')?.rating).toBe(1000);
    expect(await stack.redis.client.zscore('ranked:lb', 'ash')).toBe('1000');
  });
});
