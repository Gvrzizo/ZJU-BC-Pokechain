import { sha256hex } from '../src/common/utils/crypto.util';
import { CaptureService } from '../src/pokemon/capture.service';
import {
  CATCH_REWARD_POINTS,
  RELEASE_POINTS_PER_LEVEL,
  WILD_FAINT_POINTS_PER_LEVEL,
  catchRewardReason,
  releaseRewardReason,
  wildFaintRewardReason,
} from '../src/pokemon/points-economy';
import { WildService } from '../src/wild/wild.service';
import { loadWildSession, wildSessionKey } from '../src/wild/wild-session';
import {
  makeBondService,
  makeChain,
  makePokemonService,
  makeRedis,
  mintBall,
  registerPlayers,
  seedPokemon,
  userIdentity,
} from './helpers';

const SERVER_SEED = 'aa'.repeat(32);

function build() {
  const { chain, contract } = makeChain();
  const redis = makeRedis();
  const capture = new CaptureService(chain, contract, redis);
  const pokemon = makePokemonService(contract, redis);
  const wild = new WildService(contract, capture, pokemon, makeBondService(contract, redis), redis);
  return { chain, contract, redis, capture, wild, pokemon };
}

/** 直接写入遇敌会话（等价于 POST /capture/encounter 之后的状态）并上链承诺。 */
async function seedEncounter(
  ctx: ReturnType<typeof build>,
  eventId: string,
  opts: { speciesId: number; wildLevel: number; clientSeed: string; playerId?: string },
) {
  const playerId = opts.playerId ?? 'ash';
  await ctx.contract.commitRandom(userIdentity(playerId), {
    eventId,
    purpose: 'capture',
    playerId,
    commitHash: sha256hex(SERVER_SEED),
    clientSeed: opts.clientSeed,
  });
  await ctx.redis.setJson(`capture:${eventId}`, {
    playerId,
    serverSeed: SERVER_SEED,
    clientSeed: opts.clientSeed,
    attempts: 0,
    speciesId: opts.speciesId,
    wildLevel: opts.wildLevel,
  });
}

/** 修改会话状态（这里用来把野怪打到 1 HP，便于确定性击倒）。 */
async function patchSession(ctx: ReturnType<typeof build>, sessionId: string, patch: (session: any) => void) {
  const session = (await loadWildSession(ctx.redis, sessionId))!;
  patch(session);
  await ctx.redis.setJson(wildSessionKey(sessionId), session, 900);
}

/** 收集链上事件，用于核对积分 reason（可审计口径）。 */
function collectPoints(chain: ReturnType<typeof build>['chain']) {
  const reasons: string[] = [];
  chain.onChainEvent((name, payload) => {
    if (name === 'PointsChanged' && typeof payload.reason === 'string') reasons.push(payload.reason);
  });
  return reasons;
}

const ash = userIdentity('ash');
const pointsOf = (ctx: ReturnType<typeof build>, player = 'ash') => ctx.contract.getPlayer(player).then((p) => p.points);

describe('积分经济：野怪奖励（docs/backend-api.md §「积分经济」）', () => {
  it('faucet 口径锁定（2026-09 重平衡）：收服 20 / 击倒 等级×1 / 放生 等级×1（注册 1000 不变）', () => {
    expect(CATCH_REWARD_POINTS).toBe(20);
    expect(WILD_FAINT_POINTS_PER_LEVEL).toBe(1);
    expect(RELEASE_POINTS_PER_LEVEL).toBe(1);
    // reason 口径不变（链上可审计）
    expect(catchRewardReason('p_x')).toBe('reward:catch:p_x');
    expect(wildFaintRewardReason('w_x')).toBe('reward:wild-faint:w_x');
    expect(releaseRewardReason('p_x')).toBe('reward:release:p_x');
    // 单场野怪战斗的积分收入上界（满级野怪击倒 100 + 收服 20）远低于高级球定价 400
    expect(100 * WILD_FAINT_POINTS_PER_LEVEL + CATCH_REWARD_POINTS).toBeLessThan(400);
  });

  it('收服野怪：+20 积分（reason=reward:catch:<pokemonId>），重复动作不重复加分', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const master = await mintBall(ctx.contract, 'ash', 'i_master_catch', 'master-ball', 1);
    await seedPokemon(ctx.chain, 'ash', { id: 'p_hero', level: 20, moves: ['tackle'] });
    const reasons = collectPoints(ctx.chain);

    const eventId = 'ev_reward_catch';
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 5, clientSeed: 'bb'.repeat(16) });
    const started = await ctx.wild.start(ash, eventId);
    const before = await pointsOf(ctx);

    const caught = await ctx.wild.action(ash, started.sessionId, { type: 'ball', ballItemId: master.id });
    expect(caught.status).toBe('CAUGHT');
    expect(caught.catchReward).toBe(CATCH_REWARD_POINTS);

    const pokemonId = caught.captured!.id;
    expect(await pointsOf(ctx)).toBe(before + CATCH_REWARD_POINTS);
    expect(reasons).toContain(`reward:catch:${pokemonId}`);

    // 会话已结束：重放同一动作只返回终态，不重复发分
    const replay = await ctx.wild.action(ash, started.sessionId, { type: 'ball', ballItemId: master.id });
    expect(replay.finished).toBe(true);
    expect(await pointsOf(ctx)).toBe(before + CATCH_REWARD_POINTS);
  });

  it('击倒野怪：+野怪等级×2 积分（reason=reward:wild-faint:<sessionId>），重复动作不重复加分', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await seedPokemon(ctx.chain, 'ash', { id: 'p_ko', speciesId: 149, level: 60, moves: ['tackle'] });
    const reasons = collectPoints(ctx.chain);

    const eventId = 'ev_reward_faint';
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 7, clientSeed: 'cc'.repeat(16) });
    const started = await ctx.wild.start(ash, eventId);
    await patchSession(ctx, started.sessionId, (s) => {
      s.wild.hp = 1;
    });
    const before = await pointsOf(ctx);

    const after = await ctx.wild.action(ash, started.sessionId, { type: 'move', moveId: 'tackle' });
    expect(after.status).toBe('WILD_FAINTED');
    expect(after.faintReward).toBe(7 * WILD_FAINT_POINTS_PER_LEVEL);
    expect(await pointsOf(ctx)).toBe(before + 7 * WILD_FAINT_POINTS_PER_LEVEL);
    expect(reasons).toContain(`reward:wild-faint:${started.sessionId}`);

    const replay = await ctx.wild.action(ash, started.sessionId, { type: 'move', moveId: 'tackle' });
    expect(replay.finished).toBe(true);
    expect(await pointsOf(ctx)).toBe(before + 7 * WILD_FAINT_POINTS_PER_LEVEL);
  });

  it('快速捕捉：+50 积分（与野怪战斗同一 reason 口径），重复投球已是新事件', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const master = await mintBall(ctx.contract, 'ash', 'i_master_quick', 'master-ball', 1);
    const reasons = collectPoints(ctx.chain);

    const enc = await ctx.capture.encounter(ash, 'dd'.repeat(16));
    const before = await pointsOf(ctx);
    const res = await ctx.capture.attempt(ash, enc.eventId, master.id);

    expect(res.success).toBe(true);
    if (!res.success) throw new Error('expected capture success');
    expect(res.catchReward).toBe(CATCH_REWARD_POINTS);
    expect(await pointsOf(ctx)).toBe(before + CATCH_REWARD_POINTS);
    expect(reasons).toContain(`reward:catch:${res.pokemon.id}`);

    // 会话已消费：同一 eventId 再投球直接拒绝，不会重复加分
    await expect(ctx.capture.attempt(ash, enc.eventId, master.id)).rejects.toThrow(/UNKNOWN_EVENT/);
    expect(await pointsOf(ctx)).toBe(before + CATCH_REWARD_POINTS);
  });

  it('放生宝可梦：+等级×5 积分（reason=reward:release:<pokemonId>），不可重复放生', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await seedPokemon(ctx.chain, 'ash', { id: 'p_release', speciesId: 25, level: 20 });
    const reasons = collectPoints(ctx.chain);
    const before = await pointsOf(ctx);

    const released = await ctx.pokemon.release(ash, 'p_release');
    expect(released.status).toBe('RELEASED');
    expect(await pointsOf(ctx)).toBe(before + 20 * RELEASE_POINTS_PER_LEVEL);
    expect(reasons).toContain('reward:release:p_release');

    // ownerId 已清空 → 二次放生 NOT_OWNER，不重复加分
    await expect(ctx.pokemon.release(ash, 'p_release')).rejects.toThrow(/NOT_OWNER/);
    expect(await pointsOf(ctx)).toBe(before + 20 * RELEASE_POINTS_PER_LEVEL);
  });
});
