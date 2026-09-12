import { MoveEffect, StatStageKey, StatusCondition } from '../../game-data/moves.data';

/**
 * Pure combat math shared by the PvP engine (battle-engine.ts) and the PvE
 * wild battle (wild/wild-battle.ts). The roll order is part of the documented
 * derivation layout (docs/randomness.md §4):
 *   paralysis check (only when the attacker is paralyzed), hit, crit, damage
 *   factor, effect chance (only for moves with a stat/status effect).
 */
export const CRIT_RATE = 1 / 16;
export const CRIT_MULT = 1.5;

/** 能力阶级上下限 ±6（第 3 世代口径） */
export const STAT_STAGE_MAX = 6;
export const STAT_STAGE_MIN = -6;
/** 灼伤/中毒回合末伤害 = maxHP / 16（至少 1） */
export const STATUS_RESIDUAL_DENOM = 16;
/** 麻痹不能行动概率；麻痹速度减半 */
export const PARALYSIS_SKIP_CHANCE = 0.25;
export const PARALYSIS_SPEED_MULT = 0.5;

export const STAT_STAGE_KEYS: StatStageKey[] = ['atk', 'def', 'spatk', 'spdef', 'speed'];

/** 战斗内的可变状态（能力阶级 + 异常状态），战斗开始时全 0 / 无异常。 */
export interface ConditionState {
  stages: Record<StatStageKey, number>;
  status: StatusCondition | null;
}

/** 可被特效作用的战斗单位（PvP EngineMon 与野怪 WildCombatant 都满足） */
export interface EffectTarget extends ConditionState {
  hp: number;
  maxHp: number;
}

export function newConditions(): ConditionState {
  return { stages: { atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 }, status: null };
}

export function hitCheck(accuracy: number, hitRoll: number): boolean {
  return hitRoll * 100 < accuracy;
}

export function critCheck(critRoll: number): boolean {
  return critRoll < CRIT_RATE;
}

export function damageFactor(factorRoll: number): number {
  return 0.85 + factorRoll * 0.15;
}

export interface DamageArgs {
  level: number;
  power: number;
  /** 攻方最终能力值（物攻或特攻，按技能分类，已含能力阶级修正） */
  attack: number;
  /** 守方最终能力值（物防或特防，已含能力阶级修正） */
  defense: number;
  /** 属性克制倍率（0 = 免疫） */
  effectiveness: number;
  crit: boolean;
  /** 伤害浮动 0.85–1.0（damageFactor(roll)） */
  factor: number;
}

/**
 * damage = max(1, floor( floor(((2*level/5+2)*power*atk/def)/50) + 2 × eff × crit × factor ))
 * 能力值一律为 种族值+IV+EV+等级+性格 的最终值（game-data/stats.computeStats）。
 */
export function computeDamage(args: DamageArgs): number {
  const base = Math.floor((((2 * args.level) / 5 + 2) * args.power * args.attack) / args.defense / 50) + 2;
  if (args.effectiveness === 0) return 0;
  const critMult = args.crit ? CRIT_MULT : 1;
  return Math.max(1, Math.floor(base * args.effectiveness * critMult * args.factor));
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ------------------------------------------------------------------ stat stages

/** 阶级乘率：正阶 (2+s)/2（+1 → 1.5、+2 → 2、+6 → 4），负阶 2/(2−s)（−1 → 2/3、−2 → 0.5、−6 → 0.25）。 */
export function statStageMultiplier(stage: number): number {
  const s = Math.max(STAT_STAGE_MIN, Math.min(STAT_STAGE_MAX, Math.trunc(stage)));
  return s >= 0 ? (2 + s) / 2 : 2 / (2 - s);
}

/** 应用能力阶级后的实际能力值（向下取整）。 */
export function effectiveStat(base: number, stage: number): number {
  return Math.floor(base * statStageMultiplier(stage));
}

/** 修改能力阶级（上限 ±6），返回实际生效的阶数（可能为 0）。 */
export function changeStatStage(target: ConditionState, stat: StatStageKey, delta: number): number {
  const before = target.stages[stat];
  const after = Math.max(STAT_STAGE_MIN, Math.min(STAT_STAGE_MAX, before + delta));
  target.stages[stat] = after;
  return after - before;
}

/** 写入异常状态：同类不叠加、异类不覆盖；返回是否新写入。 */
export function setStatus(target: ConditionState, status: StatusCondition): boolean {
  if (target.status) return false;
  target.status = status;
  return true;
}

/** 先手判定用的速度：麻痹速度减半（向下取整，至少 1），再计速度阶级。 */
export function speedForOrder(base: number, cond: ConditionState): number {
  const raw = cond.status === 'par' ? Math.max(1, Math.floor(base * PARALYSIS_SPEED_MULT)) : base;
  return effectiveStat(raw, cond.stages.speed);
}

/** 麻痹判定：掷点 < 0.25 → 本回合无法行动。 */
export function paralysisSkips(roll: number): boolean {
  return roll < PARALYSIS_SKIP_CHANCE;
}

/** 回合末异常伤害：brn/psn 扣 maxHP/16（至少 1）。 */
export function residualDamage(maxHp: number, status: StatusCondition): number {
  return Math.max(1, Math.floor(maxHp / STATUS_RESIDUAL_DENOM));
}

// ------------------------------------------------------------------ move effects

export type EffectResult =
  | { kind: 'stat'; target: 'self' | 'foe'; stat: StatStageKey; stages: number; applied: number; value: number }
  | { kind: 'status'; status: StatusCondition; applied: boolean }
  | { kind: 'drain'; healed: number; hp: number }
  | { kind: 'recoil'; damage: number; hp: number };

/**
 * 命中后结算技能的追加效果（PvP / 野怪共用）：
 * - stat / status：`roll*100 < chance` 才触发（chance=100 也传一次掷点，保持消耗顺序固定）
 * - drain / recoil：直接按伤害比例结算，不消耗掷点
 * 会直接写入 user/target 的 hp / stages / status，返回可转成事件的结果列表。
 */
export function applyMoveEffect(
  effect: MoveEffect,
  user: EffectTarget,
  target: EffectTarget,
  damage: number,
  roll: number,
): EffectResult[] {
  switch (effect.kind) {
    case 'stat': {
      if (roll * 100 >= effect.chance) return [];
      const subject = effect.target === 'self' ? user : target;
      const applied = changeStatStage(subject, effect.stat, effect.stages);
      return [
        {
          kind: 'stat',
          target: effect.target,
          stat: effect.stat,
          stages: effect.stages,
          applied,
          value: subject.stages[effect.stat],
        },
      ];
    }
    case 'status': {
      if (roll * 100 >= effect.chance) return [];
      return [{ kind: 'status', status: effect.status, applied: setStatus(target, effect.status) }];
    }
    case 'drain': {
      const healed = Math.min(user.maxHp - user.hp, Math.max(1, Math.floor(damage * effect.ratio)));
      user.hp += healed;
      return [{ kind: 'drain', healed, hp: user.hp }];
    }
    case 'recoil': {
      const recoil = Math.max(1, Math.floor(damage * effect.ratio));
      user.hp = Math.max(0, user.hp - recoil);
      return [{ kind: 'recoil', damage: recoil, hp: user.hp }];
    }
  }
}

/** EffectResult → 战斗事件的 kind/detail（side 由调用方按出手方补齐）。 */
export function effectEvent(result: EffectResult): {
  kind: 'stat' | 'status' | 'drain' | 'recoil';
  detail: Record<string, unknown>;
} {
  switch (result.kind) {
    case 'stat':
      return {
        kind: 'stat',
        detail: { target: result.target, stat: result.stat, stages: result.stages, applied: result.applied, value: result.value },
      };
    case 'status':
      return { kind: 'status', detail: { status: result.status, applied: result.applied } };
    case 'drain':
      return { kind: 'drain', detail: { healed: result.healed, hp: result.hp } };
    case 'recoil':
      return { kind: 'recoil', detail: { damage: result.damage, hp: result.hp } };
  }
}
