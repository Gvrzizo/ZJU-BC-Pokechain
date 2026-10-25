import { BattleEngine } from '../src/battles/engine/battle-engine';
import { BattleManagerService } from '../src/battles/battle-manager.service';
import { BattlesService } from '../src/battles/battles.service';
import { SigningService } from '../src/battles/signing.service';
import { BattleLog } from '../src/battles/entities/battle-log.entity';
import { DisputeRecord } from '../src/battles/entities/dispute-record.entity';
import { AuditLog } from '../src/admin/entities/audit-log.entity';
import { ItemsService } from '../src/items/items.service';
import { PokemonHpService } from '../src/pokemon/pokemon-hp.service';
import { CaptureService } from '../src/pokemon/capture.service';
import { RankedBattleLauncher } from '../src/ranked/battle-launcher';
import { WildService } from '../src/wild/wild.service';
import { loadWildSession, wildSessionKey } from '../src/wild/wild-session';
import { sha256hex } from '../src/common/utils/crypto.util';
import {
  makeBlocks,
  makeBondService,
  makeChain,
  makeConfig,
  makeHpService,
  makePokemonService,
  makeRedis,
  mintBall,
  mockRepo,
  registerPlayers,
  seedPokemon,
  userIdentity,
} from './helpers';

const SERVER_SEED = 'aa'.repeat(32);

const BATTLE_CONFIG = {
  battle: {
    turnTimeoutMs: 30_000,
    disconnectTimeoutMs: 60_000,
    entryGraceMs: 90_000,
    settleFallbackMs: 300_000,
  },
};

/** 野怪战斗栈（capture + wild + pokemon + bond），与 wild.spec 同口径。 */
function makeWildStack() {
  const { chain, contract } = makeChain();
  const redis = makeRedis();
  const capture = new CaptureService(chain, contract, redis);
  const pokemon = makePokemonService(contract, redis);
  const wild = new WildService(contract, capture, pokemon, makeBondService(contract, redis), redis);
  return { chain, contract, redis, capture, pokemon, wild, hp: pokemon.hp };
}

/** 对局栈（房间流程 + 引擎 + 链下 HP），与 battle-lifecycle.spec 同口径。 */
function makeBattleStack() {
  const { chain, contract } = makeChain();
  const redis = makeRedis();
  const config = makeConfig(BATTLE_CONFIG);
  const manager = new BattleManagerService(contract, redis, new SigningService(makeConfig({ serverSigningKey: '' })), config, mockRepo<BattleLog>() as never);
  const battles = new BattlesService(
    contract,
    redis,
    manager,
    { mustFindByUsername: async (u: string) => ({ username: u, fabricMspId: 'Org1MSP' }) } as never,
    makeBlocks(config),
    makeHpService(redis),
    mockRepo<AuditLog>() as never,
    mockRepo<DisputeRecord>() as never,
    config,
  );
  battles.onModuleInit();
  const pokemon = makePokemonService(contract, redis);
  return { chain, contract, redis, manager, battles, pokemon, hp: pokemon.hp };
}

/** 直接写入遇敌会话（等价于 POST /capture/encounter 之后的状态）并上链承诺。 */
async function seedEncounter(
  ctx: ReturnType<typeof makeWildStack>,
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

async function patchSession(ctx: ReturnType<typeof makeWildStack>, sessionId: string, patch: (session: any) => void) {
  const session = (await loadWildSession(ctx.redis, sessionId))!;
  patch(session);
  await ctx.redis.setJson(wildSessionKey(sessionId), session, 900);
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

const ash = userIdentity('ash');
const gary = userIdentity('gary');

describe('伤势持久化：链下当前 HP（docs/backend-api.md §2）', () => {
  it('缺键 = 满血：详情/列表带 currentHp（= stats.hp）且 fainted=false', async () => {
    const ctx = makeWildStack();
    await registerPlayers(ctx.contract, 'ash');
    await seedPokemon(ctx.chain, 'ash', { id: 'p_hp_fresh', level: 30 });

    const detail = await ctx.pokemon.getOne('p_hp_fresh');
    expect(detail.currentHp).toBe(detail.stats!.hp);
    expect(detail.fainted).toBe(false);
    const list = await ctx.pokemon.listMine('ash');
    expect(list.find((p) => p.id === 'p_hp_fresh')?.currentHp).toBe(detail.stats!.hp);

    // 越界/脏数据一律夹到 [0, maxHp]
    await ctx.redis.set(PokemonHpService.key('p_hp_fresh'), '99999');
    expect((await ctx.pokemon.getOne('p_hp_fresh')).currentHp).toBe(detail.stats!.hp);
  });

  it('野怪战斗的伤害跨战斗保留：第二次遇敌以残血出战', async () => {
    const ctx = makeWildStack();
    await registerPlayers(ctx.contract, 'ash');
    const hero = await seedPokemon(ctx.chain, 'ash', { id: 'p_hp_hero', level: 30, moves: ['tackle'] });

    const first = 'ev_hp_first';
    await seedEncounter(ctx, first, { speciesId: 25, wildLevel: 5, clientSeed: '11'.repeat(16) });
    const started = await ctx.wild.start(ash, first);
    const maxHp = started.mine.maxHp;
    expect(started.mine.hp).toBe(maxHp); // 首次遇敌满血

    // 模拟战斗中被扣到 7 点后逃跑（伤害由引擎写入会话，逃跑触发落盘）
    await patchSession(ctx, started.sessionId, (session) => {
      session.party[0].hp = 7;
    });
    const ran = await ctx.wild.action(ash, started.sessionId, { type: 'run' });
    expect(ran.status).toBe('RAN');
    expect(await ctx.pokemon.hp.currentHp(hero)).toBe(7);

    // 第二次遇敌：以 7 点残血出战（不再满血）
    const second = 'ev_hp_second';
    await seedEncounter(ctx, second, { speciesId: 25, wildLevel: 5, clientSeed: '22'.repeat(16) });
    const again = await ctx.wild.start(ash, second);
    expect(again.mine.hp).toBe(7);
    expect(again.mine.maxHp).toBe(maxHp);
    expect(again.party[0]).toMatchObject({ hp: 7, maxHp, fainted: false });
  });

  it('濒死限制：全队濒死 → FAINTED（不能出战）；指定濒死首发 → FAINTED', async () => {
    const ctx = makeWildStack();
    await registerPlayers(ctx.contract, 'ash');
    const a = await seedPokemon(ctx.chain, 'ash', { id: 'p_hp_ko1', level: 30 });
    const b = await seedPokemon(ctx.chain, 'ash', { id: 'p_hp_ko2', level: 20 });
    const maxA = ctx.hp.maxHpOf(a);
    const maxB = ctx.hp.maxHpOf(b);

    // 全队 0 HP：start 直接 FAINTED，也不消耗 eventId（无会话落盘）
    await ctx.hp.set(a.id, 0, maxA);
    await ctx.hp.set(b.id, 0, maxB);
    await seedEncounter(ctx, 'ev_hp_fainted_all', { speciesId: 25, wildLevel: 5, clientSeed: '33'.repeat(16) });
    await expect(ctx.wild.start(ash, 'ev_hp_fainted_all')).rejects.toThrow(/FAINTED/);
    expect(await ctx.wild.start(ash, 'ev_hp_fainted_all').catch((e) => e.message)).toContain('FAINTED');

    // 治疗第一只后：把仍濒死的第二只指定为首发 → FAINTED；不指定则可正常开战
    await ctx.hp.set(a.id, maxA, maxA);
    await seedEncounter(ctx, 'ev_hp_fainted_one', { speciesId: 25, wildLevel: 5, clientSeed: '44'.repeat(16) });
    await expect(ctx.wild.start(ash, 'ev_hp_fainted_one', b.id)).rejects.toThrow(/FAINTED/);
    const started = await ctx.wild.start(ash, 'ev_hp_fainted_one');
    expect(started.party.map((p: { pokemonId: string }) => p.pokemonId)).toEqual([a.id]); // 濒死者不进队伍
    expect(started.mine.hp).toBe(maxA);
  });

  it('宝可梦中心：全队回满扣 10P（reason=heal:center）；全员满血不扣费', async () => {
    const ctx = makeWildStack();
    await registerPlayers(ctx.contract, 'ash');
    const a = await seedPokemon(ctx.chain, 'ash', { id: 'p_center_a', level: 30 });
    const b = await seedPokemon(ctx.chain, 'ash', { id: 'p_center_b', level: 40 });
    const maxA = ctx.hp.maxHpOf(a);
    const maxB = ctx.hp.maxHpOf(b);

    // 全员满血：不扣费、没有治疗对象
    const noop = await ctx.pokemon.centerHeal(ash);
    expect(noop).toMatchObject({ cost: 10, charged: false, healed: [] });
    expect(noop.points).toBe(1000);

    await ctx.hp.set(a.id, 1, maxA);
    await ctx.hp.set(b.id, 0, maxB);
    const reasons: string[] = [];
    ctx.chain.onChainEvent((name, payload) => {
      if (name === 'PointsChanged' && typeof payload.reason === 'string') reasons.push(payload.reason);
    });
    const healed = await ctx.pokemon.centerHeal(ash);
    expect(healed).toMatchObject({ cost: 10, charged: true, points: 990 });
    expect(healed.healed.map((h) => h.pokemonId).sort()).toEqual(['p_center_a', 'p_center_b']);
    expect(reasons).toContain('heal:center');
    expect(await ctx.pokemon.hp.currentHp(a)).toBe(maxA);
    expect(await ctx.pokemon.hp.currentHp(b)).toBe(maxB);

    // 对战中/交易锁定（非 IDLE）的宝可梦不参与治疗
    (ctx.chain as unknown as { put: (k: string, v: unknown) => void }).put(`pokemon:${a.id}`, {
      ...a,
      status: 'LOCKED_BATTLE',
      lockRef: 'b_x',
    });
    await ctx.hp.set(a.id, 2, maxA);
    const second = await ctx.pokemon.centerHeal(ash);
    expect(second.healed).toEqual([]); // 只有 a 受伤，但它被锁定 → 无可治疗对象
    expect(second.charged).toBe(false);
    expect(await ctx.pokemon.hp.currentHp(a)).toBe(2); // 锁定资产保持伤势
  });

  it('伤药/好伤药：+20 / +50 且不超上限', async () => {
    const ctx = makeWildStack();
    await registerPlayers(ctx.contract, 'ash');
    const mon = await seedPokemon(ctx.chain, 'ash', { id: 'p_potion', level: 30 });
    const maxHp = ctx.hp.maxHpOf(mon);
    const potion = await mintBall(ctx.contract, 'ash', 'i_potion_hp', 'potion', 1);
    const superPotion = await mintBall(ctx.contract, 'ash', 'i_super_hp', 'super-potion', 1);

    await ctx.hp.set(mon.id, 1, maxHp);
    const items = new ItemsService(ctx.contract, ctx.pokemon);
    const first = await items.use(ash, potion.id, { targetPokemonId: mon.id });
    expect(first.hp).toMatchObject({ before: 1, after: 21, healed: 20, maxHp });

    // 上限夹取：只回 10 点（超出上限的部分不生效）
    await ctx.hp.set(mon.id, maxHp - 10, maxHp);
    const capped = await items.use(ash, superPotion.id, { targetPokemonId: mon.id });
    expect(capped.hp).toMatchObject({ before: maxHp - 10, after: maxHp, healed: 10, maxHp });

    // 满血：拒绝且不消耗道具
    const extra = await mintBall(ctx.contract, 'ash', 'i_super_hp2', 'super-potion', 1);
    await expect(items.use(ash, extra.id, { targetPokemonId: mon.id })).rejects.toThrow(/HP_FULL/);
    expect((await ctx.contract.getItem(extra.id)).quantity).toBe(1);
  });

  it('PvP：满血出战、结束后不回写 poke:hp；濒死宝可梦不能进队伍（FAINTED）', async () => {
    const ctx = makeBattleStack();
    await registerPlayers(ctx.contract, 'ash', 'gary');
    const strong = await seedPokemon(ctx.chain, 'ash', { id: 'p_hp_pvp_a', speciesId: 149, level: 60, moves: ['hyper-beam'] });
    const weak = await seedPokemon(ctx.chain, 'gary', { id: 'p_hp_pvp_b', speciesId: 133, level: 2, moves: ['tackle'] });
    const maxA = ctx.hp.maxHpOf(strong);
    await ctx.hp.set(strong.id, 5, maxA); // 野怪战斗留下的伤势：竞技不继承

    const room = await ctx.battles.createRoom(ash, {
      mode: '1v1',
      wager: { pokemonIds: [], items: [], points: 0 },
      teamPokemonIds: [strong.id],
    });
    await ctx.battles.joinRoom(gary, room.id, {
      wager: { pokemonIds: [], items: [], points: 0 },
      teamPokemonIds: [weak.id],
    });
    await ctx.battles.confirmWager(ash, room.id);
    const active = await ctx.battles.confirmWager(gary, room.id);
    const battleId = active.battleId as string;

    // 满血满状态出战：链下伤势（5 HP）被忽略
    const engine = ctx.manager.get(battleId)!.engine;
    expect(engine.active('A').hp).toBe(maxA);
    expect(engine.active('A').maxHp).toBe(maxA);
    expect(engine.active('B').hp).toBe(ctx.hp.maxHpOf(weak));

    // lv60 打 lv2 必定击倒；Hyper Beam 只有 90% 命中，miss 时继续下一回合（派生随机流每局不同）
    for (let turn = 0; turn < 10; turn++) {
      const active = ctx.manager.get(battleId);
      if (!active || active.engine.finished) break;
      ctx.manager.submitAction(battleId, 'ash', { type: 'move', moveIndex: 0 });
      const afterA = ctx.manager.get(battleId);
      if (!afterA || afterA.engine.finished) break;
      ctx.manager.submitAction(battleId, 'gary', { type: 'move', moveIndex: 0 });
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await waitFor(() => ctx.manager.get(battleId) === undefined)).toBe(true);

    // 不回写：战前伤势原样保留，从未受伤的对手也不会凭空多出毒伤势键
    expect(await ctx.hp.currentHp(await ctx.contract.getPokemon(strong.id))).toBe(5);
    expect(await ctx.hp.currentHp(await ctx.contract.getPokemon(weak.id))).toBe(ctx.hp.maxHpOf(weak));
    expect(await ctx.redis.get(PokemonHpService.key(weak.id))).toBeNull();

    // 濒死校验保留：0 HP 的宝可梦不能进新的队伍提交（FAINTED：链上资产尚未锁定）
    await ctx.hp.set(weak.id, 0, ctx.hp.maxHpOf(weak));
    await expect(
      ctx.battles.createRoom(gary, { mode: '1v1', wager: { pokemonIds: [], items: [], points: 0 }, teamPokemonIds: [weak.id] }),
    ).rejects.toThrow(/FAINTED/);
  });

  it('主动交换宝可梦的羁绊不因伤势键残留而出错；放生会清掉伤势键', async () => {
    const ctx = makeWildStack();
    await registerPlayers(ctx.contract, 'ash');
    const mon = await seedPokemon(ctx.chain, 'ash', { id: 'p_hp_release', level: 20 });
    await ctx.hp.set(mon.id, 3, ctx.hp.maxHpOf(mon));
    await ctx.pokemon.release(ash, mon.id);
    expect(await ctx.redis.get(PokemonHpService.key(mon.id))).toBeNull();
  });
});

describe('伤势持久化：PvP 满血出战、不写回（房间与排位路径）', () => {
  it('排位/机器人启动器（launcher.loadTeam 仍带 currentHp）同样满血出战且不写回', async () => {
    const ctx = makeBattleStack();
    await registerPlayers(ctx.contract, 'ash', 'gary');
    const pa = await seedPokemon(ctx.chain, 'ash', { id: 'p_hp_zero_a', level: 20, moves: ['tackle'] });
    const pb = await seedPokemon(ctx.chain, 'gary', { id: 'p_hp_zero_b', level: 20, moves: ['tackle'] });
    const maxA = ctx.hp.maxHpOf(pa);
    const maxB = ctx.hp.maxHpOf(pb);
    await ctx.hp.set(pa.id, 4, maxA);
    await ctx.hp.set(pb.id, 9, maxB);

    // 排位对局走 RankedBattleLauncher（wager=0）：loadTeam 仍会带上链下当前 HP
    const launcher = new RankedBattleLauncher(ctx.contract, ctx.manager, makeHpService(ctx.redis));
    const battleId = 'b_hp_zero';
    const teamA = await launcher.loadTeam([pa.id]);
    const teamB = await launcher.loadTeam([pb.id]);
    expect(teamA[0].currentHp).toBe(4); // launcher 确实带了伤势
    await launcher.launch({ battleId, playerA: 'ash', playerB: 'gary', teamA, teamB });

    // 引擎仍按满血开局（BattleManagerService.startBattle 统一剥掉 currentHp）
    const engine = ctx.manager.get(battleId)!.engine;
    expect(engine.active('A').hp).toBe(maxA);
    expect(engine.active('B').hp).toBe(maxB);

    await ctx.manager.forfeit(battleId, 'ash');
    expect(await waitFor(async () => ctx.manager.get(battleId) === undefined)).toBe(true);
    expect(await ctx.hp.currentHp(pa)).toBe(4);
    expect(await ctx.hp.currentHp(pb)).toBe(9);
  });
});

describe('伤势持久化：引擎入参', () => {
  it('EngineMonInput.currentHp 缺省 = 满血，越界夹取到 [0, maxHp]', async () => {
    const { chain, contract } = makeChain();
    const pokemon = makePokemonService(contract, makeRedis());
    const mon = await seedPokemon(chain, 'ash', { id: 'p_engine_hp', level: 20 });
    const team = await pokemon.hp.load(mon);
    const base = {
      pokemonId: mon.id,
      speciesId: mon.speciesId,
      level: mon.level,
      ivs: mon.ivs,
      evs: mon.evs,
      nature: mon.nature,
      moves: mon.moves,
    };
    const full = new BattleEngine([{ ...base }], [{ ...base }], () => 0.5);
    expect(full.active('A').hp).toBe(team.maxHp);
    const hurt = new BattleEngine([{ ...base, currentHp: 3 }], [{ ...base, currentHp: -5 }], () => 0.5);
    expect(hurt.active('A').hp).toBe(3);
    expect(hurt.active('B').hp).toBe(0);
  });
});
