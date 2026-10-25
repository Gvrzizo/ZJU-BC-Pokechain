import { describe, expect, it } from 'vitest';
import {
  chanceTone,
  formatChance,
  moveDetailText,
  statusLabel,
  wildLogText,
  wildResultText,
} from './wild-battle';
import type { WildLogEvent } from './wild-battle';

const CTX = {
  mineName: '卡比兽',
  wildName: '皮卡丘',
  moveNames: { tackle: 'Tackle' },
  ballNames: { 'poke-ball': '精灵球' },
  partyNames: { p_tank: '水箭龟' },
};

describe('formatChance 捕捉成功率文案', () => {
  it('保留一位小数、必中显示 100%、极低显示 <0.1%', () => {
    expect(formatChance(0.24836601307189543)).toBe('24.8%');
    expect(formatChance(0.3529)).toBe('35.3%');
    expect(formatChance(1)).toBe('100%');
    expect(formatChance(0)).toBe('0%');
    expect(formatChance(Number.NaN)).toBe('0%');
    expect(formatChance(0.0004)).toBe('<0.1%');
  });
  it('按概率分档配色：<35% 低 / 35–75% 中 / ≥75% 高', () => {
    expect(chanceTone(0.1)).toBe('low');
    expect(chanceTone(0.3499)).toBe('low');
    expect(chanceTone(0.35)).toBe('mid');
    expect(chanceTone(0.7499)).toBe('mid');
    expect(chanceTone(0.75)).toBe('high');
    expect(chanceTone(1)).toBe('high');
  });
});

describe('wildLogText 战斗日志文案', () => {
  const event = (kind: WildLogEvent['kind'], side?: 'player' | 'wild', detail: Record<string, unknown> = {}): WildLogEvent => ({ kind, side, detail });

  it('遇到野怪 / 出招 / 命中', () => {
    expect(wildLogText(event('encounter'), CTX)).toBe('野生的皮卡丘出现了！');
    expect(wildLogText(event('move', 'player', { move: 'tackle' }), CTX)).toBe('卡比兽 使用了 Tackle！');
    expect(wildLogText(event('move', 'wild', { move: 'thunder-shock' }), CTX)).toBe(
      '野生的皮卡丘 使用了 thunder-shock！',
    );
    expect(wildLogText(event('miss', 'wild', { move: 'thunder' }), CTX)).toBe('野生的皮卡丘 的攻击落空了…');
  });

  it('伤害带克制与会心提示', () => {
    expect(wildLogText(event('damage', 'player', { move: 'tackle', damage: 12, eff: 1 }), CTX)).toBe(
      '对 野生的皮卡丘 造成 12 伤害',
    );
    expect(wildLogText(event('damage', 'player', { damage: 30, eff: 2, crit: true }), CTX)).toBe(
      '会心一击！效果拔群！对 野生的皮卡丘 造成 30 伤害',
    );
    expect(wildLogText(event('damage', 'wild', { damage: 4, eff: 0.5 }), CTX)).toBe(
      '效果不佳…对 卡比兽 造成 4 伤害',
    );
  });

  it('倒下 / 投球 / 结果', () => {
    expect(wildLogText(event('faint', 'wild'), CTX)).toBe('野生的皮卡丘倒下了！');
    expect(wildLogText(event('faint', 'player'), CTX)).toBe('卡比兽倒下了！');
    expect(wildLogText(event('ball', 'player', { typeId: 'poke-ball', chance: 0.248 }), CTX)).toBe(
      '投出了精灵球（成功率 24.8%）…',
    );
    expect(wildLogText(event('ball-failed', 'player', { shakes: 2 }), CTX)).toBe('球摇了 2 次后弹开了！');
    expect(wildLogText(event('caught'), CTX)).toBe('恭喜！捕捉成功！');
    expect(wildLogText(event('run', 'player'), CTX)).toBe('成功逃走了。');
    expect(wildLogText(event('timeout'), CTX)).toBe('战斗超时（15 分钟无操作），野怪逃走了。');
    expect(wildLogText(event('end', undefined, { reason: 'wild-fainted' }), CTX)).toBe(
      '战斗结束：野怪被击倒，无法再捕捉。',
    );
    expect(wildLogText(event('end', undefined, { reason: 'caught' }), CTX)).toBe('');
  });

  it('缺少上下文时回退为通用文案', () => {
    expect(wildLogText(event('encounter'))).toBe('野生的宝可梦出现了！');
    expect(wildLogText(event('ball', 'player', { typeId: 'ultra-ball' }))).toBe(
      '投出了ultra-ball（成功率 0%）…',
    );
  });

  it('状态 / 能力阶级 / 换宠 / 吸血反伤文案', () => {
    expect(wildLogText(event('switch', 'player', { pokemonId: 'p_tank' }), CTX)).toBe('换上了 水箭龟！');
    expect(wildLogText(event('switch', 'player', { pokemonId: 'p_tank', forced: true }), CTX)).toBe(
      '卡比兽倒下了，换上了 水箭龟！',
    );
    expect(wildLogText(event('paralyzed', 'wild'), CTX)).toBe('野生的皮卡丘 被麻痹了，无法行动！');
    // 异常状态写入：side = 出手方，target 是对手
    expect(wildLogText(event('status', 'player', { status: 'brn', applied: true }), CTX)).toBe(
      '野生的皮卡丘 陷入了灼伤！',
    );
    expect(wildLogText(event('status', 'player', { status: 'par', applied: false }), CTX)).toBe(
      '野生的皮卡丘 已经受到异常状态影响…',
    );
    expect(wildLogText(event('status', 'wild', { status: 'psn', applied: true }), CTX)).toBe('卡比兽 陷入了中毒！');
    expect(wildLogText(event('status-damage', 'wild', { status: 'brn', damage: 4 }), CTX)).toBe(
      '野生的皮卡丘 受到了灼伤伤害 4 点',
    );
    // 能力阶级：target=foe 时作用在对手身上，target=self 时是自己
    expect(
      wildLogText(event('stat', 'player', { target: 'foe', stat: 'def', stages: -1, applied: -1, value: -1 }), CTX),
    ).toBe('野生的皮卡丘 的防御下降了 1 级！（当前 -1）');
    expect(
      wildLogText(event('stat', 'player', { target: 'self', stat: 'atk', stages: 2, applied: 2, value: 2 }), CTX),
    ).toBe('卡比兽 的攻击上升了 2 级！（当前 +2）');
    expect(wildLogText(event('stat', 'player', { target: 'foe', stat: 'spdef', stages: -1, applied: 0, value: -6 }), CTX)).toBe(
      '野生的皮卡丘 的特防已经无法再变化了…',
    );
    expect(wildLogText(event('drain', 'player', { healed: 12 }), CTX)).toBe('卡比兽 吸取了 12 点体力！');
    expect(wildLogText(event('recoil', 'player', { damage: 9 }), CTX)).toBe(
      '卡比兽 受到了 9 点反作用力伤害！',
    );
  });
});

describe('statusLabel 与技能悬停说明', () => {
  it('异常状态中文名', () => {
    expect(statusLabel('brn')).toBe('灼伤');
    expect(statusLabel('psn')).toBe('中毒');
    expect(statusLabel('par')).toBe('麻痹');
    expect(statusLabel(null)).toBe('');
    expect(statusLabel('unknown')).toBe('unknown');
  });

  it('moveDetailText 与 BattleView 同格式：名称 + 威力/命中/属性/分类 + 效果', () => {
    const move = {
      name: 'Thunder Shock',
      type: 'electric',
      power: 40,
      accuracy: 100,
      category: 'special',
      effectText: '造成伤害，10% 几率使目标麻痹。',
    };
    expect(moveDetailText('电击', move)).toBe(
      '电击（Thunder Shock）\n威力 40 · 命中 100 · electric · 特殊\n造成伤害，10% 几率使目标麻痹。',
    );
    // 无效果文本时省略说明行；无技能元数据时回退名称
    expect(moveDetailText('撞击', { ...move, effectText: '' })).toBe(
      '撞击（Thunder Shock）\n威力 40 · 命中 100 · electric · 特殊',
    );
    expect(moveDetailText('撞击', null)).toBe('撞击');
  });
});

describe('wildResultText 结果标题', () => {
  it('覆盖全部终态', () => {
    expect(wildResultText('CAUGHT')).toBe('捕捉成功！');
    expect(wildResultText('WILD_FAINTED')).toBe('野怪被击倒了');
    expect(wildResultText('PLAYER_FAINTED')).toBe('你的宝可梦倒下了…');
    expect(wildResultText('RAN')).toBe('成功逃走');
    expect(wildResultText('TIMEOUT')).toBe('战斗超时');
    expect(wildResultText('ACTIVE')).toBe('战斗中');
  });
});
