import { DeriveStream, sha256hex } from '../src/common/utils/crypto.util';
import { getSpecies } from '../src/game-data/species.data';
import { computeStats, emptyEvs } from '../src/game-data/stats';
import { SHINY_CHANCE, deriveWildSpecimen } from '../src/pokemon/capture-derive';
import {
  STARTER_GIFT,
  STARTER_LEVEL,
  StarterService,
  starterEventId,
} from '../src/users/starter.service';
import { makeChain, makeRedis, registerPlayers, userIdentity } from './helpers';

function build() {
  const { chain, contract } = makeChain();
  const redis = makeRedis();
  const starters = new StarterService(contract, redis);
  return { chain, contract, redis, starters };
}

const ash = userIdentity('ash');

const ballsOf = async (ctx: ReturnType<typeof build>) =>
  (await ctx.contract.queryItemsByOwner('ash')).filter((i) => i.typeId === 'poke-ball');

const potionsOf = async (ctx: ReturnType<typeof build>) =>
  (await ctx.contract.queryItemsByOwner('ash')).filter((i) => i.typeId === 'potion');

describe('新手礼包：注册后三选一御三家（docs/backend-api.md §「新手礼包」）', () => {
  it('Commit→Reveal→派生个体→MintFromCapture(level 5)，并发精灵球×5 + 伤药×2', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    expect(await ctx.starters.hasStarter('ash')).toBe(false);

    const res = await ctx.starters.claim(ash, 1);

    // 链上随机事件：先承诺、后揭示、最终被 mint 消费；meta 留痕 {starter:true}
    const event = await ctx.contract.getRandom(starterEventId('ash'));
    expect(event.eventId).toBe(starterEventId('ash'));
    expect(event.purpose).toBe('capture');
    expect(event.status).toBe('CONSUMED');
    expect(JSON.parse(event.meta)).toEqual({ starter: true });
    expect(sha256hex(event.serverSeed)).toBe(event.commitHash);

    // 个体完全来自已验证的派生流（与野怪战斗同一套 deriveWildSpecimen 布局）
    const specimen = deriveWildSpecimen(
      new DeriveStream(event.serverSeed, event.clientSeed, event.eventId),
      SHINY_CHANCE,
    );
    const species = getSpecies(1)!;
    expect(res.pokemon.speciesId).toBe(1);
    expect(res.pokemon.level).toBe(STARTER_LEVEL);
    expect(res.pokemon.ivs).toEqual(specimen.ivs);
    expect(res.pokemon.nature).toBe(specimen.nature);
    expect(res.pokemon.shiny).toBe(specimen.shiny);
    expect(res.pokemon.moves).toEqual(species.defaultMoves.slice(0, 4));
    expect(res.pokemon.stats).toEqual(
      computeStats(species.base, specimen.ivs, emptyEvs(), STARTER_LEVEL, specimen.nature),
    );

    // 链上宝可梦：owner 名下唯一一只，IDLE
    const mine = await ctx.contract.queryPokemonByOwner('ash');
    expect(mine.map((p) => p.id)).toEqual([res.pokemon.id]);
    expect(mine[0].status).toBe('IDLE');

    // 礼包：精灵球×5 + 伤药×2（各自一个堆叠）
    expect(res.gift).toEqual(STARTER_GIFT);
    expect((await ballsOf(ctx)).map((i) => i.quantity)).toEqual([5]);
    expect((await potionsOf(ctx)).map((i) => i.quantity)).toEqual([2]);
    expect(await ctx.starters.hasStarter('ash')).toBe(true);
  });

  it('三只御三家都能选（4 小火龙 / 7 杰尼龟）；非法 speciesId 拒绝', async () => {
    const charmander = build();
    await registerPlayers(charmander.contract, 'gary');
    const c = await charmander.starters.claim(userIdentity('gary'), 4);
    expect(c.pokemon.speciesId).toBe(4);
    expect(c.pokemon.ability).toBe('blaze');

    const squirtle = build();
    await registerPlayers(squirtle.contract, 'eve');
    const s = await squirtle.starters.claim(userIdentity('eve'), 7);
    expect(s.pokemon.speciesId).toBe(7);
    expect(s.pokemon.ability).toBe('torrent');

    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await expect(ctx.starters.claim(ash, 25)).rejects.toThrow(/INVALID_SPECIES/);
    await expect(ctx.starters.claim(ash, 0)).rejects.toThrow(/INVALID_SPECIES/);
    expect(await ctx.starters.hasStarter('ash')).toBe(false);
  });

  it('重复调用：409 STARTER_ALREADY_CLAIMED，且不重复发宝可梦/礼包', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const first = await ctx.starters.claim(ash, 1);

    await expect(ctx.starters.claim(ash, 1)).rejects.toThrow(/STARTER_ALREADY_CLAIMED/);
    await expect(ctx.starters.claim(ash, 4)).rejects.toThrow(/STARTER_ALREADY_CLAIMED/);

    const mine = await ctx.contract.queryPokemonByOwner('ash');
    expect(mine.map((p) => p.id)).toEqual([first.pokemon.id]);
    expect((await ballsOf(ctx)).map((i) => i.quantity)).toEqual([5]);
    expect((await potionsOf(ctx)).map((i) => i.quantity)).toEqual([2]);
  });

  it('中途失败可续跑：承诺已上链时用 Redis pending seed 继续，不新建事件', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const eventId = starterEventId('ash');
    const serverSeed = 'ab'.repeat(32);
    const clientSeed = 'cd'.repeat(8);
    // 模拟「commit 已上链，但进程在 reveal 之前挂掉」
    await ctx.contract.commitRandom(
      ash,
      {
        eventId,
        purpose: 'capture',
        playerId: 'ash',
        commitHash: sha256hex(serverSeed),
        clientSeed,
        meta: JSON.stringify({ starter: true }),
      },
      { idemKey: `${eventId}-commit` },
    );
    await ctx.redis.setJson(`starter:pending:ash`, { serverSeed, clientSeed }, 600);

    const res = await ctx.starters.claim(ash, 7);
    expect(res.pokemon.speciesId).toBe(7);

    const event = await ctx.contract.getRandom(eventId);
    expect(event.status).toBe('CONSUMED');
    // 续跑沿用同一个 serverSeed（派生流不变）
    expect(event.serverSeed).toBe(serverSeed);
    expect(res.pokemon.ivs).toEqual(
      deriveWildSpecimen(new DeriveStream(serverSeed, clientSeed, eventId), SHINY_CHANCE).ivs,
    );
    // pending seed 在成功后清理
    expect(await ctx.redis.get('starter:pending:ash')).toBeNull();
  });

  it('并发双击：第二个请求拿不到领取锁 → STARTER_IN_PROGRESS（不重复铸造）', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    // 模拟另一个请求正持有锁
    await ctx.redis.setNx('starter:lock:ash', '1', 30);

    await expect(ctx.starters.claim(ash, 1)).rejects.toThrow(/STARTER_IN_PROGRESS/);
    expect(await ctx.contract.queryPokemonByOwner('ash')).toEqual([]);
    expect(await ctx.starters.hasStarter('ash')).toBe(false);

    // 锁释放后可以正常领取
    await ctx.redis.del('starter:lock:ash');
    const res = await ctx.starters.claim(ash, 1);
    expect(res.pokemon.speciesId).toBe(1);
    // 正常路径不残留锁
    expect(await ctx.redis.get('starter:lock:ash')).toBeNull();
  });

  it('承诺上链但 serverSeed 丢失（Redis 被清空）→ STARTER_PENDING 而不是错误铸造', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await ctx.contract.commitRandom(ash, {
      eventId: starterEventId('ash'),
      purpose: 'capture',
      playerId: 'ash',
      commitHash: sha256hex('ef'.repeat(32)),
      clientSeed: 'ab'.repeat(8),
      meta: JSON.stringify({ starter: true }),
    });

    await expect(ctx.starters.claim(ash, 1)).rejects.toThrow(/STARTER_PENDING/);
    expect(await ctx.contract.queryPokemonByOwner('ash')).toEqual([]);
  });
});
