import { describe, expect, it } from 'vitest';
import { pvpEventText, pvpTurnLines, statLabel, statusLabel } from './battle-log';
import type { BattleLogEvent, BattleTurnLog } from '@/types';

const CTX = {
  monNames: { p_char: '喷火龙', p_pika: '皮卡丘' },
  moveNames: { flamethrower: '喷射火焰', thunder: '十万伏特' },
  playerNames: { A: 'ash', B: 'gary' },
};

const event = (
  kind: BattleLogEvent['kind'],
  side: BattleLogEvent['side'],
  detail: Record<string, unknown> = {},
): BattleLogEvent => ({ kind, side, detail });

describe('pvpEventText PvP 日志文案', () => {
  it('出招 / 未命中 / 换宠 / 麻痹', () => {
    expect(pvpEventText(event('move', 'A', { move: 'flamethrower', attacker: 'p_char' }), CTX)).toBe(
      '喷火龙 使用了 喷射火焰！',
    );
    expect(pvpEventText(event('miss', 'A', { move: 'thunder', attacker: 'p_pika' }), CTX)).toBe(
      '皮卡丘 的攻击落空了…',
    );
    expect(pvpEventText(event('switch', 'B', { pokemonId: 'p_pika' }), CTX)).toBe('换上了 皮卡丘！');
    expect(pvpEventText(event('paralyzed', 'B', { move: 'tackle', pokemonId: 'p_pika' }), CTX)).toBe(
      '皮卡丘 被麻痹了，无法行动！',
    );
  });

  it('伤害带会心 / 克制提示，无效果只提示不打伤害数字', () => {
    expect(
      pvpEventText(event('damage', 'A', { move: 'flamethrower', damage: 87, eff: 1, defender: 'p_pika' }), CTX),
    ).toBe('对 皮卡丘 造成 87 点伤害');
    expect(
      pvpEventText(event('damage', 'A', { damage: 130, eff: 2, crit: true, defender: 'p_pika' }), CTX),
    ).toBe('会心一击！效果绝佳！对 皮卡丘 造成 130 点伤害');
    expect(pvpEventText(event('damage', 'A', { damage: 12, eff: 0.5, defender: 'p_pika' }), CTX)).toBe(
      '效果不佳…对 皮卡丘 造成 12 点伤害',
    );
    expect(pvpEventText(event('damage', 'A', { damage: 0, eff: 0, defender: 'p_pika' }), CTX)).toBe('没有效果…');
  });

  it('异常状态 / 回合末伤害 / 能力阶级 / 吸取 / 反伤 / 击倒', () => {
    expect(pvpEventText(event('status', 'A', { status: 'brn', applied: true, pokemonId: 'p_pika' }), CTX)).toBe(
      '皮卡丘 陷入了灼伤！',
    );
    expect(pvpEventText(event('status', 'A', { status: 'par', applied: false, pokemonId: 'p_pika' }), CTX)).toBe(
      '皮卡丘 已经处于麻痹状态…',
    );
    expect(pvpEventText(event('status-damage', 'B', { status: 'brn', damage: 5, pokemonId: 'p_pika' }), CTX)).toBe(
      '皮卡丘 受到了灼伤伤害 5 点',
    );
    expect(pvpEventText(event('stat', 'A', { target: 'foe', stat: 'def', stages: -1, value: -1, pokemonId: 'p_pika' }), CTX)).toBe(
      '皮卡丘 的防御下降了 1 级！',
    );
    expect(pvpEventText(event('stat', 'A', { target: 'self', stat: 'atk', stages: 2, value: 2, pokemonId: 'p_char' }), CTX)).toBe(
      '喷火龙 的攻击上升了 2 级！',
    );
    expect(pvpEventText(event('stat', 'A', { target: 'foe', stat: 'def', stages: -1, applied: 0, value: -6, pokemonId: 'p_pika' }), CTX)).toBe(
      '皮卡丘 的防御已经无法再变化了…',
    );
    expect(pvpEventText(event('drain', 'A', { healed: 20, pokemonId: 'p_char' }), CTX)).toBe('喷火龙 吸取了 20 点体力！');
    expect(pvpEventText(event('recoil', 'A', { damage: 8, pokemonId: 'p_char' }), CTX)).toBe(
      '喷火龙 受到了 8 点反作用力伤害！',
    );
    expect(pvpEventText(event('faint', 'B', { pokemonId: 'p_pika' }), CTX)).toBe('皮卡丘 倒下了！');
  });

  it('逃跑 / 胜负 / 平局用玩家名', () => {
    expect(pvpEventText(event('run', 'B', {}), CTX)).toBe('gary 逃跑了…');
    expect(pvpEventText(event('win', 'A', { reason: 'knockout' }), CTX)).toBe('ash 获胜！');
    expect(pvpEventText(event('win', undefined, { reason: 'double-ko' }), CTX)).toBe('双方同时倒下，平局！');
  });

  it('未收录的事件不产生文案，名称缺失时回退 id', () => {
    expect(pvpEventText(event('win', 'A', { reason: '' }), CTX)).toBe('ash 获胜！');
    expect(pvpEventText({ kind: 'unknown' as never, side: 'A', detail: {} }, CTX)).toBe('');
    expect(pvpEventText(event('move', 'A', { move: 'tackle', attacker: 'p_unknown' }))).toBe(
      'p_unknown 使用了 tackle！',
    );
    // 连 id 都没有（旧版本服务端/裁剪过的日志）时用占位名，不产生空名字
    expect(pvpEventText(event('move', 'A', {}), CTX)).toBe('宝可梦 使用了 技能！');
    expect(pvpEventText(event('damage', 'A', { damage: 5, eff: 1 }), CTX)).toBe('对 宝可梦 造成 5 点伤害');
  });

  it('异常状态/能力阶级中文名表与野怪战斗共用', () => {
    expect(statusLabel('brn')).toBe('灼伤');
    expect(statusLabel('psn')).toBe('中毒');
    expect(statLabel('spatk')).toBe('特攻');
    expect(statusLabel(null)).toBe('');
  });
});

describe('pvpTurnLines 回合日志行', () => {
  it('按事件顺序渲染并过滤空行', () => {
    const turn: BattleTurnLog = {
      turn: 3,
      events: [
        event('move', 'A', { move: 'flamethrower', attacker: 'p_char' }),
        event('damage', 'A', { move: 'flamethrower', damage: 87, eff: 2, defender: 'p_pika' }),
        event('status', 'A', { status: 'brn', applied: true, pokemonId: 'p_pika' }),
        event('status-damage', 'B', { status: 'brn', damage: 5, pokemonId: 'p_pika' }),
        event('faint', 'B', { pokemonId: 'p_pika' }),
        event('win', 'A', { reason: 'knockout' }),
      ],
    };
    expect(pvpTurnLines(turn, CTX)).toEqual([
      '喷火龙 使用了 喷射火焰！',
      '效果绝佳！对 皮卡丘 造成 87 点伤害',
      '皮卡丘 陷入了灼伤！',
      '皮卡丘 受到了灼伤伤害 5 点',
      '皮卡丘 倒下了！',
      'ash 获胜！',
    ]);
    expect(pvpTurnLines({ turn: 1, events: [] }, CTX)).toEqual([]);
  });
});
