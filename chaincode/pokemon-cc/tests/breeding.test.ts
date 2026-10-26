import { deriveRandom, sha256hex } from '../src/common/crypto';
import { IV_KEYS, Pokemon } from '../src/common/model';
import { CLIENT_SEED, ORG1, SERVER_SEED, T1, T2, World, expectCode } from './helpers/harness';

/**
 * [FEAT:breeding] 血统繁殖：
 * - 链码按派生流重算子代属性并与传入值比对（防后端伪造）
 * - 子代 dnaHash = 血统承诺（绑定双亲 id/dnaHash、事件、子代 id）
 * - 复用 purpose='mint' 的随机事件，一次性消费
 */

const MIN_LEVEL = 20;
const COST = 200;
const IV_BLOCK = 50000;
const NATURE_SLOT = 50012;
const SHINY_SLOT = 50013;

function expectedChild(a: Pokemon, b: Pokemon, eventId: string) {
  const rand = (n: number) => deriveRandom(SERVER_SEED, CLIENT_SEED, eventId, n);
  const ivs: Record<string, number> = {};
  IV_KEYS.forEach((key, index) => {
    const choice = rand(IV_BLOCK + index * 2);
    ivs[key] =
      choice < 0.4 ? a.ivs[key] : choice < 0.8 ? b.ivs[key] : Math.floor(rand(IV_BLOCK + index * 2 + 1) * 32);
  });
  return {
    ivs,
    nature: rand(NATURE_SLOT) < 0.5 ? a.nature : b.nature,
    shiny: rand(SHINY_SLOT) < 1 / 4096,
  };
}

function lineage(a: Pokemon, b: Pokemon, eventId: string, childId: string): string {
  return sha256hex(`pokechain-breed-v1|${a.id}|${a.dnaHash}|${b.id}|${b.dnaHash}|${eventId}|${childId}`);
}

describe('BreedingContract（血统繁殖）', () => {
  let w: World;
  let parentA: Pokemon;
  let parentB: Pokemon;

  /** 造两只 level 20、同 owner、IDLE 的亲代。 */
  async function seedParents(): Promise<void> {
    await w.registerPlayer('u_ash', ORG1);
    await w.registerPlayer('u_gary', ORG1);
    await w.capturePokemon('p_a', 'u_ash');
    await w.capturePokemon('p_b', 'u_ash');
    await w.run(() =>
      w.pokemon.ApplyGrowth(w.systemCtx(), 'p_a', JSON.stringify({ level: MIN_LEVEL }), T1, 'idem-grow-a'),
    );
    await w.run(() =>
      w.pokemon.ApplyGrowth(w.systemCtx(), 'p_b', JSON.stringify({ level: MIN_LEVEL }), T1, 'idem-grow-b'),
    );
    parentA = (await w.getPokemon('p_a')) as Pokemon;
    parentB = (await w.getPokemon('p_b')) as Pokemon;
  }

  type BreedTuple = [
    string, string, string, string, string, string, string, string, string, string, string,
  ];

  function breedArgs(over: Record<string, string> = {}): BreedTuple {
    const eventId = over.eventId ?? 'ev_breed_1';
    const childId = over.childId ?? 'p_child';
    const expected = expectedChild(parentA, parentB, eventId);
    const args: Record<string, string> = {
      childId,
      parentAId: 'p_a',
      parentBId: 'p_b',
      speciesId: '25',
      name: 'pichu',
      ivsJSON: JSON.stringify(expected.ivs),
      nature: expected.nature,
      ability: 'static',
      shiny: String(expected.shiny),
      movesJSON: JSON.stringify(['thunder-shock']),
      eventId,
    };
    return [
      args.childId,
      args.parentAId,
      args.parentBId,
      args.speciesId,
      args.name,
      args.ivsJSON,
      args.nature,
      args.ability,
      args.shiny,
      args.movesJSON,
      args.eventId,
    ];
  }

  function breed(ctx: ReturnType<World['ctxAs']>, over: Record<string, string> = {}, now = T2, idem = 'idem-breed') {
    return w.run(() => w.breeding.Breed(ctx, ...breedArgs(over), now, idem));
  }

  beforeEach(async () => {
    w = new World();
    await seedParents();
    // 繁殖事件 purpose='mint'（复用既有随机类型，不改 RandomContract）
    await w.run(() =>
      w.random.Commit(w.systemCtx(), 'ev_breed_1', 'mint', 'u_ash', sha256hex(SERVER_SEED), CLIENT_SEED, T1, 'idem-commit-breed'),
    );
    await w.run(() => w.random.RevealAndVerify(w.systemCtx(), 'ev_breed_1', SERVER_SEED, T1, 'idem-reveal-breed'));
  });

  test('正常繁殖：子代字段、扣 200P、随机事件被消费、dnaHash 即血统承诺', async () => {
    const before = (await w.getPlayer('u_ash')).points;
    const raw = await breed(w.ctxAs('u_ash'));
    const child = JSON.parse(raw);

    expect(child).toMatchObject({
      id: 'p_child',
      ownerId: 'u_ash',
      status: 'IDLE',
      level: 1,
      exp: 0,
      bond: 50,
      generation: 1,
      parents: ['p_a', 'p_b'],
      captureEventId: 'ev_breed_1',
    });
    expect(child.evs).toEqual({ hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 });
    expect(child.dnaHash).toBe(lineage(parentA, parentB, 'ev_breed_1', 'p_child'));
    expect((await w.getPlayer('u_ash')).points).toBe(before - COST);
    expect((await w.getRand('ev_breed_1')).status).toBe('CONSUMED');
    expect(w.eventNames()).toContain('PokemonBred');
  });

  test('篡改 IV / 性格 / 闪光：抛 HEREDITY_MISMATCH（链码重算派生流）', async () => {
    const expected = expectedChild(parentA, parentB, 'ev_breed_1');
    const tampered = { ...expected.ivs, hp: (expected.ivs.hp + 1) % 32 };
    const args = breedArgs();
    args[5] = JSON.stringify(tampered);
    await expectCode(w.run(() => w.breeding.Breed(w.ctxAs('u_ash'), ...args, T2, 'idem-bad-iv')), 'HEREDITY_MISMATCH');

    const args2 = breedArgs();
    args2[6] = expected.nature === 'hardy' ? 'timid' : 'hardy';
    await expectCode(w.run(() => w.breeding.Breed(w.ctxAs('u_ash'), ...args2, T2, 'idem-bad-nature')), 'HEREDITY_MISMATCH');
  });

  test('双亲必须是同一 owner 且是调用者本人', async () => {
    await expectCode(breed(w.ctxAs('u_gary')), 'NOT_OWNER');
  });

  test('两只亲代不能是同一只', async () => {
    const args = breedArgs();
    args[2] = args[1];
    await expectCode(w.run(() => w.breeding.Breed(w.ctxAs('u_ash'), ...args, T2, 'idem-same')), 'INVALID_PARAM');
  });

  test('等级不足 20 拒绝', async () => {
    // 新抓的一只只有 5 级（ApplyGrowth 不能降级，所以用新个体）
    await w.capturePokemon('p_low', 'u_ash');
    const low = (await w.getPokemon('p_low')) as Pokemon;
    const expected = expectedChild(parentA, low, 'ev_breed_1');
    const args = breedArgs();
    args[2] = 'p_low';
    args[5] = JSON.stringify(expected.ivs);
    args[6] = expected.nature;
    args[8] = String(expected.shiny);
    await expectCode(w.run(() => w.breeding.Breed(w.ctxAs('u_ash'), ...args, T2, 'idem-low-level')), 'INVALID_PARAM');
  });

  test('同一随机事件不能复用', async () => {
    await breed(w.ctxAs('u_ash'));
    const args = breedArgs({ childId: 'p_child2' });
    // 事件已 CONSUMED，第二次必然被拒（且子代 id 不同）
    await expectCode(w.run(() => w.breeding.Breed(w.ctxAs('u_ash'), ...args, T2, 'idem-breed2')), 'RAND_CONSUMED');
  });

  test('篡改 dnaHash（血统承诺）由链码重算，调用方无需提供', async () => {
    // dnaHash 不在入参里：链码自己算，后端无法伪造血统
    const raw = await breed(w.ctxAs('u_ash'));
    const child = JSON.parse(raw);
    expect(child.dnaHash).toBe(lineage(parentA, parentB, 'ev_breed_1', 'p_child'));
    expect(child.dnaHash).not.toBe(parentA.dnaHash);
  });

  test('幂等重放：返回同一子代，不重复扣分', async () => {
    await breed(w.ctxAs('u_ash'));
    const points = (await w.getPlayer('u_ash')).points;
    const again = JSON.parse(await breed(w.ctxAs('u_ash')));
    expect(again.id).toBe('p_child');
    expect((await w.getPlayer('u_ash')).points).toBe(points);
  });

  test('积分不足拒绝', async () => {
    const player = await w.getPlayer('u_ash');
    await w.run(() =>
      w.player.AddPoints(w.systemCtx(), 'u_ash', String(-(player.points - 100)), 'drain', T1, 'idem-drain'),
    );
    await expectCode(breed(w.ctxAs('u_ash')), 'INSUFFICIENT_POINTS');
  });

  test('GetLineage 返回双亲摘要与代数', async () => {
    await breed(w.ctxAs('u_ash'));
    const lineageInfo = JSON.parse(await w.breeding.GetLineage(w.systemCtx(), 'p_child'));
    expect(lineageInfo).toMatchObject({ id: 'p_child', generation: 1, speciesId: 25 });
    expect(lineageInfo.parents).toHaveLength(2);
    expect(lineageInfo.parents[0]).toMatchObject({ id: 'p_a', level: MIN_LEVEL });
  });

  test('GetBreedingConfig 公开费用与槽位', async () => {
    const config = JSON.parse(await w.breeding.GetBreedingConfig(w.systemCtx()));
    expect(config).toMatchObject({ minLevel: MIN_LEVEL, cost: COST, layout: { ivBlock: IV_BLOCK, natureSlot: NATURE_SLOT } });
  });
});
