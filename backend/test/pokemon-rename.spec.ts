import { HttpStatus } from '@nestjs/common';
import { splitCodedMessage } from '../src/common/utils/errors';
import { POKEMON_NAME_MAX, normalizePokemonName } from '../src/pokemon/pokemon-name';
import { RENAME_COST } from '../src/pokemon/points-economy';
import {
  SYSTEM_IDENTITY,
  makeChain,
  makePokemonService,
  makeRedis,
  mockRepo,
  registerPlayers,
  seedPokemon,
  userIdentity,
} from './helpers';

/** 改名（docs/backend-api.md §2「改名」）：第一次免费，之后每次 50P，次数存链下 PG。 */
const ash = userIdentity('ash');
const gary = userIdentity('gary');

function build() {
  const { chain, contract } = makeChain();
  const redis = makeRedis();
  const renames = mockRepo<{ pokemonId: string; count: number }>();
  const pokemon = makePokemonService(contract, redis, renames);
  return { chain, contract, redis, renames, pokemon };
}

/** 收集链上积分流水（reason 审计口径）与 PokemonGrowth 事件。 */
function collectEvents(chain: ReturnType<typeof build>['chain']) {
  const reasons: string[] = [];
  const names: string[] = [];
  chain.onChainEvent((name, payload) => {
    if (name === 'PointsChanged' && typeof payload.reason === 'string') reasons.push(payload.reason);
    if (name === 'PokemonGrowth') names.push(String(payload.id));
  });
  return { reasons, names };
}

const pointsOf = (ctx: ReturnType<typeof build>, player = 'ash') =>
  ctx.contract.getPlayer(player).then((p) => p.points);

const renameRows = (ctx: ReturnType<typeof build>) =>
  ctx.renames.rows.map((row) => ({ pokemonId: row.pokemonId, count: row.count }));

describe('PokemonService.rename：第一次免费、之后每次 50P（docs/backend-api.md §2）', () => {
  it('第一次改名免费：链上 name 更新、renameCount=1、积分不变、无扣费流水', async () => {
    const ctx = build();
    const { chain, contract, pokemon } = ctx;
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', { id: 'p_first', name: 'pikachu' });
    const events = collectEvents(chain);

    const result = await pokemon.rename(ash, 'p_first', '闪电鼠');

    expect(result).toEqual({ name: '闪电鼠', renameCount: 1, charged: false });
    // 链上持久化（ApplyGrowth.name）
    expect((await contract.getPokemon('p_first')).name).toBe('闪电鼠');
    expect(events.names).toEqual(['p_first']);
    // 第一次免费：1000 积分不动，也没有任何 PointsChanged 流水
    expect(await pointsOf(ctx)).toBe(1000);
    expect(events.reasons).toEqual([]);
    expect(renameRows(ctx)).toEqual([{ pokemonId: 'p_first', count: 1 }]);
  });

  it('第二次改名叫价 50P：reason=rename:<id>:2、积分 1000→950、renameCount=2', async () => {
    const ctx = build();
    const { chain, contract, pokemon } = ctx;
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', { id: 'p_second', name: 'pikachu' });
    const events = collectEvents(chain);

    await pokemon.rename(ash, 'p_second', '第一昵称');
    const second = await pokemon.rename(ash, 'p_second', '第二昵称');

    expect(second).toEqual({ name: '第二昵称', renameCount: 2, charged: true });
    expect(await pointsOf(ctx)).toBe(1000 - RENAME_COST);
    expect(events.reasons).toEqual(['rename:p_second:2']);
    expect((await contract.getPokemon('p_second')).name).toBe('第二昵称');
  });

  it('链上 name 已是目标昵称时视为空操作（不扣分、不计数），之后的付费改名继续按序计费', async () => {
    const ctx = build();
    const { chain, contract, pokemon } = ctx;
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', { id: 'p_idem', name: 'pikachu' });
    await pokemon.rename(ash, 'p_idem', '旧名');
    await pokemon.rename(ash, 'p_idem', '新名');
    const afterPaid = await pointsOf(ctx);

    // 模拟"链上已改、本地响应丢失"后的客户端重试：链上 name 已是新名 → 空操作
    const replay = await pokemon.rename(ash, 'p_idem', '新名');
    expect(replay).toEqual({ name: '新名', renameCount: 2, charged: false });
    expect(await pointsOf(ctx)).toBe(afterPaid);

    // 换个名字（第 3 次）：按 rename:<id>:3 再收 50P
    const third = await pokemon.rename(ash, 'p_idem', '第三名');
    expect(third).toEqual({ name: '第三名', renameCount: 3, charged: true });
    expect(await pointsOf(ctx)).toBe(afterPaid - RENAME_COST);
  });

  it('扣费成功但链上改名失败后重试：只收一次 50P（确定性幂等键）', async () => {
    const ctx = build();
    const { chain, contract, pokemon } = ctx;
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', { id: 'p_partial', name: 'pikachu' });
    await pokemon.rename(ash, 'p_partial', '第一次');
    const balanceAfterFirst = await pointsOf(ctx);

    // 模拟"扣费成功、ApplyGrowth 交易失败"：让下一次 applyGrowth 抛链上错误
    const original = contract.applyGrowth.bind(contract);
    let failOnce = true;
    jest.spyOn(contract, 'applyGrowth').mockImplementation((async (as, id, growth, m) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('CHAIN_DOWN: peer unavailable');
      }
      return original(as, id, growth, m);
    }) as typeof contract.applyGrowth);

    await expect(pokemon.rename(ash, 'p_partial', '失败一次')).rejects.toThrow(/CHAIN_DOWN/);
    expect(await pointsOf(ctx)).toBe(balanceAfterFirst - RENAME_COST);

    // 重试：链上改名补上，扣费命中幂等键不再扣第二次
    const retry = await pokemon.rename(ash, 'p_partial', '失败一次');
    expect(retry).toEqual({ name: '失败一次', renameCount: 2, charged: true });
    expect(await pointsOf(ctx)).toBe(balanceAfterFirst - RENAME_COST);
    expect(renameRows(ctx)).toEqual([{ pokemonId: 'p_partial', count: 2 }]);
  });

  it('积分不足抛 INSUFFICIENT_POINTS(400)，链上 name 与计数都不变', async () => {
    const ctx = build();
    const { chain, contract, pokemon } = ctx;
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', { id: 'p_poor', name: 'pikachu' });
    await pokemon.rename(ash, 'p_poor', '第一次免费');
    await contract.addPoints(SYSTEM_IDENTITY, 'ash', -(1000 - 10), 'test:drain');

    await expect(pokemon.rename(ash, 'p_poor', '买不起')).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
    await expect(pokemon.rename(ash, 'p_poor', '买不起')).rejects.toThrow(/INSUFFICIENT_POINTS/);
    expect((await contract.getPokemon('p_poor')).name).toBe('第一次免费');
    expect(await pointsOf(ctx)).toBe(10);
    expect(renameRows(ctx)).toEqual([{ pokemonId: 'p_poor', count: 1 }]);
  });

  it('越权改名（非本人）抛 NOT_OWNER(403)，不放行任何写入', async () => {
    const ctx = build();
    const { chain, contract, pokemon } = ctx;
    await registerPlayers(contract, 'ash', 'gary');
    await seedPokemon(chain, 'ash', { id: 'p_mine', name: 'pikachu' });

    await expect(pokemon.rename(gary, 'p_mine', '偷来的')).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN,
    });
    await expect(pokemon.rename(gary, 'p_mine', '偷来的')).rejects.toThrow(/NOT_OWNER/);
    expect((await contract.getPokemon('p_mine')).name).toBe('pikachu');
    expect(renameRows(ctx)).toEqual([]);
  });

  it('锁定中的宝可梦拒绝改名（ASSET_LOCKED 409），积分与计数不动', async () => {
    const ctx = build();
    const { chain, contract, pokemon } = ctx;
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', { id: 'p_locked', name: 'pikachu', status: 'LOCKED_BATTLE' });

    await expect(pokemon.rename(ash, 'p_locked', '锁定中')).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
    });
    await expect(pokemon.rename(ash, 'p_locked', '锁定中')).rejects.toThrow(/ASSET_LOCKED/);
    expect(await pointsOf(ctx)).toBe(1000);
    expect(renameRows(ctx)).toEqual([]);
  });

  it('昵称校验：trim、1-12 字符、拒绝控制字符与 <>&"\'，非法输入不产生任何链上交易', async () => {
    const ctx = build();
    const { chain, contract, pokemon } = ctx;
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', { id: 'p_name', name: 'pikachu' });
    const events = collectEvents(chain);

    const bad = ['', '   ', '<script>', 'a&b', 'a>b', "a'b", 'a"b', '带\n换行', '零\u0000宽', '字'.repeat(13)];
    for (const value of bad) {
      await expect(pokemon.rename(ash, 'p_name', value)).rejects.toThrow(/INVALID_NAME/);
    }
    expect((await contract.getPokemon('p_name')).name).toBe('pikachu');
    expect(await pointsOf(ctx)).toBe(1000);
    expect(events.names).toEqual([]);

    // trim + 折叠内部空白；中文/英文混排都可以（12 个字符以内）
    const free = await pokemon.rename(ash, 'p_name', '  中文 English 名  ');
    expect(free).toEqual({ name: '中文 English 名', renameCount: 1, charged: false });

    // 12 个字符刚好是上限、13 个拒绝
    const maxed = '字'.repeat(POKEMON_NAME_MAX);
    await expect(pokemon.rename(ash, 'p_name', '字'.repeat(POKEMON_NAME_MAX + 1))).rejects.toThrow(/INVALID_NAME/);
    expect(await pokemon.rename(ash, 'p_name', maxed)).toEqual({
      name: maxed,
      renameCount: 2,
      charged: true,
    });
  });

  it('列表/详情附带 renameCount（未改名为 0），改名后列表缓存立即失效', async () => {
    const ctx = build();
    const { chain, contract, pokemon } = ctx;
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', { id: 'p_view', name: 'pikachu' });

    const before = await pokemon.listMine('ash');
    expect(before[0].renameCount).toBe(0);
    expect((await pokemon.getOne('p_view')).renameCount).toBe(0);

    await pokemon.rename(ash, 'p_view', '新名字');
    const after = await pokemon.listMine('ash');
    expect(after[0].renameCount).toBe(1);
    expect(after[0].name).toBe('新名字');
    expect((await pokemon.getOne('p_view')).renameCount).toBe(1);
  });

  it('改名后进化保留昵称；没改名的宝可梦保持旧行为（进化后 name = 新种族名）', async () => {
    const ctx = build();
    const { chain, contract, pokemon } = ctx;
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', { id: 'p_evo', speciesId: 4, name: 'charmander', level: 16 });
    await seedPokemon(chain, 'ash', { id: 'p_evo_plain', speciesId: 4, name: 'charmander', level: 16 });

    await pokemon.rename(ash, 'p_evo', '小火的昵称');
    await pokemon.rename(ash, 'p_evo_plain', 'charmander'); // 与链上 name 相同 → 空操作
    const evolved = await pokemon.evolve(ash, 'p_evo');
    const evolvedPlain = await pokemon.evolve(ash, 'p_evo_plain');

    expect(evolved.speciesId).toBe(5);
    expect(evolved.name).toBe('小火的昵称');
    expect(evolvedPlain.speciesId).toBe(5);
    expect(evolvedPlain.name).toBe('charmeleon');
    expect(renameRows(ctx)).toEqual([{ pokemonId: 'p_evo', count: 1 }]);
  });

  it('昵称清洗函数：非字符串/超长/控制字符的错误码是 INVALID_NAME(400)', () => {
    const codes = (value: unknown) => {
      try {
        normalizePokemonName(value);
        return '';
      } catch (err) {
        return splitCodedMessage((err as Error).message).code;
      }
    };
    expect(codes(undefined)).toBe('INVALID_NAME');
    expect(codes(42)).toBe('INVALID_NAME');
    expect(codes('x'.repeat(POKEMON_NAME_MAX + 1))).toBe('INVALID_NAME');
    expect(codes('好\t名')).toBe('INVALID_NAME');
    expect(codes('<好名>')).toBe('INVALID_NAME');
    expect(normalizePokemonName('  皮 卡 丘  ')).toBe('皮 卡 丘');
    expect(normalizePokemonName('皮卡丘')).toBe('皮卡丘');
  });
});
