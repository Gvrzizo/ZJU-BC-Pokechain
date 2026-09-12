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

  it('publicState().log 每个已结算回合都带事件与攻击/受击 id（前端中文日志的数据源）', () => {
    const engine = new BattleEngine(
      [mon('a1', 6, 50, ['flamethrower'])],
      [mon('b1', 3, 50, ['tackle'])],
      scripted([0, 0.5, 0]),
    );
    expect(engine.publicState().log).toEqual([]);

    engine.submitAction('A', { type: 'move', moveIndex: 0 });
    expect(engine.publicState().log).toEqual([]); // 单方出手：回合未结算，日志不出条目

    const { entry } = engine.submitAction('B', { type: 'move', moveIndex: 0 });
    const log = engine.publicState().log;
    expect(log).toHaveLength(1);
    expect(log[0].turn).toBe(1);
    expect(log[0].actions).toEqual({ A: { type: 'move', moveIndex: 0 }, B: { type: 'move', moveIndex: 0 } });
    expect(log[0].events).toEqual(entry!.events);

    const move = log[0].events.find((e) => e.kind === 'move' && e.side === 'A')!;
    expect(move.detail).toMatchObject({ move: 'flamethrower', attacker: 'a1', defender: 'b1' });
    const damage = log[0].events.find((e) => e.kind === 'damage')!;
    expect(damage.detail).toMatchObject({ move: 'flamethrower', attacker: 'a1', defender: 'b1' });
    expect(damage.detail.damage).toBeGreaterThan(0);
    // 推送的是副本：外部改动不会污染引擎日志
    log[0].events[0].detail.mutated = true;
    expect(engine.publicState().log[0].events[0].detail.mutated).toBeUndefined();

    // 击倒与胜负同样进日志（前端渲染"XX 倒下了！/ gary 获胜！"）
    const ko = new BattleEngine(
      [mon('a1', 149, 60, ['hyper-beam'])],
      [mon('b1', 25, 5, ['tackle'])],
      scripted([0, 0.5, 0]),
    );
    ko.submitAction('A', { type: 'move', moveIndex: 0 });
    ko.submitAction('B', { type: 'move', moveIndex: 0 });
    const last = ko.publicState().log.at(-1)!;
    const kinds = last.events.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['move', 'damage', 'faint', 'win']));
    expect(last.events.find((e) => e.kind === 'faint')!.detail.pokemonId).toBe('b1');
    expect(last.events.find((e) => e.kind === 'win')!.side).toBe('A');
  });

  it('羁绊加成进入最终能力值：非 HP 五项 × (1 + bond/255 × 5%)，伤害按含羁绊的攻击值结算', () => {
    const plain = new BattleEngine(
      [mon('a1', 25, 50, ['tackle'])],
      [mon('b1', 9, 50, ['tackle'])],
      scripted([0, 0.5, 0]),
    );
    const bonded = new BattleEngine(
      [mon('a1', 25, 50, ['tackle'], { bond: 255 })],
      [mon('b1', 9, 50, ['tackle'])],
      scripted([0, 0.5, 0]),
    );
    const stats = finalStats(25, 50);
    // HP 不吃羁绊
    expect(plain.active('A').maxHp).toBe(stats.hp);
    expect(bonded.active('A').maxHp).toBe(stats.hp);
    // 其余五项 ×1.05 向下取整
    expect(plain.active('A').atk).toBe(stats.atk);
    expect(bonded.active('A').atk).toBe(Math.floor(stats.atk * 1.05));
    expect(bonded.active('A').speed).toBe(Math.floor(stats.speed * 1.05));

    plain.submitAction('A', { type: 'move', moveIndex: 0 });
    bonded.submitAction('A', { type: 'move', moveIndex: 0 });
    const plainDamage = plain.submitAction('B', { type: 'move', moveIndex: 0 }).entry!.events.find((e) => e.kind === 'damage')!;
    const bondedDamage = bonded.submitAction('B', { type: 'move', moveIndex: 0 }).entry!.events.find((e) => e.kind === 'damage')!;
    const def = finalStats(9, 50).def;
    const base = (atk: number) => Math.floor((((2 * 50) / 5 + 2) * 40 * atk) / def / 50) + 2;
    expect(plainDamage.detail.damage).toBe(Math.floor(base(stats.atk) * 0.85));
    expect(bondedDamage.detail.damage).toBe(Math.floor(base(Math.floor(stats.atk * 1.05)) * 0.85));
    expect(bonded.active('A').atk).toBeGreaterThan(plain.active('A').atk);
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
