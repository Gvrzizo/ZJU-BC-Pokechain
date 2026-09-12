import { LEARNSETS, getLearnset } from '../src/game-data/learnsets.data';
import { MOVES } from '../src/game-data/moves.data';
import { EVOLUTIONS, SPECIES, getSpecies } from '../src/game-data/species.data';
import { applyLearned, movesCrossing, movesKnownAt } from '../src/pokemon/learnset';
import { canEvolveNow, evolutionSteps, levelEvolutionRule } from '../src/pokemon/evolution';
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
  return { chain, contract, redis, pokemon };
}

/** 小火龙（#4，fire，base 形态）。 */
const CHARMANDER = 4;
const CHARMELEON = 5;
const CHARIZARD = 6;

describe('升级学习表（#1–386 数据完整性，docs/backend-api.md §2）', () => {
  it('#1–386 每个种族 4-8 条学习记录，等级 1-100 且严格递增，技能都在技能表里', () => {
    const ids = Object.keys(LEARNSETS).map(Number).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 386 }, (_, i) => i + 1));
    for (const id of ids) {
      const entries = LEARNSETS[id];
      expect([id, entries.length >= 4 && entries.length <= 8]).toEqual([id, true]);
      let prev = 0;
      for (const entry of entries) {
        expect([id, Number.isInteger(entry.level), entry.level > prev, entry.level <= 100]).toEqual([id, true, true, true]);
        expect([id, entry.moveId, MOVES[entry.moveId] !== undefined]).toEqual([id, entry.moveId, true]);
        prev = entry.level;
      }
      // 去重：同一个技能不在同一张表里出现两次
      expect([id, new Set(entries.map((e) => e.moveId)).size]).toEqual([id, entries.length]);
    }
  });

  it('威力梯度：低威力早出、高威力晚出（小火龙 ember Lv1 → fire-fang → flamethrower Lv28 → fire-blast Lv40）', () => {
    const learnset = getLearnset(CHARMANDER);
    const at = (moveId: string) => learnset.find((e) => e.moveId === moveId)!;
    expect(at('ember').level).toBe(1);
    expect(at('fire-fang').level).toBeGreaterThan(at('ember').level);
    expect(at('flamethrower').level).toBeGreaterThan(at('fire-fang').level);
    expect(at('fire-blast').level).toBeGreaterThan(at('flamethrower').level);
    expect(at('flamethrower').level).toBe(28);
    expect(at('fire-blast').level).toBe(40);
  });

  it('进化阶段偏移：进化型同系技能阈值更晚，喷火龙与小火龙的学习表必须不同', () => {
    const charmander = Object.fromEntries(getLearnset(CHARMANDER).map((e) => [e.moveId, e.level]));
    const charmeleon = Object.fromEntries(getLearnset(CHARMELEON).map((e) => [e.moveId, e.level]));
    const charizard = Object.fromEntries(getLearnset(CHARIZARD).map((e) => [e.moveId, e.level]));

    expect(charmeleon['fire-blast']).toBeGreaterThan(charmander['fire-blast']);
    expect(charizard['fire-blast']).toBeGreaterThan(charmeleon['fire-blast']);
    expect(JSON.stringify(getLearnset(CHARMANDER))).not.toBe(JSON.stringify(getLearnset(CHARIZARD)));

    // 最终形态解锁副属性池：喷火龙 Lv36 学 wing-attack（spec 示例）
    expect(charizard['wing-attack']).toBe(36);
    expect(charmander['wing-attack']).toBeUndefined();

    // 本系优先：每条学习记录都在该种族技能池里能"讲得通"（STAB、副属性池或一般属性）
    for (const [moveId, level] of Object.entries(charmander)) {
      expect([moveId, level > 0]).toEqual([moveId, true]);
      expect(['fire', 'normal']).toContain(MOVES[moveId].type);
    }
  });

  it('技能池不足 4 条的属性用招牌技能/一般属性补齐（每个种族都拿得满 4 条）', () => {
    // 冰属性只有 ice-beam 一个技能：用 defaultMoves + 一般属性补齐
    const lapras = getLearnset(131);
    expect(lapras.length).toBeGreaterThanOrEqual(4);
    expect(lapras.some((e) => e.moveId === 'ice-beam')).toBe(true);
    // 妙蛙花（草，最终形态）8 条：6 条草 + 2 条副属性（毒）
    const venusaur = getLearnset(3).map((e) => e.moveId);
    expect(venusaur.length).toBe(8);
    expect(venusaur).toContain('sludge-bomb');
  });
});

describe('升级学技能（learnset.ts）》', () => {
  it('movesCrossing 只取跨过的阈值（不含起点等级），跳过已会的技能', () => {
    // 小火龙：14 学 fire-fang、26 学 blaze-kick、28 学 flamethrower
    expect(movesCrossing(CHARMANDER, 13, 15, [])).toEqual(['fire-fang']);
    expect(movesCrossing(CHARMANDER, 14, 15, [])).toEqual([]);
    expect(movesCrossing(CHARMANDER, 1, 40, ['ember', 'fire-fang'])).toEqual([
      'blaze-kick',
      'flamethrower',
      'fire-blast',
    ]);
    expect(movesCrossing(CHARMANDER, 40, 41, [])).toEqual([]);
  });

  it('applyLearned：不满 4 招直接学；满 4 招替换最早学的（队首）', () => {
    expect(applyLearned(['ember', 'tackle'], ['fire-fang'])).toEqual({
      moves: ['ember', 'tackle', 'fire-fang'],
      learned: ['fire-fang'],
    });
    expect(applyLearned(['ember', 'tackle', 'quick-attack', 'body-slam'], ['fire-fang'])).toEqual({
      moves: ['tackle', 'quick-attack', 'body-slam', 'fire-fang'],
      learned: ['fire-fang'],
    });
  });

  it('applyLearned：一次学两招时不会把本批刚学的又替换掉', () => {
    const result = applyLearned(['ember', 'tackle', 'quick-attack', 'body-slam'], ['fire-fang', 'blaze-kick']);
    expect(result.learned).toEqual(['fire-fang', 'blaze-kick']);
    expect(result.moves).toEqual(['quick-attack', 'body-slam', 'fire-fang', 'blaze-kick']);
  });

  it('movesKnownAt：进化补学只取新种族学习表里等级已达标的技能', () => {
    // 喷火龙 Lv36：ember(25) 已会、wing-attack(36) 可补学、fire-blast(64) 不行
    expect(movesKnownAt(CHARIZARD, 36, ['ember'])).toEqual(['wing-attack']);
    expect(movesKnownAt(CHARIZARD, 36, ['ember', 'wing-attack'])).toEqual([]);
    expect(movesKnownAt(CHARIZARD, 25, [])).toEqual(['ember']);
  });
});

describe('PokemonService.applyExp：集中升级路径', () => {
  it('升级跨阈值学技能；升到 16 级后 canEvolve = true', async () => {
    const { chain, contract, pokemon } = build();
    await registerPlayers(contract, 'ash');
    const seed = await seedPokemon(chain, 'ash', {
      id: 'p_charm',
      speciesId: CHARMANDER,
      name: 'charmander',
      level: 13,
      exp: 13 ** 3,
      moves: ['ember', 'tackle', 'quick-attack', 'body-slam'],
    });

    // 13 级 → 15 级（exp 3375 = 15^3）
    const outcome = await pokemon.applyExp(seed, 15 ** 3 - seed.exp);
    expect(outcome.levelsGained).toBe(2);
    expect(outcome.pokemon.level).toBe(15);
    expect(outcome.movesLearned).toEqual(['fire-fang']);
    expect(outcome.pokemon.moves).toEqual(['tackle', 'quick-attack', 'body-slam', 'fire-fang']);
    expect(outcome.canEvolve).toBe(false); // 进化要 16 级

    // 15 级 → 16 级：同样的经验曲线，跨过 Lv16 后可以进化了
    const at16 = await pokemon.applyExp(outcome.pokemon, 16 ** 3 - outcome.pokemon.exp);
    expect(at16.pokemon.level).toBe(16);
    expect(at16.canEvolve).toBe(true);
    expect(at16.pokemon.evolution).toMatchObject({
      targetSpeciesId: CHARMELEON,
      minLevel: 16,
      canEvolveNow: true,
    });

    // 链上持久化：exp/level/moves 都是权威来源
    const onChain = await contract.getPokemon('p_charm');
    expect(onChain.level).toBe(16);
    expect(onChain.exp).toBe(16 ** 3);
    expect(onChain.moves).toEqual(['tackle', 'quick-attack', 'body-slam', 'fire-fang']);
  });

  it('经验为 0 或负数时不写链（幂等重放/空结算不产生交易）', async () => {
    const { chain, contract, pokemon } = build();
    await registerPlayers(contract, 'ash');
    const seed = await seedPokemon(chain, 'ash', { id: 'p_zero', level: 10, exp: 1000 });
    const outcome = await pokemon.applyExp(seed, 0);
    expect(outcome.levelsGained).toBe(0);
    expect(outcome.movesLearned).toEqual([]);
    expect((await contract.getPokemon('p_zero')).exp).toBe(1000);
  });

  it('grantBattleWinExp：参战队伍每只 +30 经验，同一场战局重放不重复加', async () => {
    const { chain, contract, pokemon } = build();
    await registerPlayers(contract, 'ash', 'gary');
    const a = await seedPokemon(chain, 'ash', { id: 'p_team_a', level: 20, exp: 8000 });
    const b = await seedPokemon(chain, 'ash', { id: 'p_team_b', level: 20, exp: 8000 });

    const granted = await pokemon.grantBattleWinExp('ash', [a.id, b.id], 'b_exp_1');
    expect(granted.map((g) => g.pokemonId)).toEqual([a.id, b.id]);
    expect((await contract.getPokemon(a.id)).exp).toBe(8030);
    expect((await contract.getPokemon(b.id)).exp).toBe(8030);

    // 重放（同一 battleId）：链上幂等键命中，经验不叠加
    await pokemon.grantBattleWinExp('ash', [a.id, b.id], 'b_exp_1');
    expect((await contract.getPokemon(a.id)).exp).toBe(8030);
  });
});

describe('进化（等级进化 + 进化石 + 补学，docs/backend-api.md §2）', () => {
  it('等级进化：达标即可进化，不消耗道具；等级不够 LEVEL_TOO_LOW', async () => {
    const { chain, contract, pokemon } = build();
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', { id: 'p_evo', speciesId: CHARMANDER, level: 15 });
    await expect(pokemon.evolve(ash, 'p_evo')).rejects.toThrow(/LEVEL_TOO_LOW/);

    await contract.applyGrowth(
      { mspId: 'Org1MSP', role: 'system', userId: 'system' },
      'p_evo',
      { level: 16, exp: 16 ** 3 },
    );
    const evolved = await pokemon.evolve(ash, 'p_evo');
    expect(evolved.speciesId).toBe(CHARMELEON);
    expect(evolved.name).toBe('charmeleon');
    expect(evolved.evolution).toMatchObject({ targetSpeciesId: CHARIZARD, minLevel: 36, canEvolveNow: false });
  });

  it('进化后按新学习表补学：小火龙 → 火恐龙 → 喷火龙 Lv36 学会 wing-attack', async () => {
    const { chain, contract, pokemon } = build();
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', {
      id: 'p_chain_evo',
      speciesId: CHARMANDER,
      level: 36,
      exp: 36 ** 3,
      moves: ['ember', 'fire-fang', 'flamethrower', 'fire-blast'],
    });

    const charmeleon = await pokemon.evolve(ash, 'p_chain_evo');
    expect(charmeleon.speciesId).toBe(CHARMELEON);
    // 火恐龙表里 ≤36 级的技能都已会，没有新技能
    expect(charmeleon.moves).toEqual(['ember', 'fire-fang', 'flamethrower', 'fire-blast']);

    const charizard = await pokemon.evolve(ash, 'p_chain_evo');
    expect(charizard.speciesId).toBe(CHARIZARD);
    // 喷火龙 Lv36 学 wing-attack：满 4 招 → 替换最早学的 ember
    expect(charizard.moves).toEqual(['fire-fang', 'flamethrower', 'fire-blast', 'wing-attack']);
    expect(charizard.evolution).toBeNull(); // 最终形态没有下一段
  });

  it('进化石进化：只有对应石头能进化，等级不够同样拒绝', async () => {
    const { chain, contract, pokemon } = build();
    await registerPlayers(contract, 'ash');
    const stone = await mintBall(contract, 'ash', 'i_thunder', 'thunder-stone', 2);
    const evolvedByLevel = await seedPokemon(chain, 'ash', { id: 'p_pika', speciesId: 25, level: 20 });
    expect(evolvedByLevel.speciesId).toBe(25);

    // 皮卡丘（#25）的进化分支只有雷之石：不带石头走等级路径 → NO_EVOLUTION
    await expect(pokemon.evolve(ash, 'p_pika')).rejects.toThrow(/NO_EVOLUTION/);
    const raichu = await pokemon.evolve(ash, 'p_pika', stone.id);
    expect(raichu.speciesId).toBe(26);
    expect(raichu.evolution).toBeNull();
    expect((await contract.getItem(stone.id)).quantity).toBe(1);

    // 等级不足时不能吃石头
    await seedPokemon(chain, 'ash', { id: 'p_pika_low', speciesId: 25, level: 10 });
    await expect(pokemon.evolve(ash, 'p_pika_low', stone.id)).rejects.toThrow(/LEVEL_TOO_LOW/);
    // 非进化石（精灵球）不是石头
    const ball = await mintBall(contract, 'ash', 'i_not_stone', 'poke-ball', 1);
    await expect(pokemon.evolve(ash, 'p_pika_low', ball.id)).rejects.toThrow(/NOT_A_STONE/);
  });

  it('没有进化分支的种族：详情 evolution = null，evolutions = []', async () => {
    const { chain, contract, pokemon } = build();
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', { id: 'p_snorlax', speciesId: 143, level: 30 });
    const detail = await pokemon.getOne('p_snorlax');
    expect(detail.evolution).toBeNull();
    expect(detail.evolutions).toEqual([]);
  });

  it('分支进化（伊布 5 条线）都列在 evolutions 里：石头线不算"可以进化"，等级线排在前面', async () => {
    const { chain, contract, pokemon } = build();
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', { id: 'p_eevee', speciesId: 133, level: 30 });
    const detail = await pokemon.getOne('p_eevee');
    expect(detail.evolutions.map((e) => e.targetSpeciesId).sort()).toEqual([134, 135, 136, 196, 197]);
    const stones = detail.evolutions.filter((e) => e.stoneTypeId);
    expect(stones.map((e) => e.stoneTypeId).sort()).toEqual(['fire-stone', 'thunder-stone', 'water-stone']);
    expect(stones.every((e) => !e.canEvolveNow && e.levelOk)).toBe(true);
    // 太阳伊布/月亮伊布（EVOLUTIONS 里是保守默认等级的"非等级进化"）：等级达标即可进化
    expect(detail.evolutions.filter((e) => e.canEvolveNow).map((e) => e.targetSpeciesId)).toEqual([196, 197]);
    expect(detail.evolution).toMatchObject({ targetSpeciesId: 196, canEvolveNow: true });
    expect(canEvolveNow(25, 100)).toBe(false); // 皮卡丘只能靠石头
  });

  it('EVOLUTIONS 覆盖的每个种族都有一致的学习表入口（无缺号、可查询）', () => {
    for (const rule of EVOLUTIONS) {
      expect(getLearnset(rule.from).length).toBeGreaterThanOrEqual(4);
      expect(getLearnset(rule.to).length).toBeGreaterThanOrEqual(4);
      expect(getSpecies(rule.from)).toBeDefined();
      expect(getSpecies(rule.to)).toBeDefined();
      expect(evolutionSteps(rule.from, 100).some((s) => s.targetSpeciesId === rule.to)).toBe(true);
    }
    // 等级进化规则能按等级挑出来
    expect(levelEvolutionRule(CHARMANDER, 16)?.to).toBe(CHARMELEON);
    expect(levelEvolutionRule(CHARMANDER, 15)).toBeUndefined();
    expect(levelEvolutionRule(25, 100)).toBeUndefined(); // 皮卡丘只能靠石头
    expect(SPECIES[CHARIZARD].name).toBe('charizard');
  });
});
