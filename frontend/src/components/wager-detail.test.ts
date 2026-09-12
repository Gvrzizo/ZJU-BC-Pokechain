import { describe, expect, it } from 'vitest';
import { statsLine, wagerMonLabel } from './wager-detail';

describe('押注明细展示（查看押注弹窗）', () => {
  it('宝可梦名：中文名优先，缺失回退链上英文名，再回退资产 id', () => {
    expect(wagerMonLabel({ id: 'p_1', name: 'pikachu', nameZh: '皮卡丘' })).toBe('皮卡丘');
    expect(wagerMonLabel({ id: 'p_1', name: 'pikachu', nameZh: null })).toBe('pikachu');
    expect(wagerMonLabel({ id: 'p_1', name: null, nameZh: null })).toBe('p_1');
  });

  it('能力值摘要按 种族值+IV+EV+等级+性格 的六项顺序拼接，无数据时为空串', () => {
    const stats = { hp: 20, atk: 11, def: 9, spatk: 12, spdef: 11, speed: 10 };
    expect(statsLine(stats)).toBe('HP20 · 攻击11 · 防御9 · 特攻12 · 特防11 · 速度10');
    expect(statsLine(null)).toBe('');
  });
});
