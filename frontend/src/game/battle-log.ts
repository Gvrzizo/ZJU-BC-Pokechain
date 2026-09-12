import type { BattleLogEvent, BattleTurnLog } from '@/types';

/**
 * 战斗日志文案（纯函数，不含网络/组件依赖）：
 * - `pvpEventText` / `pvpTurnLines`：把 PvP 引擎随 `battle:state` 推送的回合事件
 *   （kind + side + detail，detail 带攻击/受击 `pokemonId`）渲染成中文日志行；
 * - 宝可梦名与技能名由调用方解析（`useI18n` 的 `monName`/`moveName`）后放进 ctx，
 *   服务端只下发 id，日志因此跟随界面语言；
 * - 异常状态/能力阶级的中文名表与野怪战斗（`wild-battle.ts`）共用。
 */

/** 异常状态 → 中文名（brn 灼伤 / psn 中毒 / par 麻痹） */
export const STATUS_LABELS: Record<string, string> = { brn: '灼伤', psn: '中毒', par: '麻痹' };

export function statusLabel(status: unknown): string {
  return typeof status === 'string' ? STATUS_LABELS[status] ?? status : '';
}

/** 能力阶级项 → 中文名 */
const STAT_LABELS: Record<string, string> = {
  atk: '攻击',
  def: '防御',
  spatk: '特攻',
  spdef: '特防',
  speed: '速度',
};

export function statLabel(stat: unknown): string {
  return typeof stat === 'string' ? STAT_LABELS[stat] ?? stat : '能力';
}

export function num(detail: Record<string, unknown>, key: string): number {
  const value = detail[key];
  return typeof value === 'number' ? value : 0;
}

function str(detail: Record<string, unknown>, key: string): string {
  const value = detail[key];
  return typeof value === 'string' ? value : '';
}

export interface PvpLogContext {
  /** pokemonId → 显示名（双方全队，换下场的宝可梦在历史回合里也能解析） */
  monNames?: Record<string, string>;
  /** 技能 id → 显示名 */
  moveNames?: Record<string, string>;
  /** A/B 两侧的玩家名（run / win 文案用） */
  playerNames?: { A?: string; B?: string };
}

function monOf(detail: Record<string, unknown>, ctx: PvpLogContext, fallback = '宝可梦'): string {
  const id = str(detail, 'pokemonId') || str(detail, 'defender') || str(detail, 'attacker');
  return ctx.monNames?.[id] ?? (id || fallback);
}

function moveOf(detail: Record<string, unknown>, ctx: PvpLogContext): string {
  const id = str(detail, 'move');
  return ctx.moveNames?.[id] ?? (id || '技能');
}

function playerOf(side: BattleLogEvent['side'], ctx: PvpLogContext): string {
  if (side === 'A') return ctx.playerNames?.A ?? 'A 方';
  if (side === 'B') return ctx.playerNames?.B ?? 'B 方';
  return '一方';
}

/** 伤害事件的前缀：会心 + 克制提示（无效果时只提示，不再报伤害数字）。 */
function damagePrefix(eff: number, crit: boolean): string {
  const parts: string[] = [];
  if (crit) parts.push('会心一击！');
  if (eff >= 2) parts.push('效果绝佳！');
  else if (eff === 0) parts.push('没有效果…');
  else if (eff < 1) parts.push('效果不佳…');
  return parts.join('');
}

/** 单条回合事件 → 中文日志行（不产生文案的事件返回空串）。 */
export function pvpEventText(entry: BattleLogEvent, ctx: PvpLogContext = {}): string {
  const d = entry.detail ?? {};
  switch (entry.kind) {
    case 'switch':
      return `换上了 ${monOf(d, ctx)}！`;
    case 'move':
      return `${monOf({ ...d, pokemonId: d.attacker }, ctx)} 使用了 ${moveOf(d, ctx)}！`;
    case 'miss':
      return `${monOf({ ...d, pokemonId: d.attacker }, ctx)} 的攻击落空了…`;
    case 'damage': {
      const crit = d.crit === true;
      const eff = num(d, 'eff');
      const prefix = damagePrefix(eff, crit);
      if (eff === 0) return prefix || '没有效果…';
      return `${prefix}对 ${monOf({ ...d, pokemonId: d.defender }, ctx)} 造成 ${num(d, 'damage')} 点伤害`;
    }
    case 'paralyzed':
      return `${monOf({ ...d, pokemonId: d.pokemonId ?? d.attacker }, ctx)} 被麻痹了，无法行动！`;
    case 'status': {
      const target = monOf(d, ctx);
      const label = statusLabel(d.status);
      return d.applied === false ? `${target} 已经处于${label}状态…` : `${target} 陷入了${label}！`;
    }
    case 'status-damage':
      return `${monOf(d, ctx)} 受到了${statusLabel(d.status)}伤害 ${num(d, 'damage')} 点`;
    case 'stat': {
      const target = monOf(d, ctx);
      const label = statLabel(d.stat);
      const stages = num(d, 'stages');
      if (d.applied === 0) return `${target} 的${label}已经无法再变化了…`;
      return `${target} 的${label}${stages > 0 ? '上升' : '下降'}了 ${Math.abs(stages)} 级！`;
    }
    case 'drain':
      return `${monOf({ ...d, pokemonId: d.pokemonId ?? d.attacker }, ctx)} 吸取了 ${num(d, 'healed')} 点体力！`;
    case 'recoil':
      return `${monOf({ ...d, pokemonId: d.pokemonId ?? d.attacker }, ctx)} 受到了 ${num(d, 'damage')} 点反作用力伤害！`;
    case 'faint':
      return `${monOf(d, ctx)} 倒下了！`;
    case 'run':
      return `${playerOf(entry.side, ctx)} 逃跑了…`;
    case 'win':
      return d.reason === 'double-ko' ? '双方同时倒下，平局！' : `${playerOf(entry.side, ctx)} 获胜！`;
    default:
      return '';
  }
}

/** 一个已结算回合 → 中文日志行（空文案被过滤）。 */
export function pvpTurnLines(turn: BattleTurnLog, ctx: PvpLogContext = {}): string[] {
  return (turn.events ?? []).map((event) => pvpEventText(event, ctx)).filter((line) => line.length > 0);
}
