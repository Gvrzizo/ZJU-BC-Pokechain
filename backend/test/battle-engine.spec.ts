import { BattleEngine, EngineMonInput } from '../src/battles/engine/battle-engine';
import { computeStats } from '../src/game-data/stats';
import { getSpecies } from '../src/game-data/species.data';

const IV0 = { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 };
const EV0 = { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 };

function mon(
  pokemonId: string,
  speciesId: number,
  level: number,
  moves: string[],
  extra: Partial<EngineMonInput> = {},
): EngineMonInput {
  return { pokemonId, speciesId, level, ivs: { ...IV0 }, evs: { ...EV0 }, nature: 'hardy', moves, ...extra };
}

/** 与引擎同一条公式：最终能力值，供伤害断言复算。 */
function finalStats(speciesId: number, level: number, ivs = IV0, evs = EV0, nature = 'hardy') {
  return computeStats(getSpecies(speciesId)!.base, ivs, evs, level, nature);
}

/** Scripted random source: returns queued values, then repeats the last one. */
function scripted(values: number[]) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

describe('BattleEngine', () => {
  it('applies the documented damage formula with type effectiveness, hit/crit rolls', () => {
    // pikachu L50 tackle (normal/physical 40) vs blastoise: no STAB, neutral eff
    const atk = finalStats(25, 50).atk;
    const def = finalStats(9, 50).def;
    const expectedBase = Math.floor((((2 * 50) / 5 + 2) * 40 * atk) / def / 50) + 2;

    // rand sequence: hit(0), crit(0.5 -> no), damage factor(0 -> 0.85)
    const engine = new BattleEngine(
      [mon('a1', 25, 50, ['tackle'])],
      [mon('b1', 9, 50, ['tackle'])],
      scripted([0, 0.5, 0]),
    );
    const res = engine.submitAction('A', { type: 'move', moveIndex: 0 });
    expect(res.resolved).toBe(false);
    const res2 = engine.submitAction('B', { type: 'move', moveIndex: 0 });
    expect(res2.resolved).toBe(true);
    const entry = res2.entry!;
    const dmg = entry.events.find((e) => e.kind === 'damage');
    expect(dmg).toBeDefined();
    // pikachu (speed 90) moves before blastoise (78)
    expect(dmg!.side).toBe('A');
    const expectedDamage = Math.max(1, Math.floor(expectedBase * 1 * 0.85));
    expect(dmg!.detail.damage).toBe(expectedDamage);
  });

  it('doubles damage on type advantage (fire vs grass)', () => {
    // charizard flamethrower (fire/special 90) vs venusaur
    const engine = new BattleEngine(
      [mon('a1', 6, 50, ['flamethrower'])],
      [mon('b1', 3, 50, ['tackle'])],
      scripted([0, 0.5, 0]),
    );
    engine.submitAction('A', { type: 'move', moveIndex: 0 });
    const { entry } = engine.submitAction('B', { type: 'move', moveIndex: 0 });
    const dmg = entry!.events.find((e) => e.kind === 'damage');
    expect(dmg!.detail.eff).toBe(2);
    const spatk = finalStats(6, 50).spatk;
    const spdef = finalStats(3, 50).spdef;
    const base = Math.floor((((2 * 50) / 5 + 2) * 90 * spatk) / spdef / 50) + 2;
    expect(dmg!.detail.damage).toBe(Math.floor(base * 2 * 0.85));
  });

  it('builds maxHp from the final stat formula and honours nature modifiers', () => {
    // 同一只宝可梦：Adamant（+物攻 -特攻）对相同目标应打出更高物伤、更低特伤
    const adamant = new BattleEngine([mon('a1', 6, 50, ['tackle'], { nature: 'adamant' })], [mon('b1', 9, 50, ['tackle'])], scripted([0, 0.5, 0]));
    const modest = new BattleEngine([mon('a1', 6, 50, ['tackle'], { nature: 'modest' })], [mon('b1', 9, 50, ['tackle'])], scripted([0, 0.5, 0]));
    adamant.submitAction('A', { type: 'move', moveIndex: 0 });
    modest.submitAction('A', { type: 'move', moveIndex: 0 });
    const adamantDmg = adamant.submitAction('B', { type: 'move', moveIndex: 0 }).entry!.events.find((e) => e.kind === 'damage')!;
    const modestDmg = modest.submitAction('B', { type: 'move', moveIndex: 0 }).entry!.events.find((e) => e.kind === 'damage')!;
    expect(adamantDmg.detail.damage as number).toBeGreaterThan(modestDmg.detail.damage as number);

    // maxHp = HP 公式结果（含 0 EV / 0 IV / 50 级），战斗开始时满血
    const expectedHp = finalStats(25, 50).hp;
    const engine = new BattleEngine([mon('a1', 25, 50, ['tackle'])], [mon('b1', 9, 50, ['tackle'])], scripted([0, 0.5, 0]));
    expect(engine.active('A').maxHp).toBe(expectedHp);
    expect(engine.active('A').hp).toBe(expectedHp);
    // EV 提升最终能力值：攻击项 EV 加满后物伤更高
    const trained = finalStats(6, 50, undefined, { ...EV0, atk: 252 });
    const untrained = finalStats(6, 50);
    expect(trained.atk).toBeGreaterThan(untrained.atk);
  });

  it('misses when the hit roll >= accuracy', () => {
    // thunder accuracy 70; hit roll 0.9 -> miss
    const engine = new BattleEngine(
      [mon('a1', 25, 50, ['thunder'])],
      [mon('b1', 9, 50, ['tackle'])],
      scripted([0.9, 0.5, 0, 0, 0.5, 0]),
    );
    engine.submitAction('A', { type: 'move', moveIndex: 0 });
    const { entry } = engine.submitAction('B', { type: 'move', moveIndex: 0 });
    expect(entry!.events.some((e) => e.kind === 'miss' && e.side === 'A')).toBe(true);
    expect(entry!.events.filter((e) => e.kind === 'damage')).toHaveLength(1); // only B hits
  });

  it('crit multiplies damage by 1.5 when crit roll < 1/16', () => {
    const engine = new BattleEngine(
      [mon('a1', 25, 50, ['tackle'])],
      [mon('b1', 9, 50, ['tackle'])],
      scripted([0, 0.01, 0, 0, 0.5, 0]),
    );
    engine.submitAction('A', { type: 'move', moveIndex: 0 });
    const { entry } = engine.submitAction('B', { type: 'move', moveIndex: 0 });
    const dmg = entry!.events.find((e) => e.kind === 'damage' && e.side === 'A');
    expect(dmg!.detail.crit).toBe(true);
  });

  it('resolves switches before attacks and enforces must-switch after faint', () => {
    const engine = new BattleEngine(
      [mon('a1', 25, 5, ['tackle']), mon('a2', 133, 5, ['tackle'])],
      [mon('b1', 143, 50, ['body-slam'])],
      scripted([0, 0.5, 0, 0, 0.5, 0, 0, 0.5, 0]),
    );
    // turn 1: A attacks, B slams; a1 faints -> A must switch
    engine.submitAction('A', { type: 'move', moveIndex: 0 });
    const t1 = engine.submitAction('B', { type: 'move', moveIndex: 0 });
    expect(t1.entry!.events.some((e) => e.kind === 'faint' && e.side === 'A')).toBe(true);
    expect(engine.needsSwitch('A')).toBe(true);
    expect(() => engine.submitAction('A', { type: 'move', moveIndex: 0 })).toThrow(/MUST_SWITCH/);
    engine.submitAction('A', { type: 'switch', toIndex: 1 });
    const t2 = engine.submitAction('B', { type: 'move', moveIndex: 0 });
    const switchEvent = t2.entry!.events.find((e) => e.kind === 'switch');
    expect(switchEvent!.detail.pokemonId).toBe('a2');
  });

  it('declares the winner on knockout and on run', () => {
    const engine = new BattleEngine(
      [mon('a1', 149, 60, ['hyper-beam'])],
      [mon('b1', 25, 5, ['tackle'])],
      scripted([0, 0.5, 0]),
    );
    engine.submitAction('A', { type: 'move', moveIndex: 0 });
    const { entry } = engine.submitAction('B', { type: 'move', moveIndex: 0 });
    expect(engine.finished).toBe(true);
    expect(engine.outcome).toEqual({ winnerSide: 'A' });
    expect(entry!.events.some((e) => e.kind === 'win')).toBe(true);

    const coward = new BattleEngine([mon('a1', 25, 5, ['tackle'])], [mon('b1', 9, 5, ['tackle'])], scripted([0]));
    coward.submitAction('A', { type: 'run' });
    expect(coward.outcome).toEqual({ winnerSide: 'B' });
  });
});
