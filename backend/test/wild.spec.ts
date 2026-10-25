import { DeriveStream, sha256hex } from '../src/common/utils/crypto.util';
import { BattleEngine } from '../src/battles/engine/battle-engine';
import { getSpecies } from '../src/game-data/species.data';
import { computeStats } from '../src/game-data/stats';
import { CaptureService } from '../src/pokemon/capture.service';
import {
  captureProbability,
  deriveAttempt,
  deriveCaptureRoll,
  deriveWildSpecimen,
} from '../src/pokemon/capture-derive';
import { WildService } from '../src/wild/wild.service';
import { loadWildSession, wildSessionKey } from '../src/wild/wild-session';
import {
  SYSTEM_IDENTITY,
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

/** 事件派生流：投球判定在 attempt 块 +0（第 1 次 = n2，第 2 次 = n12），野怪回合在 n30000 起、步长 16。 */
const BALL_ROLL = (attempt: number) => 2 + (attempt - 1) * 10;
const TURN_BASE = (turn: number) => 30_000 + (turn - 1) * 16;
/** 野怪回合块槽位（docs/randomness.md §3）：+0 AI 选招，+1..5 我方，+6..10 野怪，+11 平速裁决 */
const SLOT = {
  wildMove: 0,
  playerPar: 1,
  playerHit: 2,
  playerCrit: 3,
  playerFactor: 4,
  playerEffect: 5,
  wildPar: 6,
  wildHit: 7,
  wildCrit: 8,
  wildFactor: 9,
  wildEffect: 10,
  tieBreak: 11,
} as const;
const at = (turn: number, key: keyof typeof SLOT) => TURN_BASE(turn) + SLOT[key];

/** 找一个满足条件的 clientSeed（测试确定性用；clientSeed 由服务端/玩家自由选择）。 */
function findClientSeed(
  eventId: string,
  predicate: (stream: DeriveStream) => boolean,
  serverSeed = SERVER_SEED,
): string {
  for (let i = 0; i < 50_000; i++) {
    const clientSeed = i.toString(16).padStart(16, '0');
    if (predicate(new DeriveStream(serverSeed, clientSeed, eventId))) return clientSeed;
  }
  throw new Error(`no client seed satisfying the predicate for ${eventId}`);
}

function build() {
  const { chain, contract } = makeChain();
  const redis = makeRedis();
  const capture = new CaptureService(chain, contract, redis);
  const wild = new WildService(contract, capture, makePokemonService(contract, redis), makeBondService(contract, redis), redis);
  return { chain, contract, redis, capture, wild };
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

/** 修改会话状态（模拟战斗中已积累的状态，如已有异常状态/队友已倒下）。 */
async function patchSession(ctx: ReturnType<typeof build>, sessionId: string, patch: (session: any) => void) {
  const session = (await loadWildSession(ctx.redis, sessionId))!;
  patch(session);
  await ctx.redis.set(wildSessionKey(sessionId), JSON.stringify(session), 900);
}

const ash = userIdentity('ash');

describe('captureProbability (docs/backend-api.md §2 官方风格捕捉率)', () => {
  it('matches a = ((3*maxHP - 2*curHP) * rate * ballBonus) / (3*maxHP), p = a/255', () => {
    // 满血皮卡丘（官方捕获率 190）精灵球：(190/3)/255
    expect(captureProbability(100, 100, 190, 1)).toBeCloseTo(190 / 3 / 255, 12);
    // 半血
    expect(captureProbability(100, 50, 190, 1)).toBeCloseTo(((3 * 100 - 2 * 50) * 190) / (3 * 100) / 255, 12);
    // 1 HP 时接近上限
    expect(captureProbability(100, 1, 190, 1)).toBeGreaterThan(0.7);
  });

  it('rises monotonically as the wild HP drops and caps at 1', () => {
    const rates = [100, 75, 50, 25, 1].map((hp) => captureProbability(100, hp, 45, 1));
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i]).toBeGreaterThan(rates[i - 1]);
    }
    // 1 HP 时官方公式上限 a = 3*maxHP → p = 3*catchRate*ballBonus/3/255... 实际为 a/255 ≤ 1，超过即封顶
    expect(captureProbability(10, 0, 190, 2)).toBe(1);
    expect(captureProbability(10, 0, 45, 1)).toBeCloseTo(45 / 255, 12);
  });

  it('master ball is always a guaranteed catch', () => {
    expect(captureProbability(100, 100, 3, 255)).toBe(1);
    expect(captureProbability(100, 1, 3, 255)).toBe(1);
  });

  it('quick capture (POST /capture/attempt) = full-HP throw of the same formula', () => {
    const stream = new DeriveStream(SERVER_SEED, 'cc'.repeat(8), 'ev_quick');
    const derived = deriveAttempt(stream, 3, 45, 2);
    expect(derived.threshold).toBe(captureProbability(1, 1, 45, 2));
    const roll = deriveCaptureRoll(stream, 3, derived.threshold);
    expect(roll.catchRoll).toBe(derived.catchRoll);
    expect(roll.shakes).toBe(derived.shakes);
  });
});

describe('WildService (PvE 野怪战斗捕捉)', () => {
  it('start returns the server-authoritative initial state, the party list and the strongest starter by default', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await mintBall(ctx.contract, 'ash', 'i_ball', 'poke-ball', 5);
    await seedPokemon(ctx.chain, 'ash', { id: 'p_weak', level: 5 });
    const strong = await seedPokemon(ctx.chain, 'ash', {
      id: 'p_strong',
      speciesId: 149,
      level: 20,
      moves: ['tackle'],
    });
    await seedPokemon(ctx.chain, 'ash', { id: 'p_locked', level: 50, status: 'LOCKED_BATTLE' });

    const eventId = 'ev_wild_start';
    const clientSeed = findClientSeed(eventId, () => true);
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 10, clientSeed });

    const state = await ctx.wild.start(ash, eventId);
    expect(state.sessionId).toMatch(/^w_/);
    expect(state.status).toBe('ACTIVE');
    expect(state.finished).toBe(false);
    expect(state.turn).toBe(1);
    expect(state.mustSwitch).toBe(false);

    // 队伍：等级最高的 IDLE 宝可梦（锁定中的 50 级被排除）
    expect(state.mine.pokemonId).toBe(strong.id);
    const mineSpecies = getSpecies(149)!;
    const mineStats = computeStats(mineSpecies.base, strong.ivs, strong.evs, 20, strong.nature);
    expect(state.mine.maxHp).toBe(mineStats.hp);
    expect(state.mine.hp).toBe(mineStats.hp);
    // 队伍列表：全部 IDLE 成员，出战位 active
    expect(state.party.map((p) => p.pokemonId)).toEqual(['p_strong', 'p_weak']);
    expect(state.party[0].active).toBe(true);
    expect(state.party[0].fainted).toBe(false);
    expect(state.activeIndex).toBe(0);

    // 野怪：满血、等级来自会话、个体样本来自派生流野怪区域
    const wildSpecies = getSpecies(25)!;
    const specimen = deriveWildSpecimen(new DeriveStream(SERVER_SEED, clientSeed, eventId));
    const wildStats = computeStats(wildSpecies.base, specimen.ivs, { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 }, 10, specimen.nature);
    expect(state.wild.maxHp).toBe(wildStats.hp);
    expect(state.wild.hp).toBe(wildStats.hp);
    expect(state.wild.level).toBe(10);
    expect(state.wild.catchRate).toBe(190);

    // 技能元数据带中文效果说明（战斗界面悬停）
    expect(state.mine.moves.every((m) => typeof m.effectText === 'string' && m.effectText.length > 0)).toBe(true);

    // 状态里带各球当前捕捉成功率（官方公式，满血皮卡丘 + 精灵球）
    expect(state.captureChances).toHaveLength(1);
    expect(state.captureChances[0].itemId).toBe('i_ball');
    expect(state.captureChances[0].chance).toBeCloseTo(captureProbability(wildStats.hp, wildStats.hp, 190, 1), 12);

    // start 幂等：同一 eventId 再次 start 返回同一会话
    const again = await ctx.wild.start(ash, eventId);
    expect(again.sessionId).toBe(state.sessionId);
  });

  it('start accepts an optional partyPokemonId starter and rejects foreign/dead ids', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash', 'gary');
    await seedPokemon(ctx.chain, 'ash', { id: 'p_small', level: 5 });
    await seedPokemon(ctx.chain, 'ash', { id: 'p_big', speciesId: 143, level: 30 });
    await seedPokemon(ctx.chain, 'gary', { id: 'p_gary', level: 30 });

    const eventId = 'ev_wild_starter';
    const clientSeed = findClientSeed(eventId, () => true);
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 8, clientSeed });

    const state = await ctx.wild.start(ash, eventId, 'p_small');
    expect(state.mine.pokemonId).toBe('p_small');
    expect(state.activeIndex).toBe(1); // 队伍按等级降序：p_big, p_small
    expect(state.party[0].pokemonId).toBe('p_big');
    expect(state.party[0].active).toBe(false);
    expect(state.party[1].active).toBe(true);

    await expect(ctx.wild.start(ash, 'ev_wild_starter2', 'p_gary')).rejects.toThrow(/UNKNOWN_EVENT/);
    const eventId3 = 'ev_wild_starter3';
    await seedEncounter(ctx, eventId3, { speciesId: 25, wildLevel: 8, clientSeed: findClientSeed(eventId3, () => true) });
    await expect(ctx.wild.start(ash, eventId3, 'p_gary')).rejects.toThrow(/INVALID_PARTY_POKEMON/);
    await expect(ctx.wild.start(ash, eventId3, 'p_missing')).rejects.toThrow(/INVALID_PARTY_POKEMON/);
  });

  it('raises the displayed capture chance as the wild mon loses HP', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await mintBall(ctx.contract, 'ash', 'i_ball', 'poke-ball', 5);
    await seedPokemon(ctx.chain, 'ash', { id: 'p_hero', speciesId: 133, level: 10, moves: ['tackle'] });

    const eventId = 'ev_wild_chance';
    // 玩家先手、命中野怪（不追求击倒）
    const clientSeed = findClientSeed(eventId, (s) => s.at(at(1, 'playerHit')) < 0.5);
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 14, clientSeed });

    const before = await ctx.wild.start(ash, eventId);
    const after = await ctx.wild.action(ash, before.sessionId, { type: 'move', moveId: 'tackle' });

    expect(after.wild.hp).toBeLessThan(before.wild.hp);
    expect(after.captureChances[0].chance).toBeGreaterThan(before.captureChances[0].chance);
    expect(after.captureChances[0].chance).toBeCloseTo(
      captureProbability(after.wild.maxHp, after.wild.hp, 190, 1),
      12,
    );
  });

  it('captures the wild mon through RevealAndVerify -> MintFromCapture with the fought specimen', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const ball = await mintBall(ctx.contract, 'ash', 'i_ball_ok', 'poke-ball', 3);
    await seedPokemon(ctx.chain, 'ash', { id: 'p_hero', level: 30, moves: ['tackle'] });

    const eventId = 'ev_wild_catch';
    // 第 1 次投球必定命中（roll < 满血概率 0.248）
    const clientSeed = findClientSeed(eventId, (s) => s.at(BALL_ROLL(1)) < 0.24);
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 12, clientSeed });

    const started = await ctx.wild.start(ash, eventId);
    const caught = await ctx.wild.action(ash, started.sessionId, { type: 'ball', ballItemId: ball.id });

    expect(caught.finished).toBe(true);
    expect(caught.status).toBe('CAUGHT');
    expect(caught.captured).not.toBeNull();
    const specimen = deriveWildSpecimen(new DeriveStream(SERVER_SEED, clientSeed, eventId));
    expect(caught.captured!.speciesId).toBe(25);
    expect(caught.captured!.ivs).toEqual(specimen.ivs);
    expect(caught.captured!.nature).toBe(specimen.nature);
    expect(caught.captured!.shiny).toBe(specimen.shiny);
    expect(caught.captured!.level).toBe(12);
    expect(caught.captured!.ownerId).toBe('ash');
    expect(caught.captured!.stats).toBeDefined();

    // 球消耗一次、随机事件被消费、宝可梦上链
    expect((await ctx.contract.getItem(ball.id)).quantity).toBe(2);
    expect((await ctx.contract.getRandom(eventId)).status).toBe('CONSUMED');
    const owned = await ctx.contract.queryPokemonByOwner('ash');
    expect(owned.map((p) => p.id)).toContain(caught.captured!.id);

    // 已结束的会话再动作只返回终态，不再消耗球
    const replay = await ctx.wild.action(ash, started.sessionId, { type: 'ball', ballItemId: ball.id });
    expect(replay.finished).toBe(true);
    expect((await ctx.contract.getItem(ball.id)).quantity).toBe(2);
  });

  it('收服成功给出战宝可梦 +20 exp：走集中升级路径，状态返回升级/新技能/可进化', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const ball = await mintBall(ctx.contract, 'ash', 'i_ball_exp', 'poke-ball', 3);
    // 小火龙 Lv13、距 Lv14（14^3 = 2744）差 20 点：正好体现"收服 +20 经验 + 升级学技能"
    await seedPokemon(ctx.chain, 'ash', {
      id: 'p_exp_hero',
      speciesId: 4,
      name: 'charmander',
      level: 13,
      exp: 2724,
      moves: ['ember', 'tackle', 'quick-attack', 'body-slam'],
    });

    const eventId = 'ev_wild_capture_exp';
    const clientSeed = findClientSeed(eventId, (s) => s.at(BALL_ROLL(1)) < 0.24);
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 12, clientSeed });

    const started = await ctx.wild.start(ash, eventId);
    const caught = await ctx.wild.action(ash, started.sessionId, { type: 'ball', ballItemId: ball.id });

    expect(caught.status).toBe('CAUGHT');
    expect(caught.expGained).toBe(20);
    expect(caught.expGainedBy).toBe('p_exp_hero');
    expect(caught.levelsGained).toBe(1);
    expect(caught.movesLearned).toEqual(['fire-fang']); // 小火龙 Lv14 学习表
    expect(caught.canEvolve).toBe(false); // 进化要 Lv16

    // 出战宝可梦链上成长（新技能替换最早学的 ember）
    const hero = await ctx.contract.getPokemon('p_exp_hero');
    expect(hero.exp).toBe(2744);
    expect(hero.level).toBe(14);
    expect(hero.moves).toEqual(['tackle', 'quick-attack', 'body-slam', 'fire-fang']);

    // 已结束会话重放：不再重复加经验
    await ctx.wild.action(ash, started.sessionId, { type: 'ball', ballItemId: ball.id });
    expect((await ctx.contract.getPokemon('p_exp_hero')).exp).toBe(2744);
  });

  it('master ball always catches, even on a roll that fails a poke ball', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const poke = await mintBall(ctx.contract, 'ash', 'i_ball_poke', 'poke-ball', 5);
    const master = await mintBall(ctx.contract, 'ash', 'i_ball_master', 'master-ball', 1);
    await seedPokemon(ctx.chain, 'ash', { id: 'p_hero', level: 30, moves: ['tackle'] });

    const eventId = 'ev_wild_master';
    // 该 roll 对精灵球（阈值 0.248）一定失败
    const clientSeed = findClientSeed(eventId, (s) => s.at(BALL_ROLL(1)) > 0.9);
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 10, clientSeed });

    const failed = await ctx.wild.start(ash, eventId);
    const threw = await ctx.wild.action(ash, failed.sessionId, { type: 'ball', ballItemId: poke.id });
    expect(threw.finished).toBe(false);
    expect(threw.attempts).toBe(1);

    const caught = await ctx.wild.action(ash, failed.sessionId, { type: 'ball', ballItemId: master.id });
    expect(caught.status).toBe('CAUGHT');
    expect((await ctx.contract.getItem(master.id)).quantity).toBe(0);
  });

  it('a failed throw consumes the ball, advances the attempt block and lets the wild mon answer', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const ball = await mintBall(ctx.contract, 'ash', 'i_ball_fail', 'poke-ball', 4);
    await seedPokemon(ctx.chain, 'ash', { id: 'p_hero', level: 40, speciesId: 143, moves: ['tackle'] });

    const eventId = 'ev_wild_fail';
    const clientSeed = findClientSeed(
      eventId,
      (s) => s.at(BALL_ROLL(1)) > 0.9 && s.at(BALL_ROLL(2)) > 0.9 && s.at(at(1, 'wildHit')) < 0.5,
    );
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 14, clientSeed });

    const started = await ctx.wild.start(ash, eventId);
    const first = await ctx.wild.action(ash, started.sessionId, { type: 'ball', ballItemId: ball.id });

    expect(first.finished).toBe(false);
    expect(first.status).toBe('ACTIVE');
    expect(first.attempts).toBe(1);
    expect((await ctx.contract.getItem(ball.id)).quantity).toBe(3);
    // 野怪反击（命中判定走 n30007）
    expect(first.log.some((t) => t.events.some((e) => e.side === 'wild' && (e.kind === 'move' || e.kind === 'miss')))).toBe(true);
    expect(first.log.some((t) => t.events.some((e) => e.kind === 'ball-failed'))).toBe(true);
    // H9：失败的投球保持 COMMITTED（只有投中/战斗终态才揭示）
    expect((await ctx.contract.getRandom(eventId)).status).toBe('COMMITTED');

    const second = await ctx.wild.action(ash, started.sessionId, { type: 'ball', ballItemId: ball.id });
    expect(second.attempts).toBe(2);
    expect((await ctx.contract.getItem(ball.id)).quantity).toBe(2);
    // 投球计数写回遇敌会话：快速捕捉路径继续用同一组 attempt 派生块
    const captureSession = await ctx.redis.getJson<{ attempts: number }>(`capture:${eventId}`);
    expect(captureSession?.attempts).toBe(2);
    // 第 2 次投球用块 base=12 的判定
    const rolls = new DeriveStream(SERVER_SEED, clientSeed, eventId);
    expect(first.log.at(-1)!.events.some((e) => e.kind === 'ball-failed')).toBe(true);
    expect(deriveCaptureRoll(rolls, 2, captureProbability(100, 100, 190, 1)).success).toBe(false);
  });

  it('knocking the wild mon out ends the battle, blocks further captures and grants exp', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const ball = await mintBall(ctx.contract, 'ash', 'i_ball_ko', 'poke-ball', 3);
    const hero = await seedPokemon(ctx.chain, 'ash', {
      id: 'p_ko_hero',
      speciesId: 149,
      level: 60,
      moves: ['hyper-beam'],
    });

    const eventId = 'ev_wild_ko';
    const clientSeed = findClientSeed(eventId, (s) => s.at(at(1, 'playerHit')) < 0.85 && s.at(at(1, 'playerFactor')) < 0.5);
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 3, clientSeed });

    const started = await ctx.wild.start(ash, eventId);
    const after = await ctx.wild.action(ash, started.sessionId, { type: 'move', moveId: 'hyper-beam' });

    expect(after.wild.hp).toBe(0);
    expect(after.finished).toBe(true);
    expect(after.status).toBe('WILD_FAINTED');
    expect(after.expGained).toBeGreaterThan(0);
    const chainMon = await ctx.contract.getPokemon(hero.id);
    expect(chainMon.exp).toBe(after.expGained);

    // 已倒下 → 不能再捕捉（不消耗球）
    const later = await ctx.wild.action(ash, started.sessionId, { type: 'ball', ballItemId: ball.id });
    expect(later.status).toBe('WILD_FAINTED');
    expect((await ctx.contract.getItem(ball.id)).quantity).toBe(3);
    // 快速捕捉路径同样拒绝
    await expect(ctx.capture.attempt(ash, eventId, ball.id)).rejects.toThrow(/WILD_BATTLE_FINISHED/);
  });

  it('ends the battle when the player pokemon faints and no bench is left', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await seedPokemon(ctx.chain, 'ash', { id: 'p_hero_weak', speciesId: 133, level: 2, moves: ['tackle'] });

    const eventId = 'ev_wild_ko_me';
    const clientSeed = findClientSeed(eventId, (s) => s.at(at(1, 'wildMove')) < 0.2 && s.at(at(1, 'wildHit')) < 0.9);
    await seedEncounter(ctx, eventId, { speciesId: 149, wildLevel: 14, clientSeed });

    const started = await ctx.wild.start(ash, eventId);
    const after = await ctx.wild.action(ash, started.sessionId, { type: 'move', moveId: 'tackle' });

    expect(after.mine.hp).toBe(0);
    expect(after.finished).toBe(true);
    expect(after.status).toBe('PLAYER_FAINTED');
    expect(after.expGained).toBe(0);
  });

  it('run ends the session without consuming a ball or the random event', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const ball = await mintBall(ctx.contract, 'ash', 'i_ball_run', 'poke-ball', 2);
    await seedPokemon(ctx.chain, 'ash', { id: 'p_hero', level: 20, moves: ['tackle'] });

    const eventId = 'ev_wild_run';
    const clientSeed = findClientSeed(eventId, () => true);
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 5, clientSeed });

    const started = await ctx.wild.start(ash, eventId);
    const after = await ctx.wild.action(ash, started.sessionId, { type: 'run' });

    expect(after.finished).toBe(true);
    expect(after.status).toBe('RAN');
    expect((await ctx.contract.getItem(ball.id)).quantity).toBe(2);
    // H9：战斗终态（逃跑）后揭示，供 /fairness 复核
    expect((await ctx.contract.getRandom(eventId)).status).toBe('REVEALED');
  });

  it('expires after 15 minutes of inactivity (Redis TTL + TIMEOUT terminal state)', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await mintBall(ctx.contract, 'ash', 'i_ball_ttl', 'poke-ball', 2);
    await seedPokemon(ctx.chain, 'ash', { id: 'p_hero', level: 20, moves: ['tackle'] });

    const eventId = 'ev_wild_timeout';
    const clientSeed = findClientSeed(eventId, () => true);
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 5, clientSeed });

    const started = await ctx.wild.start(ash, eventId);
    await patchSession(ctx, started.sessionId, (session) => {
      session.expiresAt = Date.now() - 1;
    });

    const after = await ctx.wild.action(ash, started.sessionId, { type: 'move', moveId: 'tackle' });
    expect(after.finished).toBe(true);
    expect(after.status).toBe('TIMEOUT');
    expect(after.log.some((t) => t.events.some((e) => e.kind === 'timeout'))).toBe(true);
    // H9：超时也是终态，结算后揭示
    expect((await ctx.contract.getRandom(eventId)).status).toBe('REVEALED');
  });

  it('rejects unknown sessions, foreign sessions and missing moveId/ballItemId', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash', 'gary');
    await mintBall(ctx.contract, 'ash', 'i_ball_a', 'poke-ball', 2);
    const garyBall = await mintBall(ctx.contract, 'gary', 'i_ball_g', 'poke-ball', 2);
    await seedPokemon(ctx.chain, 'ash', { id: 'p_hero', level: 20, moves: ['tackle'] });

    const eventId = 'ev_wild_errors';
    const clientSeed = findClientSeed(eventId, () => true);
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 5, clientSeed });
    const started = await ctx.wild.start(ash, eventId);

    await expect(ctx.wild.action(ash, 'w_missing', { type: 'run' })).rejects.toThrow(/WILD_SESSION_NOT_FOUND/);
    await expect(ctx.wild.action(userIdentity('gary'), started.sessionId, { type: 'run' })).rejects.toThrow(/NOT_OWNER/);
    await expect(ctx.wild.start(userIdentity('gary'), eventId)).rejects.toThrow(/NOT_OWNER/);
    await expect(ctx.wild.action(ash, started.sessionId, { type: 'move', moveId: 'flamethrower' })).rejects.toThrow(/UNKNOWN_MOVE/);
    await expect(ctx.wild.action(ash, started.sessionId, { type: 'ball' })).rejects.toThrow(/INVALID_ACTION/);
    await expect(ctx.wild.action(ash, started.sessionId, { type: 'switch' })).rejects.toThrow(/INVALID_ACTION/);
    await expect(ctx.wild.action(ash, started.sessionId, { type: 'ball', ballItemId: garyBall.id })).rejects.toThrow(/NOT_OWNER/);
    await expect(ctx.wild.action(ash, started.sessionId, { type: 'ball', ballItemId: 'i_ball_a' })).resolves.toBeDefined();

    const potion = await ctx.contract.mintItem(SYSTEM_IDENTITY, {
      id: 'i_potion',
      playerId: 'ash',
      typeId: 'potion',
      quantity: 1,
      uri: 'minio://assets/items/potion.png',
      metadataHash: 'x'.repeat(64),
    });
    await expect(ctx.wild.action(ash, started.sessionId, { type: 'ball', ballItemId: potion.id })).rejects.toThrow(/NOT_A_BALL/);
  });

  it('rejects start without an encounter, without an IDLE pokemon and on a consumed event', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await mintBall(ctx.contract, 'ash', 'i_ball_x', 'poke-ball', 2);

    // 没有 encounter（capture:<eventId> 会话缺失）
    await expect(ctx.wild.start(ash, 'ev_none')).rejects.toThrow(/UNKNOWN_EVENT/);

    const eventId = 'ev_wild_no_team';
    const clientSeed = findClientSeed(eventId, () => true);
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 5, clientSeed });
    await seedPokemon(ctx.chain, 'ash', { id: 'p_released', level: 20, status: 'RELEASED', moves: ['tackle'] });
    await expect(ctx.wild.start(ash, eventId)).rejects.toThrow(/NO_TEAM_POKEMON/);

    // 该事件已被消耗（铸造过一次）→ 不能再开野怪战斗
    const owned = await seedPokemon(ctx.chain, 'ash', { id: 'p_team', level: 20, moves: ['tackle'] });
    expect(owned.status).toBe('IDLE');
    await ctx.contract.revealAndVerify(SYSTEM_IDENTITY, eventId, SERVER_SEED);
    await ctx.contract.mintFromCapture(SYSTEM_IDENTITY, {
      id: 'p_consumed',
      playerId: 'ash',
      speciesId: 25,
      name: 'pikachu',
      ivs: { hp: 1, atk: 1, def: 1, spatk: 1, spdef: 1, speed: 1 },
      nature: 'hardy',
      ability: 'static',
      shiny: false,
      moves: ['tackle'],
      dnaHash: 'd'.repeat(64),
      eventId,
    });
    await expect(ctx.wild.start(ash, eventId)).rejects.toThrow(/EVENT_CONSUMED/);
  });

  it('keeps PvP battle state untouched (no battle:* keys, no asset locking)', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await mintBall(ctx.contract, 'ash', 'i_ball_pvp', 'poke-ball', 3);
    const hero = await seedPokemon(ctx.chain, 'ash', { id: 'p_pvp', speciesId: 133, level: 10, moves: ['tackle'] });

    const eventId = 'ev_wild_pvp';
    const clientSeed = findClientSeed(eventId, (s) => s.at(at(1, 'playerHit')) < 0.5);
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 10, clientSeed });

    // 模拟一场进行中的 PvP（BattleManagerService 的种子备份键）
    await ctx.redis.setJson('battle:seed:b_live', { serverSeed: 'ff', clientSeed: 'ee', eventId: 'ev_battle_b_live' }, 900);

    const started = await ctx.wild.start(ash, eventId);
    const after = await ctx.wild.action(ash, started.sessionId, { type: 'move', moveId: 'tackle' });

    expect(after.finished).toBe(false);
    // PvP 会话/资产不受影响：battle:* 未被改动，宝可梦仍是 IDLE（野怪战斗不锁定资产）
    expect(await ctx.redis.getJson('battle:seed:b_live')).toEqual({
      serverSeed: 'ff',
      clientSeed: 'ee',
      eventId: 'ev_battle_b_live',
    });
    expect((await ctx.contract.getPokemon(hero.id)).status).toBe('IDLE');

    // 反过来：PvP 引擎可以同时用同一只宝可梦推进回合
    const engine = new BattleEngine(
      [{ pokemonId: hero.id, speciesId: 133, level: 10, ivs: hero.ivs, evs: hero.evs, nature: hero.nature, moves: ['tackle'] }],
      [{ pokemonId: 'p_foe', speciesId: 25, level: 12, ivs: hero.ivs, evs: hero.evs, nature: hero.nature, moves: ['tackle'] }],
      () => 0,
    );
    engine.submitAction('A', { type: 'move', moveIndex: 0 });
    const resolved = engine.submitAction('B', { type: 'move', moveIndex: 0 });
    expect(resolved.resolved).toBe(true);
    // 野怪会话仍在，两个系统互不干扰
    const still = await ctx.wild.get(ash, started.sessionId);
    expect(still.sessionId).toBe(started.sessionId);
    expect(still.finished).toBe(false);
  });
});

describe('WildService: 技能特效（灼伤 / 麻痹 / 能力阶级）', () => {
  it('灼伤：命中后写入状态并每个回合末扣 maxHP/16', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await seedPokemon(ctx.chain, 'ash', { id: 'p_burner', speciesId: 143, level: 20, moves: ['ember'] });

    const eventId = 'ev_wild_burn';
    // 追加效果掷点 < 10% → 灼伤
    const clientSeed = findClientSeed(
      eventId,
      (s) => s.at(at(1, 'playerEffect')) < 0.1 && s.at(at(1, 'wildMove')) < 0.25,
    );
    await seedEncounter(ctx, eventId, { speciesId: 143, wildLevel: 30, clientSeed });

    const before = await ctx.wild.start(ash, eventId);
    const first = await ctx.wild.action(ash, before.sessionId, { type: 'move', moveId: 'ember' });
    const damage = first.log.flatMap((t) => t.events).find((e) => e.kind === 'damage' && e.side === 'player')!.detail
      .damage as number;

    expect(first.wild.status).toBe('brn');
    expect(first.log.flatMap((t) => t.events).some((e) => e.kind === 'status' && e.detail.status === 'brn')).toBe(true);
    expect(first.wild.hp).toBe(before.wild.hp - damage - Math.floor(before.wild.maxHp / 16));
    expect(
      first.log.flatMap((t) => t.events).some((e) => e.kind === 'status-damage' && e.side === 'wild' && e.detail.damage === Math.floor(before.wild.maxHp / 16)),
    ).toBe(true);

    // 第 2 回合继续扣血
    const second = await ctx.wild.action(ash, before.sessionId, { type: 'move', moveId: 'ember' });
    const damage2 = second.log.flatMap((t) => t.events).filter((e) => e.kind === 'damage' && e.side === 'player').at(-1)!.detail
      .damage as number;
    expect(second.wild.hp).toBe(first.wild.hp - damage2 - Math.floor(before.wild.maxHp / 16));
    expect(second.wild.status).toBe('brn');
  });

  it('麻痹：野怪无法行动（25% 判定）且我方不受伤', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await seedPokemon(ctx.chain, 'ash', { id: 'p_slow', speciesId: 143, level: 20, moves: ['tackle'] });

    const eventId = 'ev_wild_par';
    const clientSeed = findClientSeed(eventId, (s) => s.at(at(1, 'wildPar')) < 0.25);
    await seedEncounter(ctx, eventId, { speciesId: 143, wildLevel: 30, clientSeed });

    const before = await ctx.wild.start(ash, eventId);
    // 模拟野怪已被麻痹（战斗内累积状态）
    await patchSession(ctx, before.sessionId, (session) => {
      session.wild.status = 'par';
    });

    const after = await ctx.wild.action(ash, before.sessionId, { type: 'move', moveId: 'tackle' });
    const events = after.log.flatMap((t) => t.events);

    expect(events.some((e) => e.kind === 'paralyzed' && e.side === 'wild')).toBe(true);
    expect(after.mine.hp).toBe(after.mine.maxHp);
    expect(after.wild.hp).toBeLessThan(before.wild.hp);
  });

  it('能力阶级：crunch 降低野怪防御后同回合伤害更高（写入战斗状态）', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await seedPokemon(ctx.chain, 'ash', { id: 'p_crunch', speciesId: 25, level: 50, moves: ['crunch'] });

    const eventId = 'ev_wild_stage';
    // 追加效果掷点 < 20% → 防御 −1
    const clientSeed = findClientSeed(eventId, (s) => s.at(at(1, 'playerEffect')) < 0.2);
    await seedEncounter(ctx, eventId, { speciesId: 143, wildLevel: 30, clientSeed });

    const before = await ctx.wild.start(ash, eventId);
    const after = await ctx.wild.action(ash, before.sessionId, { type: 'move', moveId: 'crunch' });

    expect(after.wild.stages.def).toBe(-1);
    const statEvents = after.log.flatMap((t) => t.events).filter((e) => e.kind === 'stat');
    expect(statEvents).toHaveLength(1);
    expect(statEvents[0].detail).toMatchObject({ target: 'foe', stat: 'def', applied: -1, value: -1 });

    // 第 2 回合同招伤害高于第 1 回合（防御已 −1）
    const firstDamage = after.log.flatMap((t) => t.events).find((e) => e.kind === 'damage' && e.side === 'player')!
      .detail.damage as number;
    const second = await ctx.wild.action(ash, before.sessionId, { type: 'move', moveId: 'crunch' });
    const secondDamage = second.log.flatMap((t) => t.events).filter((e) => e.kind === 'damage' && e.side === 'player').at(-1)!
      .detail.damage as number;
    expect(secondDamage).toBeGreaterThan(firstDamage);
  });
});

describe('WildService: 换宠', () => {
  it('主动换宠消耗本回合：野怪出招一次，换入者吃当回合伤害', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await seedPokemon(ctx.chain, 'ash', { id: 'p_small', level: 5, moves: ['tackle'] });
    await seedPokemon(ctx.chain, 'ash', { id: 'p_tank', speciesId: 143, level: 40, moves: ['tackle'] });

    const eventId = 'ev_wild_switch';
    const clientSeed = findClientSeed(eventId, (s) => s.at(at(1, 'wildMove')) < 0.25 && s.at(at(1, 'wildHit')) < 0.9);
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 20, clientSeed });

    const started = await ctx.wild.start(ash, eventId, 'p_small');
    const after = await ctx.wild.action(ash, started.sessionId, { type: 'switch', targetPokemonId: 'p_tank' });

    expect(after.mine.pokemonId).toBe('p_tank');
    expect(after.activeIndex).toBe(0);
    expect(after.turn).toBe(2);
    expect(after.mine.hp).toBeLessThan(after.mine.maxHp);
    const events = after.log.flatMap((t) => t.events);
    expect(events.some((e) => e.kind === 'switch' && e.side === 'player' && e.detail.pokemonId === 'p_tank')).toBe(true);
    expect(events.some((e) => e.kind === 'move' && e.side === 'wild')).toBe(true);
    // 队伍面板：出战位跟随
    expect(after.party.find((p) => p.pokemonId === 'p_tank')!.active).toBe(true);
    expect(after.party.find((p) => p.pokemonId === 'p_small')!.active).toBe(false);

    // 错误：换到出战位 / 不在队伍 / 已倒下
    await expect(
      ctx.wild.action(ash, started.sessionId, { type: 'switch', targetPokemonId: 'p_tank' }),
    ).rejects.toThrow(/SWITCH_TO_ACTIVE/);
    await expect(
      ctx.wild.action(ash, started.sessionId, { type: 'switch', targetPokemonId: 'p_nobody' }),
    ).rejects.toThrow(/INVALID_SWITCH/);
    await patchSession(ctx, started.sessionId, (session) => {
      session.party.find((p: any) => p.pokemonId === 'p_small').hp = 0;
    });
    await expect(
      ctx.wild.action(ash, started.sessionId, { type: 'switch', targetPokemonId: 'p_small' }),
    ).rejects.toThrow(/SWITCH_TO_FAINTED/);
  });

  it('濒死强制换宠：MUST_SWITCH 拦截其它动作，换上后不再挨打并可继续战斗', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await seedPokemon(ctx.chain, 'ash', { id: 'p_weak', speciesId: 133, level: 2, moves: ['tackle'] });
    await seedPokemon(ctx.chain, 'ash', { id: 'p_tank', speciesId: 143, level: 40, moves: ['tackle'] });

    const eventId = 'ev_wild_forced_switch';
    const clientSeed = findClientSeed(eventId, (s) => s.at(at(1, 'wildMove')) < 0.2 && s.at(at(1, 'wildHit')) < 0.9);
    await seedEncounter(ctx, eventId, { speciesId: 149, wildLevel: 14, clientSeed });

    const started = await ctx.wild.start(ash, eventId, 'p_weak');
    const fainted = await ctx.wild.action(ash, started.sessionId, { type: 'move', moveId: 'tackle' });

    expect(fainted.mine.pokemonId).toBe('p_weak');
    expect(fainted.mine.hp).toBe(0);
    expect(fainted.finished).toBe(false);
    expect(fainted.status).toBe('ACTIVE');
    expect(fainted.mustSwitch).toBe(true);

    // 强制换宠期间只接受 switch
    await expect(ctx.wild.action(ash, started.sessionId, { type: 'move', moveId: 'tackle' })).rejects.toThrow(/MUST_SWITCH/);
    await expect(
      ctx.wild.action(ash, started.sessionId, { type: 'run' }),
    ).rejects.toThrow(/MUST_SWITCH/);

    const sent = await ctx.wild.action(ash, started.sessionId, { type: 'switch', targetPokemonId: 'p_tank' });
    expect(sent.mustSwitch).toBe(false);
    expect(sent.finished).toBe(false);
    expect(sent.mine.pokemonId).toBe('p_tank');
    expect(sent.mine.hp).toBe(sent.mine.maxHp); // 强制换宠不额外挨打
    expect(sent.log.flatMap((t) => t.events).some((e) => e.kind === 'switch' && e.detail.forced === true)).toBe(true);

    // 之后可以正常出招（回合继续推进）
    const next = await ctx.wild.action(ash, started.sessionId, { type: 'move', moveId: 'tackle' });
    expect(next.turn).toBe(sent.turn + 1);
    expect(next.wild.hp).toBeLessThanOrEqual(sent.wild.hp);
  });
});

describe('WildService: 野怪羁绊（收服 +1、每日每宠 +6；击倒不给，docs/backend-api.md §2/§11）', () => {
  it('收服成功给出战宝可梦 +1 羁绊：链上持久化 + 状态返回 bondGain', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const ball = await mintBall(ctx.contract, 'ash', 'i_ball_bond', 'poke-ball', 3);
    await seedPokemon(ctx.chain, 'ash', { id: 'p_bond_hero', level: 30, moves: ['tackle'], bond: 50 });

    const eventId = 'ev_wild_bond_catch';
    const clientSeed = findClientSeed(eventId, (s) => s.at(BALL_ROLL(1)) < 0.24);
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 12, clientSeed });

    const started = await ctx.wild.start(ash, eventId);
    const caught = await ctx.wild.action(ash, started.sessionId, { type: 'ball', ballItemId: ball.id });

    expect(caught.status).toBe('CAUGHT');
    expect(caught.bondGain).toBe(1);
    expect(caught.bondGainBy).toBe('p_bond_hero');
    expect(caught.mine.bond).toBe(51); // 状态里出战宝可梦的羁绊同步更新
    expect((await ctx.contract.getPokemon('p_bond_hero')).bond).toBe(51);

    // 重放已结束的会话：不再加羁绊（幂等键 <sessionId>-bond-catch）
    await ctx.wild.action(ash, started.sessionId, { type: 'ball', ballItemId: ball.id });
    expect((await ctx.contract.getPokemon('p_bond_hero')).bond).toBe(51);
    // 直接重放同一次挂钩（同一 sessionId）也不会叠加
    const replay = await makeBondService(ctx.contract).grantWildBond({
      sessionId: started.sessionId,
      playerId: 'ash',
      pokemonId: 'p_bond_hero',
      kind: 'catch',
    });
    expect(replay?.after).toBe(51);
    expect((await ctx.contract.getPokemon('p_bond_hero')).bond).toBe(51);
  });

  it('击倒野怪不再给羁绊（BOND_WILD_FAINT = 0：陪伴只奖励收服）', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await seedPokemon(ctx.chain, 'ash', {
      id: 'p_bond_ko',
      speciesId: 149,
      level: 60,
      moves: ['hyper-beam'],
      bond: 100,
    });

    const eventId = 'ev_wild_bond_ko';
    const clientSeed = findClientSeed(eventId, (s) => s.at(at(1, 'playerHit')) < 0.85 && s.at(at(1, 'playerFactor')) < 0.5);
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 3, clientSeed });

    const started = await ctx.wild.start(ash, eventId);
    const after = await ctx.wild.action(ash, started.sessionId, { type: 'move', moveId: 'hyper-beam' });

    expect(after.status).toBe('WILD_FAINTED');
    expect(after.bondGain).toBe(0);
    expect(after.bondGainBy).toBeNull();
    expect((await ctx.contract.getPokemon('p_bond_ko')).bond).toBe(100);

    // 直接调用同一场击倒挂钩也返回 null（不给羁绊）
    expect(
      await makeBondService(ctx.contract).grantWildBond({
        sessionId: started.sessionId,
        playerId: 'ash',
        pokemonId: 'p_bond_ko',
        kind: 'faint',
      }),
    ).toBeNull();
  });

  it('每日每宠上限 +6：同一只宝可梦当天第 7 次收服不再涨（reason 不变）', async () => {
    const ctx = build();
    const bond = makeBondService(ctx.contract);
    await registerPlayers(ctx.contract, 'ash');
    await seedPokemon(ctx.chain, 'ash', { id: 'p_bond_daily', bond: 50 });

    for (let i = 1; i <= 6; i += 1) {
      const granted = await bond.grantWildBond({
        sessionId: `w_daily_${i}`,
        playerId: 'ash',
        pokemonId: 'p_bond_daily',
        kind: 'catch',
      });
      expect(granted?.delta).toBe(1);
    }
    expect((await ctx.contract.getPokemon('p_bond_daily')).bond).toBe(56);

    // 第 7、8 次：当日额度已满 → 返回 null，链上不动
    expect(
      await bond.grantWildBond({ sessionId: 'w_daily_7', playerId: 'ash', pokemonId: 'p_bond_daily', kind: 'catch' }),
    ).toBeNull();
    expect(
      await bond.grantWildBond({ sessionId: 'w_daily_8', playerId: 'ash', pokemonId: 'p_bond_daily', kind: 'catch' }),
    ).toBeNull();
    expect((await ctx.contract.getPokemon('p_bond_daily')).bond).toBe(56);

    // 上限是"每宠"，不是"每账号"：另一只当天仍可正常 +1
    await seedPokemon(ctx.chain, 'ash', { id: 'p_bond_daily_other', bond: 50 });
    const other = await bond.grantWildBond({
      sessionId: 'w_daily_other',
      playerId: 'ash',
      pokemonId: 'p_bond_daily_other',
      kind: 'catch',
    });
    expect(other?.delta).toBe(1);
    expect((await ctx.contract.getPokemon('p_bond_daily_other')).bond).toBe(51);
  });

  it('羁绊挂钩的边界：易主/放生的宝可梦不加（返回 null），255 封顶', async () => {
    const ctx = build();
    const bond = makeBondService(ctx.contract);
    await registerPlayers(ctx.contract, 'ash', 'gary');
    await seedPokemon(ctx.chain, 'ash', { id: 'p_bond_moved', bond: 50 });
    await seedPokemon(ctx.chain, 'ash', { id: 'p_bond_cap', bond: 254 });

    // 易主（链上 bond 重置为 30）：原 owner 的发奖请求不再命中
    await ctx.contract.transferPokemon(userIdentity('ash'), 'p_bond_moved', 'gary');
    expect(
      await bond.grantWildBond({ sessionId: 'w_moved', playerId: 'ash', pokemonId: 'p_bond_moved', kind: 'catch' }),
    ).toBeNull();
    expect((await ctx.contract.getPokemon('p_bond_moved')).bond).toBe(30);

    // 放生：同样跳过
    await ctx.contract.releasePokemon(userIdentity('ash'), 'p_bond_cap');
    expect(
      await bond.grantWildBond({ sessionId: 'w_released', playerId: 'ash', pokemonId: 'p_bond_cap', kind: 'catch' }),
    ).toBeNull();

    // 255 上限：链上截断，delta 反映真实增量
    await seedPokemon(ctx.chain, 'ash', { id: 'p_bond_full', bond: 254 });
    const granted = await bond.grantWildBond({
      sessionId: 'w_full',
      playerId: 'ash',
      pokemonId: 'p_bond_full',
      kind: 'catch',
    });
    expect(granted?.after).toBe(255);
    expect(granted?.delta).toBe(1);
  });
});
