import { sha256hex } from '../src/common/utils/crypto.util';
import { ItemsService } from '../src/items/items.service';
import { PokemonController } from '../src/pokemon/pokemon.controller';
import { PokemonService } from '../src/pokemon/pokemon.service';
import { ADMIN_IDENTITY, SYSTEM_IDENTITY } from '../src/fabric/chain.types';
import { makeChain, makePokemonService, makeRedis, mintBall, registerPlayers, seedPokemon, userIdentity } from './helpers';

const ash = userIdentity('ash');
const CLIENT_SEED = 'bb'.repeat(16);
const SERVER_SEED = 'aa'.repeat(32);

function build() {
  const { chain, contract } = makeChain();
  const redis = makeRedis();
  const pokemon = makePokemonService(contract, redis);
  return { chain, contract, redis, pokemon, items: new ItemsService(contract, pokemon) };
}

function captureArgs(eventId: string) {
  return {
    id: `p_${eventId}`,
    playerId: 'ash',
    speciesId: 150,
    name: 'Mewtwo',
    ivs: { hp: 31, atk: 31, def: 31, spatk: 31, spdef: 31, speed: 31 },
    nature: 'timid',
    ability: 'pressure',
    shiny: true,
    moves: ['psychic'],
    dnaHash: 'e'.repeat(64),
    eventId,
  };
}

/**
 * C2/C3（docs/review-2026-10-25.md §2.1.1）：链码的铸造/揭示/养成写入只接受 system 证书，
 * 玩家（含 owner 本人）拿自己的证书不能改 level/EV/IV/species/name，也不能自造宝可梦。
 * MockChainAdapter 必须与链码同语义，否则后端 367 个单测会掩盖真链越权。
 */
describe('链码铸造/揭示/养成权限（C2/C3）', () => {
  it('RevealAndVerify：仅 system；玩家与 admin 身份都被拒，随机事件保持 COMMITTED', async () => {
    const { contract } = build();
    await registerPlayers(contract, 'ash');
    await contract.commitRandom(SYSTEM_IDENTITY, {
      eventId: 'ev_perm',
      purpose: 'capture',
      playerId: 'ash',
      commitHash: sha256hex(SERVER_SEED),
      clientSeed: CLIENT_SEED,
      meta: '',
    });
    await expect(contract.revealAndVerify(ash, 'ev_perm', SERVER_SEED)).rejects.toThrow(/FORBIDDEN/);
    await expect(contract.revealAndVerify(ADMIN_IDENTITY, 'ev_perm', SERVER_SEED)).rejects.toThrow(/FORBIDDEN/);
    expect((await contract.getRandom('ev_perm')).status).toBe('COMMITTED');
    await contract.revealAndVerify(SYSTEM_IDENTITY, 'ev_perm', SERVER_SEED);
    expect((await contract.getRandom('ev_perm')).status).toBe('REVEALED');
  });

  it('MintFromCapture：仅 system；玩家证书铸不出宝可梦，也不消耗随机事件', async () => {
    const { contract } = build();
    await registerPlayers(contract, 'ash');
    const commit = (eventId: string) =>
      contract.commitRandom(SYSTEM_IDENTITY, {
        eventId,
        purpose: 'capture',
        playerId: 'ash',
        commitHash: sha256hex(SERVER_SEED),
        clientSeed: CLIENT_SEED,
        meta: '',
      });
    await commit('ev_mint');
    await contract.revealAndVerify(SYSTEM_IDENTITY, 'ev_mint', SERVER_SEED);
    await expect(contract.mintFromCapture(ash, captureArgs('ev_mint'))).rejects.toThrow(/FORBIDDEN/);
    expect((await contract.getRandom('ev_mint')).status).toBe('REVEALED');
    // system 仍可铸造（收服/新手礼包的真实路径）
    const minted = await contract.mintFromCapture(SYSTEM_IDENTITY, captureArgs('ev_mint'));
    expect(minted).toMatchObject({ ownerId: 'ash', speciesId: 150, shiny: true, level: 5 });
  });

  it('ApplyGrowth：仅 system；owner 本人改 level/EV/IV/species/name 全部被拒，system 成功', async () => {
    const { chain, contract } = build();
    await registerPlayers(contract, 'ash');
    const mon = await seedPokemon(chain, 'ash', { id: 'p_growth' });

    for (const growth of [
      { level: 100, exp: 1000000 },
      { evs: { hp: 255, atk: 255, def: 0, spatk: 0, spdef: 0, speed: 0 } },
      { ivs: { hp: 31 } },
      { speciesId: 151 },
      { name: 'Mew' },
    ]) {
      await expect(contract.applyGrowth(ash, mon.id, growth)).rejects.toThrow(/FORBIDDEN/);
    }
    expect(await contract.getPokemon(mon.id)).toMatchObject({ level: 20, speciesId: 25, name: 'pikachu' });

    const grown = await contract.applyGrowth(SYSTEM_IDENTITY, mon.id, { level: 50, exp: 125000 });
    expect(grown).toMatchObject({ level: 50, exp: 125000 });
  });

  it('合法养成链路仍以 system 身份工作：train / rename / evolve / applyExp', async () => {
    const { chain, contract, pokemon } = build();
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', { id: 'p_legit', speciesId: 4, name: 'Charmander', level: 20 });

    const trained = await pokemon.train(ash, 'p_legit', 10);
    // 1 积分 = 4 EV：10P → 40 EV（按种族主攻项分配，小火龙特攻 60 > 物攻 52）
    expect(Object.values(trained.evs).reduce((a, b) => a + b, 0)).toBe(40);

    const renamed = await pokemon.rename(ash, 'p_legit', '小火');
    expect(renamed.name).toBe('小火');

    const evolved = await pokemon.evolve(ash, 'p_legit');
    expect(evolved.speciesId).toBe(5);

    // level = floor(cbrt(exp))：20 → 21 需要 exp ≥ 21³ = 9261
    const grown = await pokemon.applyExp(await contract.getPokemon('p_legit'), 9310);
    expect(grown.pokemon.exp).toBe(9310);
    expect(grown.pokemon.level).toBe(21);
  });
});

describe('技能获取只保留升级学习表 + TM（H6：免费学技能入口下线）', () => {
  it('PokemonController / PokemonService 不再暴露 learnMove（POST /pokemon/:id/moves/learn 已删除）', () => {
    const controller = PokemonController.prototype as unknown as Record<string, unknown>;
    const service = PokemonService.prototype as unknown as Record<string, unknown>;
    expect(controller.learnMove).toBeUndefined();
    expect(service.learnMove).toBeUndefined();
  });

  it('TM 教技能：消耗 1 个技能机、写入 moves（链上 ApplyGrowth 以 system 身份成功）', async () => {
    const { chain, contract, items } = build();
    await registerPlayers(contract, 'ash');
    const tm = await mintBall(contract, 'ash', 'i_tm_bolt', 'tm-thunderbolt', 2);
    await seedPokemon(chain, 'ash', { id: 'p_tm', moves: ['tackle', 'growl'] });

    const result = await items.use(ash, tm.id, { targetPokemonId: 'p_tm' });
    expect(result.taught).toBe('thunderbolt');
    expect(result.pokemon!.moves).toEqual(['tackle', 'growl', 'thunderbolt']);
    expect((await contract.getItem(tm.id)).quantity).toBe(1);
    expect((await contract.getPokemon('p_tm')).moves).toContain('thunderbolt');

    // 已学会再教 → MOVE_KNOWN，且不消耗道具
    await expect(items.use(ash, tm.id, { targetPokemonId: 'p_tm' })).rejects.toThrow(/MOVE_KNOWN/);
    expect((await contract.getItem(tm.id)).quantity).toBe(1);
  });
});
