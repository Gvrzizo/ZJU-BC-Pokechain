import {
  applyMoveEffect,
  computeDamage,
  critCheck,
  damageFactor,
  effectiveStat,
  effectEvent,
  hitCheck,
  paralysisSkips,
  residualDamage,
  round6,
  speedForOrder,
} from '../battles/engine/battle-math';
import { MoveDef, StatStageKey } from '../game-data/moves.data';
import { BaseStats } from '../game-data/species.data';
import { typeEffectiveness } from '../game-data/type-chart';
import { AttackRolls, WildTurnRolls } from '../pokemon/capture-derive';
import { WildBattleEvent, WildCombatant } from './wild-session';

export type WildSide = 'player' | 'wild';

/**
 * PvE 野怪战斗的纯结算逻辑：伤害/命中/暴击/能力阶级/异常状态与 PvP 引擎共用
 * battle-math（docs/backend-api.md §2）。掷点全部来自该事件派生流的野怪区域
 * （capture-derive.ts，base=30000 起，每回合 16 槽）。
 */

/**
 * 一次攻击（攻方/守方均为最终能力值，能力阶级与异常状态在此结算）；
 * 返回权威事件流。麻痹先掷检查槽，命中后按技能的追加效果消耗效果槽。
 */
export function resolveAttack(
  side: WildSide,
  attacker: WildCombatant,
  defender: WildCombatant,
  move: MoveDef,
  rolls: AttackRolls,
): WildBattleEvent[] {
  const events: WildBattleEvent[] = [];

  if (attacker.status === 'par') {
    if (paralysisSkips(rolls.par)) {
      events.push({ kind: 'paralyzed', side, detail: { move: move.id, roll: round6(rolls.par) } });
      return events;
    }
  }

  events.push({
    kind: 'move',
    side,
    detail: { move: move.id, attacker: attacker.pokemonId || 'wild', defender: defender.pokemonId || 'wild' },
  });
  if (!hitCheck(move.accuracy, rolls.hit)) {
    events.push({ kind: 'miss', side, detail: { move: move.id, roll: round6(rolls.hit) } });
    return events;
  }
  const atkKey: StatStageKey = move.category === 'physical' ? 'atk' : 'spatk';
  const defKey: StatStageKey = move.category === 'physical' ? 'def' : 'spdef';
  const attack = effectiveStat(attacker[atkKey], attacker.stages[atkKey]);
  const defense = effectiveStat(defender[defKey], defender.stages[defKey]);
  const eff = typeEffectiveness(move.type, defender.type);
  const crit = critCheck(rolls.crit);
  const factor = damageFactor(rolls.factor);
  const damage = computeDamage({
    level: attacker.level,
    power: move.power,
    attack,
    defense,
    effectiveness: eff,
    crit,
    factor,
  });
  defender.hp = Math.max(0, defender.hp - damage);
  events.push({
    kind: 'damage',
    side,
    detail: {
      move: move.id,
      damage,
      eff,
      crit,
      roll: round6(factor),
      defenderHp: defender.hp,
      defenderMaxHp: defender.maxHp,
    },
  });

  const effect = move.effect ?? null;
  if (effect) {
    for (const result of applyMoveEffect(effect, attacker, defender, damage, rolls.effect)) {
      const ev = effectEvent(result);
      events.push({ kind: ev.kind, side, detail: ev.detail });
    }
  }
  return events;
}

/** 野怪 AI：每回合从自己的技能表里按派生流随机选一个。 */
export function pickWildMove(wild: WildCombatant, moveRoll: number): MoveDef {
  const index = Math.min(wild.moves.length - 1, Math.floor(moveRoll * wild.moves.length));
  return wild.moves[index];
}

/**
 * 一个回合：玩家出招 →（野怪存活则）野怪出招。速度决定先手
 * （最终能力值 speed，麻痹减半；平速用该回合 tieBreak 槽）。
 */
export function resolveWildTurn(
  player: WildCombatant,
  wild: WildCombatant,
  playerMove: MoveDef,
  rolls: WildTurnRolls,
): WildBattleEvent[] {
  const events: WildBattleEvent[] = [];
  const wildMove = pickWildMove(wild, rolls.wildMoveRoll);
  const playerSpeed = speedForOrder(player.speed, player);
  const wildSpeed = speedForOrder(wild.speed, wild);
  const playerFirst = playerSpeed > wildSpeed || (playerSpeed === wildSpeed && rolls.tieBreak < 0.5);
  const order: WildSide[] = playerFirst ? ['player', 'wild'] : ['wild', 'player'];

  for (const side of order) {
    if (wild.hp <= 0 || player.hp <= 0) break;
    events.push(
      ...(side === 'player'
        ? resolveAttack('player', player, wild, playerMove, rolls.player)
        : resolveAttack('wild', wild, player, wildMove, rolls.wild)),
    );
  }
  events.push(...endOfTurnEvents(player, wild));
  events.push(...faintEvents(player, wild));
  return events;
}

/** 投球失败 / 换宠后野怪的反击（玩家这一回合已消耗在投球或换宠上）。 */
export function resolveWildAttack(
  player: WildCombatant,
  wild: WildCombatant,
  rolls: WildTurnRolls,
): WildBattleEvent[] {
  const events = resolveAttack('wild', wild, player, pickWildMove(wild, rolls.wildMoveRoll), rolls.wild);
  events.push(...endOfTurnEvents(player, wild));
  events.push(...faintEvents(player, wild));
  return events;
}

/** 回合末异常伤害：brn/psn 扣 maxHP/16（至少 1，不消耗掷点）。 */
function endOfTurnEvents(player: WildCombatant, wild: WildCombatant): WildBattleEvent[] {
  const events: WildBattleEvent[] = [];
  for (const [side, mon] of [
    ['player', player],
    ['wild', wild],
  ] as Array<[WildSide, WildCombatant]>) {
    if (mon.hp <= 0 || !mon.status) continue;
    const damage = residualDamage(mon.maxHp, mon.status);
    mon.hp = Math.max(0, mon.hp - damage);
    events.push({
      kind: 'status-damage',
      side,
      detail: { status: mon.status, damage, hp: mon.hp, maxHp: mon.maxHp },
    });
  }
  return events;
}

function faintEvents(player: WildCombatant, wild: WildCombatant): WildBattleEvent[] {
  if (wild.hp <= 0) return [{ kind: 'faint', side: 'wild', detail: { pokemonId: wild.pokemonId } }];
  if (player.hp <= 0) return [{ kind: 'faint', side: 'player', detail: { pokemonId: player.pokemonId } }];
  return [];
}

/**
 * 击倒野怪的经验（简化，非官方 base exp yield）：按种族值总量与野怪等级折算，
 * 保证至少 5 点。经 ApplyGrowth 上链（幂等）。
 */
export function wildExpGain(base: BaseStats, wildLevel: number): number {
  const total = base.hp + base.atk + base.def + base.spatk + base.spdef + base.speed;
  return Math.max(5, Math.floor((total * wildLevel) / 50));
}
