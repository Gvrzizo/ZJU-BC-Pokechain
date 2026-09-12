import type { WildBattleEvent, WildStatus } from '@/types';
import { num, statLabel, statusLabel } from './battle-log';

/**
 * 野怪战斗（PvE）的纯展示逻辑：捕捉成功率格式化与战斗日志文案。
 * 不含任何网络/组件依赖，供 CaptureOverlay.vue 与单测复用。
 * 异常状态/能力阶级的中文名表与 PvP 日志（battle-log.ts）共用。
 */

export { STATUS_LABELS, statusLabel } from './battle-log';

export interface WildLogContext {
  /** 我方宝可梦名（服务端日志只带 id，显示名在前端补） */
  mineName?: string;
  wildName?: string;
  /** moveId → 显示名（来自状态里的我方技能表） */
  moveNames?: Record<string, string>;
  /** typeId → 显示名（球在消耗后可能已不在背包里，前端累积已知名称） */
  ballNames?: Record<string, string>;
  /** pokemonId → 显示名（换宠日志只带 id，从状态里的队伍列表补） */
  partyNames?: Record<string, string>;
}

/**
 * 捕捉成功率 → 百分比文案。0.3529… → '35.3%'；必中（1）→ '100%'；
 * 极低（<0.1%）显示 '<0.1%' 而不是 '0.0%'。
 */
export function formatChance(chance: number): string {
  if (!Number.isFinite(chance) || chance <= 0) return '0%';
  if (chance >= 1) return '100%';
  const pct = chance * 100;
  if (pct < 0.1) return '<0.1%';
  return `${pct.toFixed(1)}%`;
}

/** 概率配色档位：低（红）/ 中（棕）/ 高（绿）。 */
export function chanceTone(chance: number): 'low' | 'mid' | 'high' {
  if (chance >= 0.75) return 'high';
  if (chance >= 0.35) return 'mid';
  return 'low';
}

export function chanceColor(chance: number): string {
  const tone = chanceTone(chance);
  if (tone === 'high') return 'var(--gba-green-light)';
  if (tone === 'mid') return 'var(--gba-yellow)';
  return 'var(--gba-red)';
}

/** 服务端动作类型 → 出手方显示名 */
function actorName(side: WildBattleEvent['side'], ctx: WildLogContext): string {
  if (side === 'player') return ctx.mineName ?? '我方宝可梦';
  if (side === 'wild') return ctx.wildName ? `野生的${ctx.wildName}` : '野生的宝可梦';
  return '？';
}

/**
 * 战斗日志事件：`types.ts` 的 WildBattleEvent 是并行维护的共享契约，
 * 新增的特效/换宠事件类型在这里补齐（服务端 log 直接透传）。
 */
export type WildBattleEventKind =
  | WildBattleEvent['kind']
  | 'switch'
  | 'paralyzed'
  | 'status'
  | 'status-damage'
  | 'stat'
  | 'drain'
  | 'recoil';

export interface WildLogEvent extends Omit<WildBattleEvent, 'kind'> {
  kind: WildBattleEventKind;
}

/**
 * 球倍率与显示名（与 `backend/src/game-data/items.data.ts` 对齐）。
 * 仅"无队伍降级路径"（没有可出战宝可梦时的快速捕捉）在链下复算成功率时使用。
 */
export const BALL_TABLE: Record<string, { nameZh: string; bonus: number }> = {
  'poke-ball': { nameZh: '精灵球', bonus: 1 },
  'great-ball': { nameZh: '超级球', bonus: 1.5 },
  'ultra-ball': { nameZh: '高级球', bonus: 2 },
  'master-ball': { nameZh: '大师球', bonus: 255 },
};

export function ballInfo(typeId: string): { nameZh: string; bonus: number } {
  return BALL_TABLE[typeId] ?? { nameZh: typeId, bonus: 1 };
}

/**
 * 快速捕捉（无队伍降级路径）= 满血投球，与后端
 * `captureProbability(1, 1, catchRate, ballBonus)` 同式：`p = min(1, catchRate × ballBonus / 765)`。
 * 大师球（≥255）必中。有队伍时请用后端返回的 `captureChances`（含野怪当前 HP）。
 */
export function quickCaptureChance(catchRate: number, ballBonus: number): number {
  if (ballBonus >= 255) return 1;
  if (!Number.isFinite(catchRate) || catchRate <= 0) return 0;
  return Math.min(1, (catchRate * ballBonus) / 765);
}

function moveName(detail: Record<string, unknown>, ctx: WildLogContext): string {
  const id = typeof detail.move === 'string' ? detail.move : '';
  return ctx.moveNames?.[id] ?? id ?? '技能';
}

/** 技能元数据的最小展示形状（后端 GET /battles/moves 与野怪状态里的技能表都满足） */
export interface MoveDetailInfo {
  name: string;
  type: string;
  power: number;
  accuracy: number;
  category: string;
  effectText?: string;
}

/** 技能悬停/聚焦说明：名称 + 威力/命中/属性/分类 + 效果描述（与 BattleView 同格式）。 */
export function moveDetailText(label: string, move: MoveDetailInfo | null | undefined): string {
  if (!move) return label;
  const category = move.category === 'physical' ? '物理' : '特殊';
  const lines = [
    `${label}（${move.name}）`,
    `威力 ${move.power} · 命中 ${move.accuracy} · ${move.type} · ${category}`,
  ];
  if (move.effectText) lines.push(move.effectText);
  return lines.join('\n');
}

/** 单条战斗事件 → 中文日志行（'end' 之类不产生文案的返回空串）。 */
export function wildLogText(entry: WildLogEvent, ctx: WildLogContext = {}): string {
  const d = entry.detail ?? {};
  const actor = actorName(entry.side, ctx);
  switch (entry.kind) {
    case 'encounter':
      return `野生的${ctx.wildName ?? '宝可梦'}出现了！`;
    case 'move':
      return `${actor} 使用了 ${moveName(d, ctx)}！`;
    case 'miss':
      return `${actor} 的攻击落空了…`;
    case 'damage': {
      const eff = num(d, 'eff');
      const crit = d.crit === true ? '会心一击！' : '';
      const effText = eff >= 2 ? '效果拔群！' : eff === 0 ? '没有效果…' : eff < 1 ? '效果不佳…' : '';
      const target = entry.side === 'player' ? ctx.wildName ? `野生的${ctx.wildName}` : '野生的宝可梦' : ctx.mineName ?? '我方宝可梦';
      return `${crit}${effText}对 ${target} 造成 ${num(d, 'damage')} 伤害`;
    }
    case 'faint':
      return entry.side === 'wild'
        ? `野生的${ctx.wildName ?? '宝可梦'}倒下了！`
        : `${ctx.mineName ?? '我方宝可梦'}倒下了！`;
    case 'ball': {
      const typeId = typeof d.typeId === 'string' ? d.typeId : '';
      const name = ctx.ballNames?.[typeId] ?? typeId;
      return `投出了${name}（成功率 ${formatChance(num(d, 'chance'))}）…`;
    }
    case 'ball-failed':
      return `球摇了 ${num(d, 'shakes')} 次后弹开了！`;
    case 'caught':
      return '恭喜！捕捉成功！';
    case 'switch': {
      const id = typeof d.pokemonId === 'string' ? d.pokemonId : '';
      const name = ctx.partyNames?.[id] ?? id ?? '宝可梦';
      return d.forced === true ? `${ctx.mineName ?? '我方宝可梦'}倒下了，换上了 ${name}！` : `换上了 ${name}！`;
    }
    case 'paralyzed':
      return `${actor} 被麻痹了，无法行动！`;
    case 'status': {
      const label = statusLabel(d.status);
      const target = entry.side === 'player' ? ctx.wildName ? `野生的${ctx.wildName}` : '野生的宝可梦' : ctx.mineName ?? '我方宝可梦';
      return d.applied === false ? `${target} 已经受到异常状态影响…` : `${target} 陷入了${label}！`;
    }
    case 'status-damage':
      return `${actor} 受到了${statusLabel(d.status)}伤害 ${num(d, 'damage')} 点`;
    case 'stat': {
      const target =
        d.target === 'self' ? ctx.mineName ?? '我方宝可梦' : entry.side === 'player' ? ctx.wildName ? `野生的${ctx.wildName}` : '野生的宝可梦' : ctx.mineName ?? '我方宝可梦';
      const stages = num(d, 'stages');
      if (d.applied === 0) return `${target} 的${statLabel(d.stat)}已经无法再变化了…`;
      return `${target} 的${statLabel(d.stat)}${stages > 0 ? '上升' : '下降'}了 ${Math.abs(stages)} 级！（当前 ${num(d, 'value') > 0 ? '+' : ''}${num(d, 'value')}）`;
    }
    case 'drain':
      return `${actor} 吸取了 ${num(d, 'healed')} 点体力！`;
    case 'recoil':
      return `${actor} 受到了 ${num(d, 'damage')} 点反作用力伤害！`;
    case 'run':
      return '成功逃走了。';
    case 'timeout':
      return '战斗超时（15 分钟无操作），野怪逃走了。';
    case 'end':
      return d.reason === 'wild-fainted' ? '战斗结束：野怪被击倒，无法再捕捉。' : '';
    default:
      return '';
  }
}

/** 终态 → 结果标题。 */
export function wildResultText(status: WildStatus): string {
  switch (status) {
    case 'CAUGHT':
      return '捕捉成功！';
    case 'WILD_FAINTED':
      return '野怪被击倒了';
    case 'PLAYER_FAINTED':
      return '你的宝可梦倒下了…';
    case 'RAN':
      return '成功逃走';
    case 'TIMEOUT':
      return '战斗超时';
    default:
      return '战斗中';
  }
}
