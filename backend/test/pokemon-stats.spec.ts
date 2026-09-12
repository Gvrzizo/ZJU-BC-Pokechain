import { Subject } from 'rxjs';
import { CaptureService } from '../src/pokemon/capture.service';
import { PokemonService } from '../src/pokemon/pokemon.service';
import { computeStats, evTotal, EV_MAX_PER_STAT, EV_MAX_TOTAL } from '../src/game-data/stats';
import { getSpecies } from '../src/game-data/species.data';
import { sha256hex } from '../src/common/utils/crypto.util';
import {
  makeChain,
  makeHpService,
  makeRedis,
  mintBall,
  mockRepo,
  registerPlayers,
  seedPokemon,
  userIdentity,
} from './helpers';

/**
 * 能力值计算链路：链上只存 IV/EV/性格，链下按官方公式算最终能力值
 * （docs/backend-api.md §2「能力值计算」）。
 */
function makeService() {
  const { chain, contract } = makeChain();
  const redis = makeRedis();
  const events = { stream$: new Subject().asObservable() };
  const service = new PokemonService(contract, redis, events as never, makeHpService(redis), mockRepo() as never);
  return { chain, contract, redis, service };
}

describe('PokemonService：六项最终能力值与 EV', () => {
  it('详情附带 computeStats 计算的能力值（旧记录缺 evs 时按全 0 处理）', async () => {
    const { chain, contract, service } = makeService();
    await registerPlayers(contract, 'ash');
    const seeded = await seedPokemon(chain, 'ash', { id: 'p_legacy', level: 50 });
    // 模拟 evs 字段上线前的链上记录
    const legacy = { ...(seeded as unknown as Record<string, unknown>) };
    delete legacy.evs;
    (chain as unknown as { put: (k: string, v: unknown) => void }).put('pokemon:p_legacy', legacy);

    const detail = await service.getOne('p_legacy');
    const species = getSpecies(detail.speciesId)!;
    expect(detail.evs).toEqual({ hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 });
    expect(detail.stats).toEqual(
      computeStats(species.base, detail.ivs, detail.evs, detail.level, detail.nature),
    );

    const list = await service.listMine('ash');
    expect(list[0].stats).toEqual(detail.stats);
  });

  it('捕捉铸造：evs 全 0，接口直接返回 stats（真实 Commit→Reveal→Mint 流程）', async () => {
    const { chain, contract } = makeChain();
    const redis = makeRedis();
    const capture = new CaptureService(chain, contract, redis);
    const service = new PokemonService(contract, redis, { stream$: new Subject().asObservable() } as never, makeHpService(redis), mockRepo() as never);
    await registerPlayers(contract, 'ash');
    const ball = await mintBall(contract, 'ash', 'i_ball_capture', 'poke-ball', 5);
    const ash = userIdentity('ash');

    const eventId = 'ev_test_0'; // n=2 的判定 < 皮卡丘捕获率 → 首次 attempt 命中
    await contract.commitRandom(ash, {
      eventId,
      purpose: 'capture',
      playerId: 'ash',
      commitHash: sha256hex('aa'.repeat(32)),
      clientSeed: 'bb'.repeat(16),
    });
    await redis.setJson(`capture:${eventId}`, {
      playerId: 'ash',
      serverSeed: 'aa'.repeat(32),
      clientSeed: 'bb'.repeat(16),
      attempts: 0,
      speciesId: 25,
      wildLevel: 10,
    });
    const caught = await capture.attempt(ash, eventId, ball.id);
    if (!caught.success) throw new Error('expected capture success');

    expect(caught.pokemon.evs).toEqual({ hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 });
    const species = getSpecies(caught.pokemon.speciesId)!;
    expect(caught.pokemon.stats).toEqual(
      computeStats(species.base, caught.pokemon.ivs, caught.pokemon.evs, caught.pokemon.level, caught.pokemon.nature),
    );
    expect((await service.getOne(caught.pokemon.id)).stats).toEqual(caught.pokemon.stats);
  });

  it('详情/列表附带 bondBonus 百分比（羁绊战斗加成，非 HP 五项），stats 仍为基础最终值', async () => {
    const { chain, contract, redis, service } = makeService();
    await registerPlayers(contract, 'ash');
    const bare = await seedPokemon(chain, 'ash', { id: 'p_bond_0', level: 50, bond: 0 });
    const minted = await seedPokemon(chain, 'ash', { id: 'p_bond_50', level: 50, bond: 50 });
    const half = await seedPokemon(chain, 'ash', { id: 'p_bond_128', level: 50, bond: 128 });
    const full = await seedPokemon(chain, 'ash', { id: 'p_bond_255', level: 50, bond: 255 });

    expect((await service.getOne(bare.id)).bondBonus).toBe(0);
    expect((await service.getOne(minted.id)).bondBonus).toBe(0.98);
    expect((await service.getOne(half.id)).bondBonus).toBe(2.51);
    expect((await service.getOne(full.id)).bondBonus).toBe(5);
    // ioredis-mock 在同进程内共享数据：先清掉上一个用例留下的列表缓存再验证列表形态
    await redis.del('cache:pokemon:ash');
    expect((await service.listMine('ash')).find((p) => p.id === full.id)?.bondBonus).toBe(5);

    // stats 不含羁绊（API 口径 = 链下基础最终值），战斗引擎在出战时才乘上加成
    const detail = await service.getOne(full.id);
    const species = getSpecies(detail.speciesId)!;
    expect(detail.stats).toEqual(computeStats(species.base, detail.ivs, detail.evs, detail.level, detail.nature));
  });

  it('特训只加 EV：每点花费 4 EV、主攻项优先；不加 exp/等级（积分不再换等级）', async () => {
    const { chain, contract, service } = makeService();
    await registerPlayers(contract, 'ash');
    const seeded = await seedPokemon(chain, 'ash', { id: 'p_train', level: 20 });
    const ash = userIdentity('ash');
    const species = getSpecies(seeded.speciesId)!;
    const before = await service.getOne('p_train');

    const after = await service.train(ash, 'p_train', 10); // 10 点 => 40 EV
    expect(after.evs!.atk).toBe(40); // 皮卡丘物攻 55 > 特攻 50 => 主攻项
    expect(evTotal(after.evs)).toBe(40);
    // 回归断言：训练不再给经验/等级（升级只走战斗经验与神奇糖果）
    expect(after.exp).toBe(before.exp);
    expect(after.level).toBe(before.level);
    expect(after.stats!.atk).toBe(
      computeStats(species.base, after.ivs, after.evs!, after.level, after.nature).atk,
    );
    expect(after.stats!.atk).toBeGreaterThanOrEqual(before.stats!.atk);

    // 链上也持久化了 EV，exp/level 原样
    const onChain = await contract.getPokemon('p_train');
    expect(onChain.evs.atk).toBe(40);
    expect(onChain.exp).toBe(before.exp);
    expect(onChain.level).toBe(before.level);
  });

  it('EV 上限：单项 255、总和 510；满额后训练报 EV_MAXED 且不扣积分', async () => {
    const { chain, contract, service } = makeService();
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', {
      id: 'p_maxed',
      level: 50,
      evs: { hp: 255, atk: 255, def: 0, spatk: 0, spdef: 0, speed: 0 },
    });
    const ash = userIdentity('ash');
    const pointsBefore = (await contract.getPlayer('ash')).points;
    await expect(service.train(ash, 'p_maxed', 10)).rejects.toThrow(/EV_MAXED/);
    expect((await contract.getPlayer('ash')).points).toBe(pointsBefore);

    // 总和已达 510 但单项未满（上限 252 型分配）：同样拒绝，不扣积分
    await seedPokemon(chain, 'ash', {
      id: 'p_total_cap',
      level: 50,
      evs: { hp: 4, atk: 252, def: 0, spatk: 252, spdef: 0, speed: 2 },
    });
    await expect(service.train(ash, 'p_total_cap', 1)).rejects.toThrow(/EV_MAXED/);
    expect((await contract.getPlayer('ash')).points).toBe(pointsBefore);

    // 单项已满时溢出到下一优先级，单项不超过 255、总和不超过 510
    await seedPokemon(chain, 'ash', {
      id: 'p_partial',
      level: 50,
      evs: { hp: 0, atk: 252, def: 0, spatk: 0, spdef: 0, speed: 0 },
    });
    const grown = await service.train(ash, 'p_partial', 4); // 16 EV
    expect(grown.evs!.atk).toBe(EV_MAX_PER_STAT);
    expect(grown.evs!.speed).toBe(13);
    expect(evTotal(grown.evs)).toBeLessThanOrEqual(EV_MAX_TOTAL);
  });

  it('链码 ApplyGrowth 拒绝非法 EV（总和超 510 抛错且不落库）', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', { id: 'p_invalid' });
    const { SYSTEM_IDENTITY } = await import('../src/fabric/chain.types');
    await expect(
      contract.applyGrowth(SYSTEM_IDENTITY, 'p_invalid', {
        evs: { hp: 255, atk: 255, def: 255, spatk: 0, spdef: 0, speed: 0 },
      }),
    ).rejects.toThrow(/INVALID_PARAM/);
    expect((await contract.getPokemon('p_invalid')).evs).toEqual({
      hp: 0,
      atk: 0,
      def: 0,
      spatk: 0,
      spdef: 0,
      speed: 0,
    });
  });
});
