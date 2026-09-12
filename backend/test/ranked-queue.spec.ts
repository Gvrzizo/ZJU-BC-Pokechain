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
import { BondService } from '../src/ranked/bond.service';
import { RankedService } from '../src/ranked/ranked.service';
import { MATCH_WINDOW_BASE, MATCH_WINDOW_MAX, matchWindowFor } from '../src/ranked/elo';
import {
  ARENA_ENTRY_FEES,
  arenaEntryFee,
  arenaSubsidyDecision,
  subsidyDailyKey,
} from '../src/ranked/arena';
import { BOT_DAILY_LIMIT, BOT_PLAYER_ID, BOT_TEAM_SIZE, botDailyKey, pickBotAction, utcDate } from '../src/ranked/bot';
import { MoveDef, getMove } from '../src/game-data/moves.data';
import { computeStats, normalizeEvs } from '../src/game-data/stats';
import { getSpecies } from '../src/game-data/species.data';
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
import type { ChainEventPayload } from '../src/fabric/chain.types';

const BATTLE_CONFIG = {
  battle: {
    turnTimeoutMs: 30_000,
    disconnectTimeoutMs: 60_000,
    entryGraceMs: 90_000,
    settleFallbackMs: 300_000,
  },
};

const QUEUE_TTL_SEC = 300;
const stacks: BattleRewardService[] = [];

/** 全栈：内存链/Redis + battles 房间流程 + ranked/bot/bond/结算挂钩（不起 HTTP/WS）。 */
async function makeStack() {
  const { chain, contract } = makeChain();
  const redis = makeRedis();
  await redis.client.flushall();
  const config = makeConfig(BATTLE_CONFIG);
  const signing = new SigningService(makeConfig({ serverSigningKey: '' }));
  const manager = new BattleManagerService(contract, redis, signing, config, mockRepo<BattleLog>() as never);
  const users = {
    findByUsername: async (username: string) => ({ username, nickname: `nick-${username}`, role: 'player' }),
  };
  const battles = new BattlesService(
    contract,
    redis,
    manager,
    users as never,
    makeBlocks(config),
    makeHpService(redis),
    mockRepo<AuditLog>() as never,
    mockRepo<DisputeRecord>() as never,
    config,
  );
  battles.onModuleInit();
  const userRepo = mockRepo<User>();
  const launcher = new RankedBattleLauncher(contract, manager, makeHpService(redis));
  const ranked = new RankedService(contract, redis, battles, users as never, launcher, makeHpService(redis), userRepo as never);
  const bonds = new BondService(contract, redis);
  const pokemon = makePokemonService(contract, redis);
  const rewards = new BattleRewardService(battles, contract, redis, ranked, bonds, pokemon, config);
  rewards.onModuleInit();
  const bots = new RankedBotService(contract, redis, manager, launcher, ranked, rewards);
  bots.onModuleInit();
  stacks.push(rewards);
  return { chain, contract, redis, manager, battles, ranked, bots, bonds, rewards, userRepo };
}

afterEach(() => {
  for (const rewards of stacks.splice(0)) rewards.onModuleDestroy();
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

async function seedTeams(chain: ReturnType<typeof makeChain>['chain'], contract: ReturnType<typeof makeChain>['contract']) {
  await registerPlayers(contract, 'ash', 'gary');
  const pa = await seedPokemon(chain, 'ash', { id: 'p_rank_a', bond: 50, level: 20 });
  const pb = await seedPokemon(chain, 'gary', { id: 'p_rank_b', bond: 50, level: 20 });
  return { pa, pb };
}

/** 把排队条目的入队时间往前拨 ms（模拟"已等待很久"） */
async function rewindEntry(stack: ReturnType<typeof makeStack>, playerId: string, ms: number) {
  const key = `ranked:queue:${playerId}`;
  const entry = await stack.redis.getJson<Record<string, unknown>>(key);
  if (!entry) throw new Error(`no queue entry for ${playerId}`);
  await stack.redis.setJson(key, { ...entry, joinedAt: Date.now() - ms }, QUEUE_TTL_SEC);
}

/** 把待确认对局的接受期改到过去（模拟 15s 超时） */
async function expirePendingOf(stack: ReturnType<typeof makeStack>, playerId: string) {
  const matchId = await stack.redis.get(`ranked:pending:of:${playerId}`);
  if (!matchId) throw new Error(`no pending match for ${playerId}`);
  const key = `ranked:pending:${matchId}`;
  const pending = await stack.redis.getJson<Record<string, unknown>>(key);
  await stack.redis.setJson(key, { ...pending, deadline: Date.now() - 1 }, 60);
}

/** 双方入队（可选模式）→ 返回排队状态 */
async function enqueuePair(stack: ReturnType<typeof makeStack>, pA: string, pB: string, mode: 'casual' | 'arena' = 'casual') {
  const first = await stack.ranked.enqueue(userIdentity('ash'), [pA], mode);
  const second = await stack.ranked.enqueue(userIdentity('gary'), [pB], mode);
  return { first, second };
}

function playerIdOf(event: ChainEventPayload): string | undefined {
  return typeof event.playerId === 'string' ? event.playerId : undefined;
}

describe('匹配窗口扩圈（docs/backend-api.md §11）', () => {
  it('±200 起，每 10 秒 +50，上限 ±1000；窗口重置期间回到 ±200', () => {
    expect(matchWindowFor(0)).toBe(MATCH_WINDOW_BASE);
    expect(matchWindowFor(9_999)).toBe(200);
    expect(matchWindowFor(10_000)).toBe(250);
    expect(matchWindowFor(25_000)).toBe(300);
    expect(matchWindowFor(60_000)).toBe(500);
    expect(matchWindowFor(160_000)).toBe(MATCH_WINDOW_MAX);
    expect(matchWindowFor(999_999)).toBe(MATCH_WINDOW_MAX);
    expect(matchWindowFor(160_000, { resetForMs: 1 })).toBe(MATCH_WINDOW_BASE);
  });

  it('分差 400 的双方：刚入队配不上，等待 40 秒后窗口扩到 ±400 才配对', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    await stack.contract.updateRating(SYSTEM_IDENTITY, 'gary', 1400, 'test');
    await enqueuePair(stack, pa.id, pb.id);
    expect(await stack.ranked.tryMatch()).toBeNull();

    await rewindEntry(stack, 'ash', 40_000);
    await rewindEntry(stack, 'gary', 40_000);
    expect(await stack.ranked.tryMatch()).not.toBeNull();
    const status = await stack.ranked.status(userIdentity('ash'));
    expect(status.state).toBe('MATCH_PENDING');
    expect(status.window).toBe(400);
    expect(status.waitedSec).toBeGreaterThanOrEqual(40);
  });

  it('status 返回当前窗口与已等待秒数（轮询即匹配）', async () => {
    const stack = await makeStack();
    const { pa } = await seedTeams(stack.chain, stack.contract);
    const first = await stack.ranked.enqueue(userIdentity('ash'), [pa.id]);
    expect(first.state).toBe('QUEUED');
    expect(first.window).toBe(200);
    expect(first.waitedSec).toBe(0);

    await rewindEntry(stack, 'ash', 30_000);
    const status = await stack.ranked.status(userIdentity('ash'));
    expect(status).toMatchObject({ state: 'QUEUED', window: 350, waitedSec: 30, queueSize: 1 });
  });
});

describe('入队校验：濒死（0 HP）不能排队（伤势持久化，docs/backend-api.md §2）', () => {
  it('带濒死宝可梦入队 → 409 FAINTED（指明是哪只），且不会进队列', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    const hp = makeHpService(stack.redis);
    await hp.set(pa.id, 0, hp.maxHpOf(pa));

    const err = await stack.ranked
      .enqueue(userIdentity('ash'), [pa.id])
      .catch((e: HttpException) => e);
    expect(err.message).toMatch(/^FAINTED:/);
    expect(err.getStatus()).toBe(409);
    expect(err.message).toContain(pa.id); // 指明是哪只
    expect(await stack.redis.get('ranked:queue:ash')).toBeNull();
    expect(await stack.redis.client.zscore('ranked:queue', 'ash')).toBeNull();

    // 没有队列条目 → 机器人入口自然不可用（不会绕过入队校验）
    await expect(stack.bots.acceptBot(userIdentity('ash'))).rejects.toThrow(/NOT_QUEUED/);

    // 治疗后可以正常入队（HP 交回，写回详情）
    await hp.set(pa.id, hp.maxHpOf(pa), hp.maxHpOf(pa));
    const queued = await stack.ranked.enqueue(userIdentity('ash'), [pa.id]);
    expect(queued.state).toBe('QUEUED');
    // 另一位玩家正常入队 → 双方配对（说明前面的失败没有留下脏状态）
    expect((await stack.ranked.enqueue(userIdentity('gary'), [pb.id])).state).toBe('MATCH_PENDING');
  });

  it('arena 入队同样拦下濒死队伍（未扣准入积分、无队列条目）', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    const hp = makeHpService(stack.redis);
    await hp.set(pa.id, 0, hp.maxHpOf(pa));
    await hp.set(pb.id, 0, hp.maxHpOf(pb));

    const errA = await stack.ranked
      .enqueue(userIdentity('ash'), [pa.id], 'arena')
      .catch((e: HttpException) => e);
    const errB = await stack.ranked
      .enqueue(userIdentity('gary'), [pb.id], 'arena')
      .catch((e: HttpException) => e);
    expect(errA.message).toMatch(/^FAINTED:/);
    expect(errB.message).toMatch(/^FAINTED:/);
    expect(await stack.redis.get('ranked:queue:gary')).toBeNull();
    expect((await stack.contract.getPlayer('gary')).points).toBe(1000); // 准入只在匹配成功时扣
  });
});

describe('匹配接受期（MATCH_PENDING）', () => {
  it('匹配到后进入 MATCH_PENDING：双方各 15 秒接受期，未接受前不建房', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    const { second } = await enqueuePair(stack, pa.id, pb.id);
    expect(second.state).toBe('MATCH_PENDING');
    expect(second.opponent).toMatchObject({ playerId: 'ash', nickname: 'nick-ash', rating: 1000 });
    expect(second.accepted).toBe(false);
    expect(second.acceptDeadline).toBeGreaterThan(Date.now());
    expect(second.entryFee).toBe(0);
    // 已从队列摘出，等待接受
    expect(await stack.redis.client.zcard('ranked:queue')).toBe(0);
    expect(await stack.redis.get('ranked:pending:of:ash')).not.toBeNull();

    // 只有一方接受：仍是 MATCH_PENDING，没有 battle
    const accepted = await stack.ranked.accept(userIdentity('ash'));
    expect(accepted).toMatchObject({ state: 'MATCH_PENDING', accepted: true });
    expect(await stack.redis.get('ranked:match:ash')).toBeNull();
  });

  it('双方接受才建房：第二个 accept 返回 MATCHED 与 battleId', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    await enqueuePair(stack, pa.id, pb.id);
    await stack.ranked.accept(userIdentity('ash'));
    const matched = await stack.ranked.accept(userIdentity('gary'));
    expect(matched.state).toBe('MATCHED');
    expect(matched.opponent?.playerId).toBe('ash');
    const battleId = matched.battleId as string;
    expect(battleId).toMatch(/^b_/);
    const room = await stack.battles.getRoom(matched.roomId as string);
    expect(room).toMatchObject({ status: 'ACTIVE', battleId });
    const record = await stack.ranked.battleRecord(battleId);
    expect(record).toMatchObject({ playerA: 'ash', playerB: 'gary', teamA: [pa.id], teamB: [pb.id], state: 'PENDING' });
    // 双方凭据都写好，待确认记录已清
    expect((await stack.ranked.status(userIdentity('ash'))).state).toBe('MATCHED');
    expect(await stack.redis.get('ranked:pending:of:ash')).toBeNull();
  });

  it('一方拒绝 → 双方回队列，拒绝方 30 秒内窗口重置为 ±200 且不再与该对手配对', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    await enqueuePair(stack, pa.id, pb.id);
    await rewindEntry(stack, 'ash', 60_000); // 双方都排队 60s（窗口 ±500）
    await rewindEntry(stack, 'gary', 60_000);

    const declined = await stack.ranked.decline(userIdentity('ash'));
    expect(declined.state).toBe('QUEUED');
    expect(declined.message).toContain('拒绝');
    expect(await stack.redis.client.zcard('ranked:queue')).toBe(2);
    expect(await stack.redis.get('ranked:pending:of:gary')).toBeNull();

    const ash = await stack.ranked.status(userIdentity('ash'));
    const gary = await stack.ranked.status(userIdentity('gary'));
    expect(ash.window).toBe(200); // 拒绝方窗口重置
    expect(gary.window).toBe(500); // 对方保留已扩的窗口
    expect(gary.message).toContain('对手拒绝');
    // 30s 避让：同分也不会立刻又配上
    expect(await stack.ranked.tryMatch()).toBeNull();
    expect((await stack.ranked.status(userIdentity('gary'))).state).toBe('QUEUED');
    expect(await stack.redis.getJson<{ avoid?: string }>('ranked:queue:ash')).toMatchObject({ avoid: 'gary' });
  });

  it('15 秒超时未接受 → 双方回队列，未接受方窗口重置', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    await enqueuePair(stack, pa.id, pb.id);
    await rewindEntry(stack, 'ash', 60_000);
    await rewindEntry(stack, 'gary', 60_000);
    await stack.ranked.accept(userIdentity('ash'));
    await expirePendingOf(stack, 'gary');

    const gary = await stack.ranked.status(userIdentity('gary'));
    expect(gary.state).toBe('QUEUED');
    expect(gary.message).toContain('15 秒');
    expect(gary.window).toBe(200);
    const ash = await stack.ranked.status(userIdentity('ash'));
    expect(ash.state).toBe('QUEUED');
    expect(ash.message).toContain('对手');
    expect(ash.window).toBe(500);
    expect(await stack.redis.client.zcard('ranked:queue')).toBe(2);
  });

  it('待确认期内取消排队 = 放弃该对局：对方回队列，自己 IDLE', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    await enqueuePair(stack, pa.id, pb.id);
    expect((await stack.ranked.cancel(userIdentity('ash'))).state).toBe('IDLE');
    expect((await stack.ranked.status(userIdentity('ash'))).state).toBe('IDLE');
    expect((await stack.ranked.status(userIdentity('gary'))).state).toBe('QUEUED');
    expect(await stack.redis.client.zcard('ranked:queue')).toBe(1);
  });
});

describe('排位队伍规模 1-6 与接受期对手阵容（docs/backend-api.md §11.1）', () => {
  it('入队 7 只 → 400 INVALID_TEAM_SIZE，且不会进队列', async () => {
    const stack = await makeStack();
    const { pa } = await seedTeams(stack.chain, stack.contract);
    const err = await stack.ranked
      .enqueue(userIdentity('ash'), [pa.id, 'p_x2', 'p_x3', 'p_x4', 'p_x5', 'p_x6', 'p_x7'])
      .catch((e: HttpException) => e);
    expect(err.message).toMatch(/^INVALID_TEAM_SIZE:/);
    expect(err.getStatus()).toBe(400);
    expect(await stack.redis.get('ranked:queue:ash')).toBeNull();
    expect(await stack.redis.client.zscore('ranked:queue', 'ash')).toBeNull();
  });

  it('MATCH_PENDING 返回对手出战队伍富化：id/昵称/种族/等级/闪光/最终能力值，裁剪 IV/EV/性格/羁绊', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    const pika2 = await seedPokemon(stack.chain, 'ash', { id: 'p_rank_a2', speciesId: 4, level: 12, bond: 50 });
    await stack.ranked.enqueue(userIdentity('ash'), [pa.id, pika2.id]);
    const gary = await stack.ranked.enqueue(userIdentity('gary'), [pb.id]);
    expect(gary.state).toBe('MATCH_PENDING');
    expect(gary.opponent?.team).toHaveLength(2);

    const species = getSpecies(25)!;
    expect(gary.opponent?.team?.[0]).toEqual({
      id: pa.id,
      name: 'pikachu',
      speciesId: 25,
      nameZh: '皮卡丘',
      level: 20,
      shiny: false,
      stats: computeStats(species.base, pa.ivs, normalizeEvs(pa.evs), pa.level, pa.nature),
    });
    // 对手视角看不到私有养成数据
    const raw = JSON.stringify(gary.opponent);
    expect(raw).not.toMatch(/ivs|evs|nature|bond/);

    // 对称：房主侧也能看到对手（gary）的队伍
    const ash = await stack.ranked.status(userIdentity('ash'));
    expect(ash.state).toBe('MATCH_PENDING');
    expect(ash.opponent?.team?.map((m) => m.id)).toEqual([pb.id]);
    expect(ash.opponent?.team?.[0]).toMatchObject({ nameZh: '皮卡丘', level: 20 });

    // 接受期结束后（双方 accept → MATCHED）不再需要队伍预览，返回的仍是 MATCHED 状态
    await stack.ranked.accept(userIdentity('ash'));
    const matched = await stack.ranked.accept(userIdentity('gary'));
    expect(matched.state).toBe('MATCHED');
  });

  it('旧待确认记录（无队伍快照）回退读排队条目里的队伍', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    await enqueuePair(stack, pa.id, pb.id);
    const matchId = await stack.redis.get('ranked:pending:of:ash');
    const key = `ranked:pending:${matchId}`;
    const pending = await stack.redis.getJson<Record<string, unknown>>(key);
    delete pending.teamA;
    delete pending.teamB; // 模拟升级前写入的记录
    await stack.redis.setJson(key, pending, 60);

    const gary = await stack.ranked.status(userIdentity('gary'));
    expect(gary.opponent?.team?.map((m) => m.id)).toEqual([pa.id]);
  });
});

describe('机器人对手（docs/backend-api.md §11）', () => {
  it('排队不足 60 秒不提供机器人（botOffer 不出现在 status 里）', async () => {
    const stack = await makeStack();
    const { pa } = await seedTeams(stack.chain, stack.contract);
    const status = await stack.ranked.enqueue(userIdentity('ash'), [pa.id]);
    expect(status.botOffer).toBeUndefined();
    await expect(stack.bots.acceptBot(userIdentity('ash'))).rejects.toThrow(/BOT_NOT_OFFERED/);
  });

  it('排队 60 秒后 botOffer=true，接受后建出对机器人的战斗（BOT 玩家 + 3 只 ±2 级队伍）', async () => {
    const stack = await makeStack();
    const { pa } = await seedTeams(stack.chain, stack.contract);
    await stack.ranked.enqueue(userIdentity('ash'), [pa.id]);
    await rewindEntry(stack, 'ash', 60_000);

    const status = await stack.ranked.status(userIdentity('ash'));
    expect(status).toMatchObject({ state: 'QUEUED', botOffer: true, botRemainingToday: BOT_DAILY_LIMIT });

    const matched = await stack.bots.acceptBot(userIdentity('ash'));
    expect(matched.state).toBe('MATCHED');
    expect(matched.bot).toBe(true);
    expect(matched.roomId).toBeNull();
    expect(matched.opponent).toMatchObject({ playerId: BOT_PLAYER_ID, nickname: '训练家机器人', rating: 1000 });

    const battleId = matched.battleId as string;
    const battle = await stack.contract.getBattle(battleId);
    expect(battle).toMatchObject({ playerA: 'ash', playerB: BOT_PLAYER_ID, status: 'ACTIVE' });
    expect(battle.wagerA).toEqual({ pokemonIds: [], items: [], points: 0 });
    expect((await stack.contract.getPlayer(BOT_PLAYER_ID)).rating).toBe(1000);
    // 机器人队：3 只，等级在玩家队伍平均等级 ±2 内，且只在内存里（链上查不到）
    const record = await stack.ranked.battleRecord(battleId);
    expect(record?.bot?.mons).toHaveLength(BOT_TEAM_SIZE);
    for (const mon of record?.bot?.mons ?? []) {
      expect(Math.abs(mon.level - 20)).toBeLessThanOrEqual(2);
    }
    await expect(stack.contract.getPokemon(`bot_${battleId}_1`)).rejects.toThrow();
    expect(record?.teamA).toEqual([pa.id]);
    expect(await stack.redis.get('ranked:queue:ash')).toBeNull();
    // 已到场：机器人在引擎里算"已入场"（否则 90s 宽限结束会判机器人弃权）
    expect(stack.manager.get(battleId)).toBeDefined();
  });

  it('机器人场奖励减半：ELO ±8、羁绊 +1（胜）、经验 +15', async () => {
    const stack = await makeStack();
    const { pa } = await seedTeams(stack.chain, stack.contract);
    await stack.ranked.enqueue(userIdentity('ash'), [pa.id]);
    await rewindEntry(stack, 'ash', 60_000);
    const matched = await stack.bots.acceptBot(userIdentity('ash'));
    const battleId = matched.battleId as string;

    // 机器人弃权 = 玩家获胜（不用跑满整场；引擎路径与 PvP 相同）
    await stack.manager.forfeit(battleId, BOT_PLAYER_ID);
    const applied = await waitFor(async () => (await stack.ranked.outcome(battleId)).status === undefined);
    expect(applied).toBe(true);

    const outcome = await stack.ranked.outcome(battleId);
    expect(outcome.bot).toBe(true);
    expect(outcome.ranked).toBe(true);
    expect((await stack.contract.getPlayer('ash')).rating).toBe(1008); // 16 × 0.5
    expect((await stack.contract.getPlayer(BOT_PLAYER_ID)).rating).toBe(992);
    expect(outcome.ratings).toEqual([
      { playerId: 'ash', before: 1000, after: 1008, delta: 8 },
      { playerId: BOT_PLAYER_ID, before: 1000, after: 992, delta: -8 },
    ]);
    // 羁绊 +2 → +1（2 × 0.5 向下取整）
    expect(outcome.bonds).toEqual([
      expect.objectContaining({ pokemonId: pa.id, result: 'WIN', before: 50, after: 51, delta: 1 }),
    ]);
    expect((await stack.contract.getPokemon(pa.id)).bond).toBe(51);
    // 经验 30 → 15
    expect((await stack.contract.getPokemon(pa.id)).exp).toBe(15);
    // 机器人不在排行榜上
    const board = await stack.ranked.leaderboard(userIdentity('ash'), true);
    expect(board.top.map((e) => e.playerId)).not.toContain(BOT_PLAYER_ID);
  });

  it('减半奖励幂等：重复结算不会叠加 rating / 羁绊 / 经验', async () => {
    const stack = await makeStack();
    const { pa } = await seedTeams(stack.chain, stack.contract);
    await stack.ranked.enqueue(userIdentity('ash'), [pa.id]);
    await rewindEntry(stack, 'ash', 60_000);
    const matched = await stack.bots.acceptBot(userIdentity('ash'));
    const battleId = matched.battleId as string;
    await stack.manager.forfeit(battleId, BOT_PLAYER_ID);
    await waitFor(async () => (await stack.ranked.outcome(battleId)).status === undefined);

    await stack.rewards.settle(battleId);
    await stack.rewards.sweep();
    expect((await stack.contract.getPlayer('ash')).rating).toBe(1008);
    expect((await stack.contract.getPokemon(pa.id)).bond).toBe(51);
    expect((await stack.contract.getPokemon(pa.id)).exp).toBe(15);
  });

  it('每日 5 场上限：超了拒绝，且失败不扣次数', async () => {
    const stack = await makeStack();
    const { pa } = await seedTeams(stack.chain, stack.contract);
    await stack.redis.set(botDailyKey('ash', utcDate()), String(BOT_DAILY_LIMIT), 3600);
    await stack.ranked.enqueue(userIdentity('ash'), [pa.id]);
    await rewindEntry(stack, 'ash', 60_000);
    const status = await stack.ranked.status(userIdentity('ash'));
    expect(status.botOffer).toBe(true);
    expect(status.botRemainingToday).toBe(0);
    await expect(stack.bots.acceptBot(userIdentity('ash'))).rejects.toThrow(/BOT_DAILY_LIMIT/);
    expect(await stack.redis.get(botDailyKey('ash', utcDate()))).toBe(String(BOT_DAILY_LIMIT));
    // 仍在队列里，可以等真人
    expect((await stack.ranked.status(userIdentity('ash'))).state).toBe('QUEUED');
  });

  it('arena 模式不提供机器人（botOffer 不出现，accept-bot 拒绝）', async () => {
    const stack = await makeStack();
    const { pa } = await seedTeams(stack.chain, stack.contract);
    await stack.ranked.enqueue(userIdentity('ash'), [pa.id], 'arena');
    await rewindEntry(stack, 'ash', 60_000);
    const status = await stack.ranked.status(userIdentity('ash'));
    expect(status.botOffer).toBeUndefined();
    await expect(stack.bots.acceptBot(userIdentity('ash'))).rejects.toThrow(/ARENA_BOT_UNAVAILABLE/);
    expect(await stack.redis.get(botDailyKey('ash', utcDate()))).toBeNull();
  });

  it('机器人出招：伤害招优先，倒地时换宠', () => {
    // 技能表里没有 0 威力招，这里造一个"变化招"验证优先级
    const statusMove: MoveDef = { ...getMove('tackle')!, id: 'fake-status', power: 0 };
    const moves = [statusMove, getMove('thunder-shock')!, getMove('body-slam')!];
    for (let i = 0; i < 20; i += 1) {
      const action = pickBotAction({
        moves,
        team: [{ hp: 30 }, { hp: 30 }],
        activeIndex: 0,
        mustSwitch: false,
        roll: i / 20,
      });
      expect(action).toEqual({ type: 'move', moveIndex: expect.any(Number) });
      if (action.type === 'move') {
        expect(action.moveIndex).not.toBe(0);
        expect(moves[action.moveIndex].power).toBeGreaterThan(0);
      }
    }
    const switchAction = pickBotAction({
      moves,
      team: [{ hp: 0 }, { hp: 30 }, { hp: 10 }],
      activeIndex: 0,
      mustSwitch: true,
      roll: 0,
    });
    expect(switchAction).toEqual({ type: 'switch', toIndex: 1 });
    // 全部倒地（理论上不会发生）时退回出招，不抛错
    const noSwitch = pickBotAction({
      moves,
      team: [{ hp: 0 }],
      activeIndex: 0,
      mustSwitch: true,
      roll: 0.5,
    });
    expect(noSwitch.type).toBe('move');
  });
});

describe('积分场（arena，docs/backend-api.md §10/§11）', () => {
  /** 记下链上积分变动（reason 可审计），用于断言扣费口径（忽略 escrow 0 的占位事件） */
  function trackPoints(chain: ReturnType<typeof makeChain>['chain']) {
    const changes: Array<{ playerId: string; delta: number; reason: string }> = [];
    chain.onChainEvent((name: string, payload: ChainEventPayload) => {
      if (name !== 'PointsChanged') return;
      const playerId = playerIdOf(payload);
      if (!playerId || Number(payload.delta) === 0) return;
      changes.push({ playerId, delta: Number(payload.delta), reason: String(payload.reason) });
    });
    return changes;
  }

  /** 提交结果 + 双方确认（第二次确认链上 SETTLED，BattlesService 广播 settled → 奖励挂钩） */
  async function settleArena(stack: ReturnType<typeof makeStack>, battleId: string, winnerId: string) {
    await stack.contract.submitBattleResult(SYSTEM_IDENTITY, battleId, winnerId, 'r'.repeat(64), 'sig');
    await stack.battles.confirmResult(userIdentity('ash'), battleId);
    await stack.battles.confirmResult(userIdentity('gary'), battleId);
    const applied = await waitFor(async () => (await stack.ranked.outcome(battleId)).status === undefined);
    expect(applied).toBe(true);
    return stack.ranked.outcome(battleId);
  }

  /** 双方入场（arena）+ 双方接受 → 建房 */
  async function startArena(stack: ReturnType<typeof makeStack>, pa: string, pb: string) {
    await enqueuePair(stack, pa, pb, 'arena');
    await stack.ranked.accept(userIdentity('ash'));
    const matched = await stack.ranked.accept(userIdentity('gary'));
    expect(matched.state).toBe('MATCHED');
    return matched.battleId as string;
  }

  it('准入积分：按段位定价，双方 accept 才扣（reason=arena:entry:<battleId>）', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    const changes = trackPoints(stack.chain);

    await enqueuePair(stack, pa.id, pb.id, 'arena');
    // 一方接受时还不扣
    await stack.ranked.accept(userIdentity('ash'));
    expect((await stack.contract.getPlayer('ash')).points).toBe(1000);
    expect(changes).toHaveLength(0);

    const matched = await stack.ranked.accept(userIdentity('gary'));
    expect(matched.state).toBe('MATCHED');
    const battleId = matched.battleId as string;
    expect((await stack.contract.getPlayer('ash')).points).toBe(1000 - ARENA_ENTRY_FEES.bronze);
    expect((await stack.contract.getPlayer('gary')).points).toBe(1000 - ARENA_ENTRY_FEES.bronze);
    expect(changes).toEqual([
      { playerId: 'ash', delta: -20, reason: `arena:entry:${battleId}` },
      { playerId: 'gary', delta: -20, reason: `arena:entry:${battleId}` },
    ]);
    const record = await stack.ranked.battleRecord(battleId);
    expect(record).toMatchObject({ mode: 'arena', arena: { entryA: 20, entryB: 20 } });
  });

  it('胜者拿双方准入 + 系统补贴（准入 50% 向下取整），败者不退', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    const battleId = await startArena(stack, pa.id, pb.id);
    const outcome = await settleArena(stack, battleId, 'ash');

    expect(outcome.arena).toMatchObject({ entryA: 20, entryB: 20 });
    expect(outcome.arena?.plan).toMatchObject({ subsidy: 10, subsidyTo: 'ash' });
    expect(outcome.arena?.plan?.subsidyBlocked).toBeUndefined();
    expect(outcome.arena?.plan?.payouts).toEqual([
      { playerId: 'ash', points: 50, reason: `arena:reward:${battleId}`, idemKey: `${battleId}-arena-reward` },
    ]);
    // 1000 - 20（准入）+ 40（双方准入）+ 10（补贴）
    expect((await stack.contract.getPlayer('ash')).points).toBe(1030);
    expect((await stack.contract.getPlayer('gary')).points).toBe(980);
    // 补贴计数 +1
    expect(await stack.redis.client.scard(subsidyDailyKey('ash', utcDate()))).toBe(1);
  });

  it('平局退还各自准入（不发补贴）', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    const battleId = await startArena(stack, pa.id, pb.id);
    const outcome = await settleArena(stack, battleId, 'DRAW');

    expect(outcome.arena?.plan).toMatchObject({ subsidy: 0, subsidyTo: null });
    expect(outcome.arena?.plan?.payouts.map((p) => [p.playerId, p.points])).toEqual([
      ['ash', 20],
      ['gary', 20],
    ]);
    expect((await stack.contract.getPlayer('ash')).points).toBe(1000);
    expect((await stack.contract.getPlayer('gary')).points).toBe(1000);
    expect(await stack.redis.client.scard(subsidyDailyKey('ash', utcDate()))).toBe(0);
  });

  it('补贴防刷：每天最多 3 次（第 4 次不发）', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    for (const id of ['b_old_1', 'b_old_2', 'b_old_3']) {
      await stack.redis.client.sadd(subsidyDailyKey('ash', utcDate()), id);
    }
    const battleId = await startArena(stack, pa.id, pb.id);
    const outcome = await settleArena(stack, battleId, 'ash');

    expect(outcome.arena?.plan).toMatchObject({ subsidy: 0, subsidyBlocked: 'DAILY_LIMIT' });
    expect((await stack.contract.getPlayer('ash')).points).toBe(1020); // 只有双方准入
  });

  it('补贴防刷：对手 rating 差 > 400 不发（双方段位不同则准入额各按自己段位）', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    await stack.contract.updateRating(SYSTEM_IDENTITY, 'gary', 1450, 'test');
    await enqueuePair(stack, pa.id, pb.id, 'arena');
    // 窗口扩到 ±500（等待 60s）才能配到 450 分差
    await rewindEntry(stack, 'ash', 60_000);
    await rewindEntry(stack, 'gary', 60_000);
    expect(await stack.ranked.tryMatch()).not.toBeNull();

    await stack.ranked.accept(userIdentity('ash'));
    const matched = await stack.ranked.accept(userIdentity('gary'));
    expect(matched.state).toBe('MATCHED');
    const battleId = matched.battleId as string;
    const outcome = await settleArena(stack, battleId, 'ash');

    expect(outcome.arena).toMatchObject({ entryA: 20, entryB: 100 });
    expect(outcome.arena?.plan).toMatchObject({ subsidy: 0, subsidyBlocked: 'RATING_GAP' });
    // 青铜 20 + 黄金 100 = 120；胜者 ash：1000 - 20 + 120
    expect((await stack.contract.getPlayer('ash')).points).toBe(1100);
    expect((await stack.contract.getPlayer('gary')).points).toBe(900);
  });

  it('补贴防刷：机器人场不发（纯函数判定）', () => {
    expect(arenaSubsidyDecision({ subsidy: 10, ratingGap: 0, bot: true, dailyUsed: 0 })).toEqual({
      grant: false,
      blocked: 'BOT',
    });
    expect(arenaSubsidyDecision({ subsidy: 10, ratingGap: 0, bot: false, dailyUsed: 2 })).toEqual({ grant: true, blocked: undefined });
    expect(arenaSubsidyDecision({ subsidy: 10, ratingGap: 401, bot: false, dailyUsed: 0 })).toEqual({
      grant: false,
      blocked: 'RATING_GAP',
    });
    expect(arenaSubsidyDecision({ subsidy: 10, ratingGap: 0, bot: false, dailyUsed: 3 })).toEqual({
      grant: false,
      blocked: 'DAILY_LIMIT',
    });
  });

  it('准入额按段位定价（青铜 20 / 白银 50 / 黄金 100 / 白金 200 / 大师 400）', () => {
    expect(arenaEntryFee(0)).toBe(20);
    expect(arenaEntryFee(1199)).toBe(20);
    expect(arenaEntryFee(1200)).toBe(50);
    expect(arenaEntryFee(1400)).toBe(100);
    expect(arenaEntryFee(1600)).toBe(200);
    expect(arenaEntryFee(1800)).toBe(400);
    expect(arenaEntryFee(99999)).toBe(400);
  });

  it('扣费失败则取消建房：积分不足方被拒，双方回 ERROR 且无人被扣', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    await stack.contract.addPoints(SYSTEM_IDENTITY, 'ash', -990, 'test-drain', { idemKey: 'drain-ash' });
    expect((await stack.contract.getPlayer('ash')).points).toBe(10);

    await enqueuePair(stack, pa.id, pb.id, 'arena');
    await stack.ranked.accept(userIdentity('gary'));
    const failed = await stack.ranked.accept(userIdentity('ash'));
    expect(failed.state).toBe('ERROR');
    expect(failed.message).toContain('INSUFFICIENT_POINTS');
    expect((await stack.ranked.status(userIdentity('gary'))).state).toBe('ERROR');
    // 无人被扣、没有建房（房间没绑 battle）
    expect((await stack.contract.getPlayer('ash')).points).toBe(10);
    expect((await stack.contract.getPlayer('gary')).points).toBe(1000);
    expect(await stack.redis.client.zcard('ranked:queue')).toBe(0);
    for (const roomId of await stack.redis.smembers('battle:rooms')) {
      const room = await stack.redis.getJson<{ battleId: string | null }>(`battle:room:${roomId}`);
      expect(room?.battleId ?? null).toBeNull();
    }
  });

  it('第二方扣费失败时，第一方的准入原路退回', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    await stack.contract.addPoints(SYSTEM_IDENTITY, 'gary', -995, 'test-drain', { idemKey: 'drain-gary' });
    await enqueuePair(stack, pa.id, pb.id, 'arena');
    await stack.ranked.accept(userIdentity('gary'));
    const failed = await stack.ranked.accept(userIdentity('ash'));
    expect(failed.state).toBe('ERROR');
    expect((await stack.contract.getPlayer('ash')).points).toBe(1000); // 扣了又退回
    expect((await stack.contract.getPlayer('gary')).points).toBe(5);
  });

  it('一方拒绝 → 不扣费（准入只在双方接受后发生）', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    await enqueuePair(stack, pa.id, pb.id, 'arena');
    await stack.ranked.accept(userIdentity('ash'));
    const declined = await stack.ranked.decline(userIdentity('gary'));
    expect(declined.state).toBe('QUEUED');
    expect((await stack.contract.getPlayer('ash')).points).toBe(1000);
    expect((await stack.contract.getPlayer('gary')).points).toBe(1000);
  });

  it('仲裁退款（REFUNDED）：准入原路退回', async () => {
    const stack = await makeStack();
    const { pa, pb } = await seedTeams(stack.chain, stack.contract);
    await enqueuePair(stack, pa.id, pb.id, 'arena');
    await stack.ranked.accept(userIdentity('ash'));
    const matched = await stack.ranked.accept(userIdentity('gary'));
    const battleId = matched.battleId as string;
    await stack.contract.disputeBattle(userIdentity('ash'), battleId, 'ash', 'connection');
    await stack.contract.arbitrateBattle(
      { mspId: 'Org2MSP', role: 'arbitrator', userId: 'arbiter' },
      battleId,
      'REFUND',
      'service outage',
    );
    await stack.rewards.onSettled({
      battleId,
      roomId: matched.roomId ?? null,
      playerA: 'ash',
      playerB: 'gary',
      teamA: [pa.id],
      teamB: [pb.id],
    });
    expect((await stack.contract.getPlayer('ash')).points).toBe(1000);
    expect((await stack.contract.getPlayer('gary')).points).toBe(1000);
    expect((await stack.ranked.outcome(battleId)).status).toBe('NONE');
  });
});
