import { ItemsService } from '../src/items/items.service';
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

function build() {
  const { chain, contract } = makeChain();
  const redis = makeRedis();
  const pokemon = makePokemonService(contract, redis);
  return { chain, contract, redis, pokemon, items: new ItemsService(contract, pokemon) };
}

/**
 * H7（docs/review-2026-10-25.md）：锁定资产必须先校验再消耗道具/扣积分。
 * 否则伤药/糖果/TM/进化石会被消耗，随后链上 ApplyGrowth 抛 ASSET_LOCKED——道具白丢。
 */
describe('H7 锁定资产：先校验 IDLE，再消耗道具/扣积分', () => {
  it('LOCKED_BATTLE：训练/改名/放生/伤药/糖果全部 409，积分与道具原封不动', async () => {
    const { chain, contract, pokemon, items } = build();
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', {
      id: 'p_locked',
      status: 'LOCKED_BATTLE',
      lockRef: 'b_lock',
      level: 20,
      exp: 20 ** 3,
    });
    const candy = await mintBall(contract, 'ash', 'i_candy', 'rare-candy', 1);
    const potion = await mintBall(contract, 'ash', 'i_potion', 'potion', 1);

    const attempts = [
      () => pokemon.train(ash, 'p_locked', 100),
      () => pokemon.rename(ash, 'p_locked', '新昵称'),
      () => pokemon.release(ash, 'p_locked'),
      () => items.use(ash, potion.id, { targetPokemonId: 'p_locked' }),
      () => items.use(ash, candy.id, { targetPokemonId: 'p_locked' }),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toThrow(/ASSET_LOCKED/);
    }

    // 没有扣积分、没有消耗道具、没有改链上状态
    expect((await contract.getPlayer('ash')).points).toBe(1000);
    expect((await contract.getItem(potion.id)).quantity).toBe(1);
    expect((await contract.getItem(candy.id)).quantity).toBe(1);
    expect((await contract.getPokemon('p_locked'))).toMatchObject({
      level: 20,
      ownerId: 'ash',
      status: 'LOCKED_BATTLE',
      lockRef: 'b_lock',
    });

    // 解锁后恢复可用（这里用同 id 重写世界状态模拟对手确认/取消）
    await seedPokemon(chain, 'ash', { id: 'p_locked', level: 20, exp: 20 ** 3 });
    await items.use(ash, candy.id, { targetPokemonId: 'p_locked' });
    expect((await contract.getPokemon('p_locked')).level).toBe(21);
    expect((await contract.getItem(candy.id)).quantity).toBe(0);
  });

  it('LOCKED_TRADE：进化石/TM 被拒且不消耗，解锁后生效', async () => {
    const { chain, contract, pokemon, items } = build();
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', {
      id: 'p_stone',
      speciesId: 25,
      name: 'pikachu',
      level: 20,
      status: 'LOCKED_TRADE',
      lockRef: 't_lock',
    });
    await seedPokemon(chain, 'ash', {
      id: 'p_tm',
      speciesId: 4,
      name: 'charmander',
      level: 20,
      moves: ['tackle'],
      status: 'LOCKED_TRADE',
      lockRef: 't_lock',
    });
    const stone = await mintBall(contract, 'ash', 'i_stone', 'thunder-stone', 1);
    const tm = await mintBall(contract, 'ash', 'i_tm', 'tm-thunderbolt', 1);

    await expect(pokemon.evolve(ash, 'p_stone', stone.id)).rejects.toThrow(/ASSET_LOCKED/);
    await expect(items.use(ash, tm.id, { targetPokemonId: 'p_tm' })).rejects.toThrow(/ASSET_LOCKED/);
    expect((await contract.getItem(stone.id)).quantity).toBe(1);
    expect((await contract.getItem(tm.id)).quantity).toBe(1);
    expect((await contract.getPokemon('p_stone')).speciesId).toBe(25);
    expect((await contract.getPokemon('p_tm')).moves).toEqual(['tackle']);

    // 解锁后两条路径都生效
    await seedPokemon(chain, 'ash', { id: 'p_stone', speciesId: 25, name: 'pikachu', level: 20 });
    await seedPokemon(chain, 'ash', { id: 'p_tm', speciesId: 4, name: 'charmander', level: 20, moves: ['tackle'] });
    const evolved = await pokemon.evolve(ash, 'p_stone', stone.id);
    expect(evolved.speciesId).toBe(26);
    expect((await contract.getItem(stone.id)).quantity).toBe(0);
    await items.use(ash, tm.id, { targetPokemonId: 'p_tm' });
    expect((await contract.getPokemon('p_tm')).moves).toContain('thunderbolt');
    expect((await contract.getItem(tm.id)).quantity).toBe(0);
  });
});
