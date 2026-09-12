import { BattleEngine, EngineMonInput } from '../src/battles/engine/battle-engine';
import {
  applyMoveEffect,
  changeStatStage,
  computeDamage,
  effectiveStat,
  newConditions,
  paralysisSkips,
  residualDamage,
  setStatus,
  speedForOrder,
  statStageMultiplier,
  type EffectTarget,
} from '../src/battles/engine/battle-math';
import { MOVES, getMove, MoveDef } from '../src/game-data/moves.data';
import { getSpecies } from '../src/game-data/species.data';
import { computeStats } from '../src/game-data/stats';

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

function finalStats(speciesId: number, level: number) {
  return computeStats(getSpecies(speciesId)!.base, IV0, EV0, level, 'hardy');
}

/** Scripted random source: returns queued values, then repeats the last one. */
function scripted(values: number[]) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

function target(overrides: Partial<EffectTarget> = {}): EffectTarget {
  const conditions = newConditions();
  return { hp: 50, maxHp: 100, ...conditions, ...overrides };
}

describe('技能表：effectText 与结构化效果', () => {
  it('全部 43 个技能都有非空的中文效果说明', () => {
    const moves = Object.values(MOVES);
    expect(moves).toHaveLength(43);
    for (const move of moves) {
      expect(typeof move.effectText).toBe('string');
      expect(move.effectText.length).toBeGreaterThan(0);
    }
  });

  it('纯伤害技能 effect=null，带追加效果的技能声明 chance/类型', () => {
    expect(getMove('tackle')!.effect ?? null).toBeNull();
    expect(getMove('surf')!.effect ?? null).toBeNull();
    expect(getMove('hyper-beam')!.effectText).toContain('纯伤害');
    expect(getMove('body-slam')!.effect).toEqual({ kind: 'status', status: 'par', chance: 30 });
    expect(getMove('thunder-shock')!.effect).toEqual({ kind: 'status', status: 'par', chance: 10 });
    expect(getMove('flamethrower')!.effect).toEqual({ kind: 'status', status: 'brn', chance: 10 });
    expect(getMove('fire-blast')!.effect).toEqual({ kind: 'status', status: 'brn', chance: 10 });
    expect(getMove('psychic')!.effect).toEqual({ kind: 'stat', stat: 'spdef', stages: -1, target: 'foe', chance: 10 });
    expect(getMove('crunch')!.effect).toEqual({ kind: 'stat', stat: 'def', stages: -1, target: 'foe', chance: 20 });
  });

  it('第三世代新技能：属性/威力/分类与官方一致，效果接进现有特效体系', () => {
    // 吸取类：drain 50%
    expect(getMove('absorb')).toMatchObject({ type: 'grass', power: 20, category: 'special', effect: { kind: 'drain', ratio: 0.5 } });
    expect(getMove('giga-drain')).toMatchObject({ type: 'grass', power: 75, effect: { kind: 'drain', ratio: 0.5 } });
    // 追加效果沿用 brn/psn/par 与能力阶级
    expect(getMove('blaze-kick')!.effect).toEqual({ kind: 'status', status: 'brn', chance: 10 });
    expect(getMove('dragon-breath')!.effect).toEqual({ kind: 'status', status: 'par', chance: 30 });
    expect(getMove('sludge-bomb')!.effect).toEqual({ kind: 'status', status: 'psn', chance: 30 });
    expect(getMove('poison-sting')!.effect).toEqual({ kind: 'status', status: 'psn', chance: 30 });
    expect(getMove('iron-tail')!.effect).toEqual({ kind: 'stat', stat: 'def', stages: -1, target: 'foe', chance: 30 });
    expect(getMove('metal-claw')!.effect).toEqual({ kind: 'stat', stat: 'atk', stages: 1, target: 'self', chance: 10 });
    expect(getMove('shadow-ball')!.effect).toEqual({ kind: 'stat', stat: 'spdef', stages: -1, target: 'foe', chance: 20 });
    // 简化：不模拟蓄力/冰冻/畏缩的纯伤害技能
    expect(getMove('fly')!.effect ?? null).toBeNull();
    expect(getMove('rock-slide')!.effect ?? null).toBeNull();
    expect(getMove('ice-beam')!.effect ?? null).toBeNull();
    // 新属性（flying/ice/ground/ghost/bug/fighting/steel/poison/rock）都有技能落在表里
    const types = new Set(Object.values(MOVES).map((m) => m.type));
    for (const type of ['flying', 'ice', 'ground', 'ghost', 'bug', 'fighting', 'steel', 'poison', 'rock'] as const) {
      expect(types.has(type)).toBe(true);
    }
  });
});

describe('battle-math 特效纯函数', () => {
  it('能力阶级乘率：正阶 (2+s)/2、负阶 2/(2−s)，±6 封顶', () => {
    expect(statStageMultiplier(0)).toBe(1);
    expect(statStageMultiplier(1)).toBe(1.5);
    expect(statStageMultiplier(2)).toBe(2);
    expect(statStageMultiplier(6)).toBe(4);
    expect(statStageMultiplier(-1)).toBeCloseTo(2 / 3, 12);
    expect(statStageMultiplier(-2)).toBe(0.5);
    expect(statStageMultiplier(-6)).toBe(0.25);
    expect(statStageMultiplier(99)).toBe(4);
    expect(statStageMultiplier(-99)).toBe(0.25);
    expect(effectiveStat(100, -1)).toBe(66);
    expect(effectiveStat(100, 2)).toBe(200);
  });

  it('changeStatStage 在 ±6 处封顶并返回实际生效阶数', () => {
    const c = newConditions();
    expect(changeStatStage(c, 'atk', 2)).toBe(2);
    expect(c.stages.atk).toBe(2);
    expect(changeStatStage(c, 'atk', 6)).toBe(4);
    expect(c.stages.atk).toBe(6);
    expect(changeStatStage(c, 'atk', -1)).toBe(-1);
    expect(changeStatStage(c, 'spdef', -3)).toBe(-3);
    expect(changeStatStage(c, 'spdef', -9)).toBe(-3);
    expect(c.stages.spdef).toBe(-6);
  });

  it('异常状态同类不叠加、异类不覆盖；回合末伤害 = maxHP/16 且至少 1', () => {
    const c = newConditions();
    expect(setStatus(c, 'brn')).toBe(true);
    expect(setStatus(c, 'brn')).toBe(false);
    expect(setStatus(c, 'par')).toBe(false);
    expect(c.status).toBe('brn');
    expect(residualDamage(100, 'brn')).toBe(6);
    expect(residualDamage(80, 'psn')).toBe(5);
    expect(residualDamage(8, 'psn')).toBe(1);
  });

  it('麻痹：先手速度减半（至少 1），25% 概率不能行动', () => {
    const healthy = newConditions();
    const para = newConditions();
    para.status = 'par';
    expect(speedForOrder(100, healthy)).toBe(100);
    expect(speedForOrder(100, para)).toBe(50);
    expect(speedForOrder(1, para)).toBe(1);
    expect(speedForOrder(100, healthy)).toBeGreaterThan(speedForOrder(100, para));
    expect(paralysisSkips(0.2499)).toBe(true);
    expect(paralysisSkips(0.25)).toBe(false);
  });

  it('applyMoveEffect：掷点决定 stat/status，drain/recoil 按伤害比例结算', () => {
    const user = target({ hp: 40, maxHp: 100 });
    const foe = target();

    // 命中概率内 → 触发；Roll 高于 chance → 不触发
    const applied = applyMoveEffect({ kind: 'status', status: 'brn', chance: 10 }, user, foe, 20, 0.05);
    expect(applied).toEqual([{ kind: 'status', status: 'brn', applied: true }]);
    expect(foe.status).toBe('brn');
    expect(applyMoveEffect({ kind: 'status', status: 'par', chance: 10 }, user, foe, 20, 0.5)).toEqual([]);
    expect(foe.status).toBe('brn');

    // stat：目标能力阶级变化（foe）
    const stat = applyMoveEffect(
      { kind: 'stat', stat: 'def', stages: -1, target: 'foe', chance: 20 },
      user,
      foe,
      20,
      0.1,
    );
    expect(stat).toEqual([{ kind: 'stat', target: 'foe', stat: 'def', stages: -1, applied: -1, value: -1 }]);
    expect(foe.stages.def).toBe(-1);

    // self 方向（如剑舞类 +2 攻击）
    const selfBuff = applyMoveEffect(
      { kind: 'stat', stat: 'atk', stages: 2, target: 'self', chance: 100 },
      user,
      foe,
      0,
      0.0,
    );
    expect(selfBuff[0]).toEqual({ kind: 'stat', target: 'self', stat: 'atk', stages: 2, applied: 2, value: 2 });
    expect(user.stages.atk).toBe(2);

    // drain：回复 min(缺口, floor(damage×ratio))，至少 1
    const drained = applyMoveEffect({ kind: 'drain', ratio: 0.5 }, user, foe, 30, 0);
    expect(drained).toEqual([{ kind: 'drain', healed: 15, hp: 55 }]);
    expect(user.hp).toBe(55);
    // 缺口小于按比例回复量时只回满
    const capped = applyMoveEffect({ kind: 'drain', ratio: 2 }, user, foe, 100, 0);
    expect(capped).toEqual([{ kind: 'drain', healed: 45, hp: 100 }]);

    // recoil：自身受到 floor(damage×ratio)，至少 1，可倒下（hp 不低于 0）
    const recoiled = applyMoveEffect({ kind: 'recoil', ratio: 0.25 }, user, foe, 40, 0);
    expect(recoiled).toEqual([{ kind: 'recoil', damage: 10, hp: 90 }]);
    const lethal = applyMoveEffect({ kind: 'recoil', ratio: 1 }, target({ hp: 5 }), foe, 40, 0);
    expect(lethal).toEqual([{ kind: 'recoil', damage: 40, hp: 0 }]);
  });
});

describe('BattleEngine 特效接线（docs/backend-api.md §5）', () => {
  it('灼伤：命中后写入状态，回合末扣 maxHP/16', () => {
    const engine = new BattleEngine(
      [mon('a1', 6, 50, ['flamethrower'])],
      [mon('b1', 143, 50, ['tackle'])],
      // A: hit/crit/factor/effect(0.05 < 10% → brn)；B: hit/crit/factor
      scripted([0, 0.5, 0, 0.05, 0, 0.5, 0]),
    );
    engine.submitAction('A', { type: 'move', moveIndex: 0 });
    const { entry } = engine.submitAction('B', { type: 'move', moveIndex: 0 });
    const events = entry!.events;
    expect(events.some((e) => e.kind === 'status' && e.side === 'A' && e.detail.status === 'brn')).toBe(true);
    expect(engine.active('B').status).toBe('brn');
    const residual = events.find((e) => e.kind === 'status-damage' && e.side === 'B');
    expect(residual!.detail.damage).toBe(residualDamage(engine.active('B').maxHp, 'brn'));
  });

  it('麻痹：速度减半影响先手，25% 概率直接不能行动', () => {
    // 麻痹后 A 的有效速度 50 < B 的 78 → B 先手
    const slower = new BattleEngine(
      [mon('a1', 25, 50, ['tackle'])],
      [mon('b1', 9, 50, ['tackle'])],
      scripted([0, 0.5, 0, 0, 0.5, 0]),
    );
    slower.active('A').status = 'par';
    slower.submitAction('A', { type: 'move', moveIndex: 0 });
    const ordered = slower.submitAction('B', { type: 'move', moveIndex: 0 });
    expect(ordered.entry!.events.find((e) => e.kind === 'damage')!.side).toBe('B');

    // par 掷点 0.1 < 0.25 → A 无法行动（消耗一个掷点，不产生 move 事件）
    const skipped = new BattleEngine(
      [mon('a1', 25, 50, ['tackle'])],
      [mon('b1', 9, 50, ['tackle'])],
      scripted([0.1, 0, 0.5, 0]),
    );
    skipped.active('A').status = 'par';
    skipped.submitAction('A', { type: 'move', moveIndex: 0 });
    const turn = skipped.submitAction('B', { type: 'move', moveIndex: 0 });
    const events = turn.entry!.events;
    expect(events.some((e) => e.kind === 'paralyzed' && e.side === 'A')).toBe(true);
    expect(events.some((e) => e.kind === 'move' && e.side === 'A')).toBe(false);
    expect(events.some((e) => e.kind === 'damage' && e.side === 'A')).toBe(false);
  });

  it('能力阶级修正伤害：crunch 降防后同招伤害更高', () => {
    const stats = { atk: finalStats(25, 50).atk, def: finalStats(9, 50).def };
    // 命中/暴击/浮动/效果(0 < 20% → 防御 −1)；B 的 tackle
    const lowered = new BattleEngine(
      [mon('a1', 25, 50, ['crunch'])],
      [mon('b1', 9, 50, ['tackle'])],
      scripted([0, 0.5, 0, 0.0, 0, 0.5, 0, 0, 0.5, 0, 0.9, 0, 0.5, 0]),
    );
    const control = new BattleEngine(
      [mon('a1', 25, 50, ['crunch'])],
      [mon('b1', 9, 50, ['tackle'])],
      scripted([0, 0.5, 0, 0.9, 0, 0.5, 0, 0, 0.5, 0, 0.9, 0, 0.5, 0]),
    );

    const run = (engine: BattleEngine) => {
      engine.submitAction('A', { type: 'move', moveIndex: 0 });
      engine.submitAction('B', { type: 'move', moveIndex: 0 });
      engine.submitAction('A', { type: 'move', moveIndex: 0 });
      const t2 = engine.submitAction('B', { type: 'move', moveIndex: 0 });
      return t2.entry!.events.find((e) => e.kind === 'damage' && e.side === 'A')!.detail.damage as number;
    };

    const dropped = run(lowered);
    const baseline = run(control);
    expect(lowered.active('B').stages.def).toBe(-1);
    expect(dropped).toBeGreaterThan(baseline);
    // 与公式一致：防御按 ×2/3 后再代入
    const expected = computeDamage({
      level: 50,
      power: 80,
      attack: stats.atk,
      defense: Math.floor(stats.def * (2 / 3)),
      effectiveness: 1,
      crit: false,
      factor: 0.85,
    });
    expect(dropped).toBe(expected);
  });

  it('drain 按伤害比例回复、recoil 反伤自身（含反伤倒下判负）', () => {
    const engine = new BattleEngine(
      [mon('a1', 25, 50, ['tackle'])],
      [mon('b1', 9, 50, ['tackle'])],
      scripted([0, 0.5, 0]),
    );
    engine.active('A').hp -= 40;
    engine.active('A').moves[0] = { ...engine.active('A').moves[0], effect: { kind: 'drain', ratio: 0.5 } } as MoveDef;
    engine.submitAction('A', { type: 'move', moveIndex: 0 });
    const drained = engine.submitAction('B', { type: 'move', moveIndex: 0 });
    const damage = drained.entry!.events.find((e) => e.kind === 'damage' && e.side === 'A')!.detail.damage as number;
    const drainEvent = drained.entry!.events.find((e) => e.kind === 'drain' && e.side === 'A');
    expect(drainEvent!.detail.healed).toBe(Math.max(1, Math.floor(damage * 0.5)));

    const reckless = new BattleEngine(
      [mon('a1', 25, 50, ['tackle'])],
      [mon('b1', 9, 50, ['tackle'])],
      scripted([0, 0.5, 0]),
    );
    reckless.active('A').hp = 1;
    reckless.active('A').moves[0] = { ...reckless.active('A').moves[0], effect: { kind: 'recoil', ratio: 0.5 } } as MoveDef;
    reckless.submitAction('A', { type: 'move', moveIndex: 0 });
    const recoiled = reckless.submitAction('B', { type: 'move', moveIndex: 0 });
    expect(recoiled.entry!.events.some((e) => e.kind === 'recoil' && e.side === 'A')).toBe(true);
    expect(reckless.active('A').hp).toBe(0);
    expect(reckless.finished).toBe(true);
    expect(reckless.outcome).toEqual({ winnerSide: 'B' });
  });
});
