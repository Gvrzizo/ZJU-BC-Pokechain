import { ItemsService } from '../src/items/items.service';
import { getLearnset } from '../src/game-data/learnsets.data';
import { LEVEL_MAX } from '../src/pokemon/pokemon.service';
import {
  makeChain,
  makePokemonService,
  makeRedis,
  mintBall,
  registerPlayers,
  seedPokemon,
  userIdentity,
} from './helpers';

const ash = userIdentity('ash');
const CHARMANDER = 4;
const CHARMELEON = 5;

function build() {
  const { chain, contract } = makeChain();
  const redis = makeRedis();
  const pokemon = makePokemonService(contract, redis);
  return { chain, contract, redis, pokemon, items: new ItemsService(contract, pokemon) };
}

describe('培养道具（docs/backend-api.md §3：王冠加 IV / 神奇糖果升级）', () => {
  it('银色王冠：指定一项 IV 升满 31，其余不变；消耗 1 个', async () => {
    const { chain, contract, items } = build();
    await registerPlayers(contract, 'ash');
    const cap = await mintBall(contract, 'ash', 'i_cap', 'bottle-cap', 2);
    await seedPokemon(chain, 'ash', {
      id: 'p_cap',
      ivs: { hp: 5, atk: 12, def: 0, spatk: 31, spdef: 20, speed: 7 },
    });

    const result = await items.use(ash, cap.id, { targetPokemonId: 'p_cap', stat: 'atk' });
    expect(result.used).toBe('bottle-cap');
    expect(result.pokemon!.ivs).toEqual({ hp: 5, atk: 31, def: 0, spatk: 31, spdef: 20, speed: 7 });
    expect((await contract.getItem(cap.id)).quantity).toBe(1);
    // 链上持久化
    expect((await contract.getPokemon('p_cap')).ivs.atk).toBe(31);

    // 已经 31 的那一项再喂王冠：拒绝且不消耗道具
    await expect(
      items.use(ash, cap.id, { targetPokemonId: 'p_cap', stat: 'atk' }),
    ).rejects.toThrow(/IV_MAXED/);
    expect((await contract.getItem(cap.id)).quantity).toBe(1);

    // 参数与归属校验
    await expect(items.use(ash, cap.id, { targetPokemonId: 'p_cap' })).rejects.toThrow(/STAT_REQUIRED/);
    await expect(items.use(ash, cap.id, { stat: 'atk' })).rejects.toThrow(/TARGET_REQUIRED/);
    await registerPlayers(contract, 'gary');
    await expect(
      items.use(userIdentity('gary'), cap.id, { targetPokemonId: 'p_cap', stat: 'def' }),
    ).rejects.toThrow(/NOT_OWNER/);
  });

  it('金色王冠：六项个体值一起升满 31；全满后 IV_MAXED', async () => {
    const { chain, contract, items } = build();
    await registerPlayers(contract, 'ash');
    const gold = await mintBall(contract, 'ash', 'i_gold', 'gold-bottle-cap', 2);
    await seedPokemon(chain, 'ash', {
      id: 'p_gold',
      ivs: { hp: 0, atk: 31, def: 10, spatk: 31, spdef: 3, speed: 31 },
    });

    const result = await items.use(ash, gold.id, { targetPokemonId: 'p_gold' });
    expect(result.pokemon!.ivs).toEqual({ hp: 31, atk: 31, def: 31, spatk: 31, spdef: 31, speed: 31 });
    expect((await contract.getItem(gold.id)).quantity).toBe(1);
    // 六项都满了：第二颗拒绝，不浪费道具
    await expect(items.use(ash, gold.id, { targetPokemonId: 'p_gold' })).rejects.toThrow(/IV_MAXED/);
    expect((await contract.getItem(gold.id)).quantity).toBe(1);
  });

  it('神奇糖果：+1 级、走集中升级路径（跨阈值学技能、返回 canEvolve）', async () => {
    const { chain, contract, items, pokemon } = build();
    await registerPlayers(contract, 'ash');
    const candy = await mintBall(contract, 'ash', 'i_candy', 'rare-candy', 5);
    const seed = await seedPokemon(chain, 'ash', {
      id: 'p_candy',
      speciesId: CHARMANDER,
      name: 'charmander',
      level: 13,
      exp: 13 ** 3,
      moves: ['ember', 'tackle', 'quick-attack', 'body-slam'],
    });
    expect(seed.level).toBe(13);
    // 小火龙 Lv14 学 fire-fang（学习表）
    expect(getLearnset(CHARMANDER).find((e) => e.moveId === 'fire-fang')!.level).toBe(14);

    const first = await items.use(ash, candy.id, { targetPokemonId: 'p_candy' });
    expect(first.levelsGained).toBe(1);
    expect(first.movesLearned).toEqual(['fire-fang']);
    expect(first.canEvolve).toBe(false); // Lv14：进化要 16
    const afterFirst = await contract.getPokemon('p_candy');
    expect(afterFirst.level).toBe(14);
    expect(afterFirst.exp).toBe(14 ** 3);
    expect(afterFirst.moves).toEqual(['tackle', 'quick-attack', 'body-slam', 'fire-fang']);

    // Lv15 → Lv16：可以进化，且详情里的 evolution 指向火恐龙
    await items.use(ash, candy.id, { targetPokemonId: 'p_candy' });
    const at16 = await items.use(ash, candy.id, { targetPokemonId: 'p_candy' });
    expect(at16.pokemon!.level).toBe(16);
    expect(at16.canEvolve).toBe(true);
    expect((await contract.getItem(candy.id)).quantity).toBe(2);

    const detail = await items.use(ash, candy.id, { targetPokemonId: 'p_candy' }); // → Lv17
    expect(detail.pokemon!.level).toBe(17);
    const view = await pokemon.getOne('p_candy');
    expect(view.evolution).toMatchObject({ targetSpeciesId: CHARMELEON, minLevel: 16, canEvolveNow: true });
  });

  it('神奇糖果在 100 级抛 LEVEL_MAXED（不消耗道具）', async () => {
    const { chain, contract, items } = build();
    await registerPlayers(contract, 'ash');
    const candy = await mintBall(contract, 'ash', 'i_candy_max', 'rare-candy', 1);
    await seedPokemon(chain, 'ash', { id: 'p_max', level: LEVEL_MAX, exp: LEVEL_MAX ** 3 });
    await expect(items.use(ash, candy.id, { targetPokemonId: 'p_max' })).rejects.toThrow(/LEVEL_MAXED/);
    expect((await contract.getItem(candy.id)).quantity).toBe(1);
  });

  it('未实现效果的道具（球/非培养类 other）仍然 NOT_USABLE', async () => {
    const { chain, contract, items } = build();
    await registerPlayers(contract, 'ash');
    const ball = await mintBall(contract, 'ash', 'i_ball_use', 'poke-ball', 3);
    await seedPokemon(chain, 'ash', { id: 'p_use' });

    await expect(items.use(ash, ball.id, { targetPokemonId: 'p_use' })).rejects.toThrow(/NOT_USABLE/);
  });

  it('伤药：给目标宝可梦回血 +20（不超上限）、目标必填、满血不浪费', async () => {
    const { chain, contract, pokemon, items } = build();
    await registerPlayers(contract, 'ash');
    const potion = await mintBall(contract, 'ash', 'i_potion', 'potion', 1);
    const seeded = await seedPokemon(chain, 'ash', { id: 'p_use' });
    const maxHp = pokemon.hp.maxHpOf(seeded);

    // 目标必填（伤势持久化后回血对象是链下 HP，必须指名）
    await expect(items.use(ash, potion.id, {})).rejects.toThrow(/TARGET_REQUIRED/);
    // 满血：拒绝且不消耗道具
    await expect(items.use(ash, potion.id, { targetPokemonId: 'p_use' })).rejects.toThrow(/HP_FULL/);
    expect((await contract.getItem(potion.id)).quantity).toBe(1);

    // 受伤 30 点：+20（链下 Redis 写入），道具消耗 1 个
    await pokemon.hp.set('p_use', maxHp - 30, maxHp);
    const healed = await items.use(ash, potion.id, { targetPokemonId: 'p_use' });
    expect(healed.effect).toEqual({ healAmount: 20 });
    expect(healed.hp).toMatchObject({ before: maxHp - 30, after: maxHp - 10, maxHp, healed: 20 });
    expect((await contract.getItem(potion.id)).quantity).toBe(0);
    expect(await pokemon.hp.currentHp(seeded)).toBe(maxHp - 10);

    // 已消耗：再来一次拒绝
    await expect(items.use(ash, potion.id, { targetPokemonId: 'p_use' })).rejects.toThrow(/INSUFFICIENT_QUANTITY/);
  });
});
