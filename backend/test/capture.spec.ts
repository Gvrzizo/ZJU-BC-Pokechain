import { DeriveStream, sha256hex } from '../src/common/utils/crypto.util';
import { CaptureService } from '../src/pokemon/capture.service';
import { deriveAttempt, deriveWild, deriveWildSpecimen } from '../src/pokemon/capture-derive';
import { evolutionStage, getZone } from '../src/game-data/encounter.data';
import { getSpecies } from '../src/game-data/species.data';
import {
  SYSTEM_IDENTITY,
  makeChain,
  makeRedis,
  mintBall,
  registerPlayers,
  seedPokemon,
  userIdentity,
} from './helpers';

const SERVER_SEED = 'aa'.repeat(32);
const CLIENT_SEED = 'bb'.repeat(16);

async function setupEncounter(
  capture: CaptureService,
  chain: ReturnType<typeof makeChain>['contract'],
  redis: ReturnType<typeof makeRedis>,
  eventId: string,
  speciesId = 25,
  wildLevel = 10,
) {
  const ash = userIdentity('ash');
  await chain.commitRandom(ash, {
    eventId,
    purpose: 'capture',
    playerId: 'ash',
    commitHash: sha256hex(SERVER_SEED),
    clientSeed: CLIENT_SEED,
  });
  await redis.setJson(`capture:${eventId}`, {
    playerId: 'ash',
    serverSeed: SERVER_SEED,
    clientSeed: CLIENT_SEED,
    attempts: 0,
    speciesId,
    wildLevel,
  });
}

describe('random derivation (chaincode-api.md §2.2)', () => {
  it('matches the golden HMAC-SHA256 vector', () => {
    const stream = new DeriveStream('11'.repeat(32), '22'.repeat(8), 'ev_golden');
    expect(stream.at(0)).toBeCloseTo(0.3378360315934103, 12);
    expect(stream.at(1)).toBeCloseTo(0.32338724448446265, 12);
    expect(stream.at(2)).toBeCloseTo(0.7529760260409906, 12);
  });
});

describe('CaptureService (mock chain)', () => {
  it('full encounter -> attempt -> mint flow with deterministic capture', async () => {
    const { chain, contract } = makeChain();
    const redis = makeRedis();
    const capture = new CaptureService(chain, contract, redis);
    await registerPlayers(contract, 'ash');
    const ball = await mintBall(contract, 'ash', 'i_ball_ok', 'poke-ball', 3);

    const ash = userIdentity('ash');
    // encounter through the service: commit happens on-chain before derivation
    const enc = await capture.encounter(ash, CLIENT_SEED);
    expect(enc.commitHash).toMatch(/^[0-9a-f]{64}$/);
    const committed = await contract.getRandom(enc.eventId);
    expect(committed.status).toBe('COMMITTED');
    expect(committed.purpose).toBe('capture');
    // 缺省区域 = 101 号道路·草丛（初始区）：Lv2-6、只出未进化型（docs/backend-api.md §2 区域与栖息地野生池）
    expect(enc.zone.id).toBe('route-grass');
    expect(enc.zone.minLevel).toBe(2);
    expect(enc.zone.maxLevel).toBe(6);
    expect(enc.wild.level).toBeGreaterThanOrEqual(2);
    expect(enc.wild.level).toBeLessThanOrEqual(6);
    expect(evolutionStage(enc.wild.speciesId)).toBe(0);
    // 派生可复算：响应与会话里的 serverSeed 重建派生流，n=0/n=1 对得上
    const session = await redis.getJson<{ serverSeed: string }>(`capture:${enc.eventId}`);
    const stream0 = new DeriveStream(session!.serverSeed, enc.clientSeed!, enc.eventId);
    const south = getZone('route-grass')!;
    const derived0 = deriveWild(stream0, south, 0);
    expect(enc.wild.speciesId).toBe(derived0.species.id);
    expect(enc.wild.level).toBe(derived0.level);

    // deterministic attempt on a pre-seeded event whose catch roll < catchRate
    const eventId = 'ev_test_0'; // roll at n=2 is 0.1877 < 0.35 (pikachu, poke-ball)
    await setupEncounter(capture, contract, redis, eventId, 25, 10);
    const res = await capture.attempt(ash, eventId, ball.id);
    expect(res.success).toBe(true);
    if (!res.success) throw new Error('expected capture success');

    const pikachu = getSpecies(25);
    const stream = new DeriveStream(SERVER_SEED, CLIENT_SEED, eventId);
    const derived = deriveAttempt(stream, 1, pikachu.catchRate, 1);
    expect(res.pokemon.ownerId).toBe('ash');
    expect(res.pokemon.speciesId).toBe(25);
    expect(res.pokemon.ivs).toEqual(derived.ivs);
    expect(res.pokemon.nature).toBe(derived.nature);
    expect(res.pokemon.level).toBe(10); // wild level applied after mint
    expect(res.pokemon.moves.length).toBeGreaterThan(0);

    // ball consumed, random event consumed
    expect((await contract.getItem(ball.id)).quantity).toBe(2);
    expect((await contract.getRandom(eventId)).status).toBe('CONSUMED');
  });

  it('failed capture returns shakes, consumes the ball, keeps the event REVEALED for retry', async () => {
    const { chain, contract } = makeChain();
    const redis = makeRedis();
    const capture = new CaptureService(chain, contract, redis);
    await registerPlayers(contract, 'ash');
    const ball = await mintBall(contract, 'ash', 'i_ball_fail', 'poke-ball', 2);

    const ash = userIdentity('ash');
    const eventId = 'ev_test_1'; // roll at n=2 is 0.5286 >= 0.35 -> fail
    await setupEncounter(capture, contract, redis, eventId, 25, 5);
    const res = await capture.attempt(ash, eventId, ball.id);
    expect(res.success).toBe(false);
    if (res.success) throw new Error('expected failure');
    expect(res.shakes).toBeGreaterThanOrEqual(1);
    expect(res.shakes).toBeLessThanOrEqual(3);
    expect((await contract.getItem(ball.id)).quantity).toBe(1);
    expect((await contract.getRandom(eventId)).status).toBe('REVEALED');

    // a second attempt on the same event must not re-reveal and uses the next block
    const res2 = await capture.attempt(ash, eventId, ball.id);
    const stream = new DeriveStream(SERVER_SEED, CLIENT_SEED, eventId);
    const derived2 = deriveAttempt(stream, 2, getSpecies(25).catchRate, 1);
    expect(res2.success).toBe(derived2.success);
    expect((await contract.getItem(ball.id)).quantity).toBe(0);
  });

  it('rejects reveal with a wrong serverSeed (SEED_MISMATCH)', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash');
    const ash = userIdentity('ash');
    await contract.commitRandom(ash, {
      eventId: 'ev_mismatch',
      purpose: 'capture',
      playerId: 'ash',
      commitHash: sha256hex(SERVER_SEED),
      clientSeed: CLIENT_SEED,
    });
    // 揭示只能由 system 发起（链上 RevealAndVerify 的权限）；serverSeed 不匹配仍是 SEED_MISMATCH
    await expect(
      contract.revealAndVerify(SYSTEM_IDENTITY, 'ev_mismatch', 'ff'.repeat(32)),
    ).rejects.toThrow(/SEED_MISMATCH/);
  });

  it('rejects capture with someone else\'s ball (NOT_OWNER)', async () => {
    const { chain, contract } = makeChain();
    const redis = makeRedis();
    const capture = new CaptureService(chain, contract, redis);
    await registerPlayers(contract, 'ash', 'gary');
    const garyBall = await mintBall(contract, 'gary', 'i_ball_gary', 'poke-ball', 1);
    await setupEncounter(capture, contract, redis, 'ev_owner', 25, 5);
    await expect(capture.attempt(userIdentity('ash'), 'ev_owner', garyBall.id)).rejects.toThrow(/NOT_OWNER/);
  });
});

describe('CaptureService: 区域等级带 + 付费诱饵（docs/backend-api.md §2）', () => {
  const ash = userIdentity('ash');

  it('区域等级带：route-grass 恒 Lv2-6，队伍等级不参与（与队伍最高等级彻底脱钩）', async () => {
    const { chain, contract } = makeChain();
    const redis = makeRedis();
    const capture = new CaptureService(chain, contract, redis);
    await registerPlayers(contract, 'ash');
    // 队伍里放一只 Lv50：旧模型会让野怪在 Lv48-52 出没，新模型只认区域
    await seedPokemon(chain, 'ash', { id: 'p_top', level: 50 });
    await seedPokemon(chain, 'ash', { id: 'p_locked', level: 99, status: 'LOCKED_BATTLE' });

    const enc = await capture.encounter(ash, CLIENT_SEED);
    expect(enc.zone.id).toBe('route-grass');
    expect(enc.wild.level).toBeGreaterThanOrEqual(2);
    expect(enc.wild.level).toBeLessThanOrEqual(6);
    expect(evolutionStage(enc.wild.speciesId)).toBe(0);
    expect(enc.lure).toEqual({ tier: 0, cost: 0, levelBonus: 0, shinyMultiplier: 1 });
    // 免费档同样把区域写进 Commit.meta（审计据此复算 n=0/n=1），且写的是规范 id
    expect(JSON.parse((await contract.getRandom(enc.eventId)).meta)).toEqual({ zone: 'route-grass' });

    // 指定 route-mid：等级带整体抬到 Lv8-16，仍然与 Lv50 队伍无关
    const mid = await capture.encounter(ash, CLIENT_SEED, 0, 'route-mid');
    expect(mid.zone).toMatchObject({ id: 'route-mid', name: '104 号道路·丘陵', minLevel: 8, maxLevel: 16, maxStage: 1 });
    expect(mid.wild.level).toBeGreaterThanOrEqual(8);
    expect(mid.wild.level).toBeLessThanOrEqual(16);
    expect(evolutionStage(mid.wild.speciesId)).toBeLessThanOrEqual(1);

    // 旧别名 mid 归一为规范 id（响应与会话都记规范 id）
    const alias = await capture.encounter(ash, CLIENT_SEED, 0, 'mid');
    expect(alias.zone.id).toBe('route-mid');
    expect(JSON.parse((await contract.getRandom(alias.eventId)).meta)).toEqual({ zone: 'route-mid' });

    // route-north 可出二阶段进化型，等级带 Lv17-28
    const north = await capture.encounter(ash, CLIENT_SEED, 0, 'route-north');
    expect(north.zone).toMatchObject({ id: 'route-north', minLevel: 17, maxLevel: 28, maxStage: 2 });
    expect(north.wild.level).toBeGreaterThanOrEqual(17);
    expect(north.wild.level).toBeLessThanOrEqual(28);
    // 可复算：会话里的 serverSeed 重建派生流
    const session = await redis.getJson<{ serverSeed: string; zoneId: string }>(`capture:${north.eventId}`);
    expect(session!.zoneId).toBe('route-north');
    const derived = deriveWild(new DeriveStream(session!.serverSeed, north.clientSeed!, north.eventId), getZone('route-north')!);
    expect(north.wild.speciesId).toBe(derived.species.id);
    expect(north.wild.level).toBe(derived.level);
  });

  it('非法 zoneId 拒绝（INVALID_ZONE），不建事件', async () => {
    const { chain, contract } = makeChain();
    const redis = makeRedis();
    const capture = new CaptureService(chain, contract, redis);
    await registerPlayers(contract, 'ash');
    await expect(capture.encounter(ash, CLIENT_SEED, 0, 'south-2')).rejects.toThrow(/INVALID_ZONE/);
    await expect(capture.encounter(ash, CLIENT_SEED, 0, 'east')).rejects.toThrow(/INVALID_ZONE/);
  });

  it('tier 1/2 诱饵：带内 +2/+5 且封顶 zone.maxLevel，扣积分并在 Commit.meta 留痕（可审计）', async () => {
    const { chain, contract } = makeChain();
    const redis = makeRedis();
    const capture = new CaptureService(chain, contract, redis);
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', { id: 'p_top', level: 50 });

    // 草丛（Lv2-6）：+2 仍在带内，+5 必然被封到上界 6
    const t1 = await capture.encounter(ash, CLIENT_SEED, 1, 'route-grass');
    expect(t1.wild.level).toBeGreaterThanOrEqual(4);
    expect(t1.wild.level).toBeLessThanOrEqual(6);
    expect(t1.lure).toEqual({ tier: 1, cost: 50, levelBonus: 2, shinyMultiplier: 1 });
    expect((await contract.getPlayer('ash')).points).toBe(950);
    expect(JSON.parse((await contract.getRandom(t1.eventId)).meta)).toEqual({
      zone: 'route-grass',
      lureTier: 1,
      cost: 50,
    });

    // 冠军之路（Lv17-28）：+5 抬到 22-28，封顶 28
    const t2 = await capture.encounter(ash, CLIENT_SEED, 2, 'route-north');
    expect(t2.wild.level).toBeGreaterThanOrEqual(22);
    expect(t2.wild.level).toBeLessThanOrEqual(28);
    expect(t2.lure).toEqual({ tier: 2, cost: 200, levelBonus: 5, shinyMultiplier: 4 });
    expect((await contract.getPlayer('ash')).points).toBe(750);
    expect(JSON.parse((await contract.getRandom(t2.eventId)).meta)).toEqual({
      zone: 'route-north',
      lureTier: 2,
      cost: 200,
    });

    // 会话记下闪光阈值（tier 2 → 1/1024），后续快速捕捉/野怪战斗都用它
    const session = await redis.getJson<{ shinyChance: number; lureTier: number }>(`capture:${t2.eventId}`);
    expect(session!.lureTier).toBe(2);
    expect(session!.shinyChance).toBeCloseTo(1 / 1024, 12);
  });

  it('余额不足拒绝（INSUFFICIENT_POINTS）且不扣分、不建事件', async () => {
    const { chain, contract } = makeChain();
    const redis = makeRedis();
    const capture = new CaptureService(chain, contract, redis);
    await registerPlayers(contract, 'ash');
    const balance = (await contract.getPlayer('ash')).points;
    await contract.addPoints(SYSTEM_IDENTITY, 'ash', -(balance - 10), 'sink');

    await expect(capture.encounter(ash, CLIENT_SEED, 2)).rejects.toThrow(/INSUFFICIENT_POINTS/);
    expect((await contract.getPlayer('ash')).points).toBe(10);
  });

  it('非法诱饵档位拒绝（INVALID_LURE_TIER）', async () => {
    const { chain, contract } = makeChain();
    const redis = makeRedis();
    const capture = new CaptureService(chain, contract, redis);
    await registerPlayers(contract, 'ash');
    await expect(capture.encounter(ash, CLIENT_SEED, 3)).rejects.toThrow(/INVALID_LURE_TIER/);
    await expect(capture.encounter(ash, CLIENT_SEED, -1)).rejects.toThrow(/INVALID_LURE_TIER/);
  });

  it('tier 2 的闪光阈值 ×4：1/4096 与 1/1024 之间的掷点在诱饵下才算闪光', () => {
    // 找一条 d=20007 槽位落在 [1/4096, 1/1024) 的流（期望约 1400 次命中）
    let clientSeed = '';
    for (let i = 0; i < 200_000; i++) {
      const candidate = i.toString(16).padStart(16, '0');
      const roll = new DeriveStream(SERVER_SEED, candidate, 'ev_lure_shiny').at(20007);
      if (roll >= 1 / 4096 && roll < 1 / 1024) {
        clientSeed = candidate;
        break;
      }
    }
    expect(clientSeed).not.toBe('');
    const stream = new DeriveStream(SERVER_SEED, clientSeed, 'ev_lure_shiny');
    expect(deriveWildSpecimen(stream).shiny).toBe(false);
    expect(deriveWildSpecimen(stream, 1 / 1024).shiny).toBe(true);
  });
});
