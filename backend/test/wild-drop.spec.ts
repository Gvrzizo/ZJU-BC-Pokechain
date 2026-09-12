import { DeriveStream, sha256hex } from '../src/common/utils/crypto.util';
import { CaptureService } from '../src/pokemon/capture.service';
import {
  WILD_DROP_BASE,
  WILD_DROP_CHANCE,
  deriveWildDrop,
} from '../src/pokemon/capture-derive';
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

type DropBand = 'none' | 'potion' | 'poke-ball' | 'great-ball';

/** 掉落区派生结果 → 品类（与 docs/randomness.md §3 的 40000 区约定一致，测试独立复算） */
function bandOf(stream: DeriveStream): DropBand {
  if (!(stream.at(WILD_DROP_BASE) < WILD_DROP_CHANCE)) return 'none';
  const roll = stream.at(WILD_DROP_BASE + 1);
  if (roll < 0.6) return 'potion';
  if (roll < 0.9) return 'poke-ball';
  return 'great-ball';
}

/** 找一个落到指定掉落品类的 clientSeed（clientSeed 本身是自由输入，测试用它固定派生流）。 */
function clientSeedFor(eventId: string, band: DropBand): string {
  for (let i = 0; i < 50_000; i++) {
    const clientSeed = i.toString(16).padStart(16, '0');
    if (bandOf(new DeriveStream(SERVER_SEED, clientSeed, eventId)) === band) return clientSeed;
  }
  throw new Error(`no client seed dropping ${band} for ${eventId}`);
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

async function patchSession(ctx: ReturnType<typeof build>, sessionId: string, patch: (s: any) => void) {
  const session = (await loadWildSession(ctx.redis, sessionId))!;
  patch(session);
  await ctx.redis.setJson(wildSessionKey(sessionId), session, 900);
}

const ash = userIdentity('ash');
const itemsOf = (ctx: ReturnType<typeof build>, typeId?: string) =>
  ctx.contract
    .queryItemsByOwner('ash')
    .then((items) => (typeId ? items.filter((i) => i.typeId === typeId) : items));

describe('战斗掉落派生（40000 区，docs/randomness.md §3）', () => {
  it('+0 决定是否掉落（20%），+1 决定品类（60/30/10）', () => {
    const eventId = 'ev_drop_bands';
    for (const band of ['potion', 'poke-ball', 'great-ball'] as const) {
      const clientSeed = clientSeedFor(eventId, band);
      const drop = deriveWildDrop(new DeriveStream(SERVER_SEED, clientSeed, eventId));
      expect(drop).toEqual({ typeId: band, quantity: 1 });
    }
    const noneSeed = clientSeedFor(eventId, 'none');
    expect(deriveWildDrop(new DeriveStream(SERVER_SEED, noneSeed, eventId))).toBeNull();
  });
});

describe('战斗掉落：收服成功与击倒野怪（wild.service.ts）', () => {
  it('收服成功：按派生流掉落到背包（MintItem 自动合并），状态返回 drop 字段', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const master = await mintBall(ctx.contract, 'ash', 'i_master_drop', 'master-ball', 1);
    await seedPokemon(ctx.chain, 'ash', { id: 'p_drop_hero', level: 20, moves: ['tackle'] });

    const eventId = 'ev_drop_catch';
    const clientSeed = clientSeedFor(eventId, 'poke-ball');
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 8, clientSeed });
    const started = await ctx.wild.start(ash, eventId);

    const caught = await ctx.wild.action(ash, started.sessionId, { type: 'ball', ballItemId: master.id });
    expect(caught.status).toBe('CAUGHT');
    expect(caught.drop).toMatchObject({ typeId: 'poke-ball', quantity: 1 });
    expect(caught.drop.nameZh).toBe('精灵球');

    const balls = await itemsOf(ctx, 'poke-ball');
    expect(balls.reduce((n, i) => n + i.quantity, 0)).toBe(1);
    expect(balls[0].status).toBe('IDLE');

    // 会话已结束：重放动作只返回终态，不会重复掉落
    const replay = await ctx.wild.action(ash, started.sessionId, { type: 'ball', ballItemId: master.id });
    expect(replay.finished).toBe(true);
    expect((await itemsOf(ctx, 'poke-ball')).reduce((n, i) => n + i.quantity, 0)).toBe(1);
  });

  it('掉落物与同 typeId 的既有堆叠自动合并', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const master = await mintBall(ctx.contract, 'ash', 'i_master_merge', 'master-ball', 1);
    await mintBall(ctx.contract, 'ash', 'i_own_potion', 'potion', 2);
    await seedPokemon(ctx.chain, 'ash', { id: 'p_merge_hero', level: 20, moves: ['tackle'] });

    const eventId = 'ev_drop_merge';
    const clientSeed = clientSeedFor(eventId, 'potion');
    await seedEncounter(ctx, eventId, { speciesId: 25, wildLevel: 5, clientSeed });
    const started = await ctx.wild.start(ash, eventId);
    const caught = await ctx.wild.action(ash, started.sessionId, { type: 'ball', ballItemId: master.id });

    expect(caught.drop).toMatchObject({ typeId: 'potion', quantity: 1 });
    const stacks = await itemsOf(ctx, 'potion');
    expect(stacks).toHaveLength(1); // 2 + 1 合并为一个堆叠
    expect(stacks[0].quantity).toBe(3);
  });

  it('击倒野怪：同样掉落；不掉落的派生流返回 drop=null 且背包不变', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await seedPokemon(ctx.chain, 'ash', { id: 'p_faint_hero', speciesId: 149, level: 60, moves: ['tackle'] });

    // 掉落场次
    const dropEvent = 'ev_drop_faint';
    const dropSeed = clientSeedFor(dropEvent, 'great-ball');
    await seedEncounter(ctx, dropEvent, { speciesId: 25, wildLevel: 6, clientSeed: dropSeed });
    const dropped = await ctx.wild.start(ash, dropEvent);
    await patchSession(ctx, dropped.sessionId, (s) => {
      s.wild.hp = 1;
    });
    const after = await ctx.wild.action(ash, dropped.sessionId, { type: 'move', moveId: 'tackle' });
    expect(after.status).toBe('WILD_FAINTED');
    expect(after.drop).toMatchObject({ typeId: 'great-ball', quantity: 1 });
    expect((await itemsOf(ctx, 'great-ball')).reduce((n, i) => n + i.quantity, 0)).toBe(1);

    // 同一动作重放：不重复掉落
    await ctx.wild.action(ash, dropped.sessionId, { type: 'move', moveId: 'tackle' });
    expect((await itemsOf(ctx, 'great-ball')).reduce((n, i) => n + i.quantity, 0)).toBe(1);

    // 不掉落场次
    const noDropEvent = 'ev_drop_none';
    await seedEncounter(ctx, noDropEvent, {
      speciesId: 25,
      wildLevel: 6,
      clientSeed: clientSeedFor(noDropEvent, 'none'),
    });
    const barren = await ctx.wild.start(ash, noDropEvent);
    await patchSession(ctx, barren.sessionId, (s) => {
      s.wild.hp = 1;
    });
    const noDrop = await ctx.wild.action(ash, barren.sessionId, { type: 'move', moveId: 'tackle' });
    expect(noDrop.status).toBe('WILD_FAINTED');
    expect(noDrop.drop).toBeNull();
    expect(await itemsOf(ctx)).toHaveLength(1); // 只有上面那场掉落的超级球
  });

  it('逃跑 / 超时等非结算分支不掉落', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await seedPokemon(ctx.chain, 'ash', { id: 'p_run_hero', level: 20, moves: ['tackle'] });

    const eventId = 'ev_drop_run';
    await seedEncounter(ctx, eventId, {
      speciesId: 25,
      wildLevel: 5,
      clientSeed: clientSeedFor(eventId, 'potion'),
    });
    const started = await ctx.wild.start(ash, eventId);
    const ran = await ctx.wild.action(ash, started.sessionId, { type: 'run' });
    expect(ran.status).toBe('RAN');
    expect(ran.drop).toBeNull();
    expect(await itemsOf(ctx)).toHaveLength(0);
  });
});
