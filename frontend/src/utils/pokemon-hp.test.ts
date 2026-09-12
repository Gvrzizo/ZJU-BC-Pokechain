import { describe, expect, it } from 'vitest';
import type { Pokemon } from '@/types';
import { currentHpOf, hpText, isFainted, maxHpOf } from './pokemon-hp';

/** 只关心 HP 相关字段：其余链上字段与本工具无关 */
function mon(overrides: Partial<Pokemon>): Pokemon {
  return { id: 'p_x', stats: { hp: 64, atk: 1, def: 1, spatk: 1, spdef: 1, speed: 1 }, ...overrides } as Pokemon;
}

describe('宝可梦当前 HP 工具（伤势持久化，docs/backend-api.md §2）', () => {
  it('currentHp 缺省 = 满血（旧缓存/新账号），显式值原样返回', () => {
    expect(currentHpOf(mon({}))).toBe(64);
    expect(currentHpOf(mon({ currentHp: 7 }))).toBe(7);
    expect(hpText(mon({ currentHp: 7 }))).toBe('7/64');
  });

  it('越界/脏数据夹到 [0, maxHp]', () => {
    expect(currentHpOf(mon({ currentHp: 999 }))).toBe(64);
    expect(currentHpOf(mon({ currentHp: -5 }))).toBe(0);
  });

  it('fainted：0 HP 为真（后端 fainted 字段优先）；字段缺省不算濒死', () => {
    expect(isFainted(mon({ currentHp: 0 }))).toBe(true);
    expect(isFainted(mon({ currentHp: 1 }))).toBe(false);
    expect(isFainted(mon({ currentHp: 30, fainted: false }))).toBe(false);
    // 后端显式标记濒死时以字段为准（即使 currentHp 看上去>0）
    expect(isFainted(mon({ currentHp: 30, fainted: true }))).toBe(true);
    // 旧缓存/未知 HP：不误判为濒死（否则全队都会变成"不能出战"）
    expect(isFainted(mon({}))).toBe(false);
    expect(isFainted(mon({ stats: undefined }))).toBe(false);
  });

  it('缺 stats 时退化为 — / 0（不抛错）', () => {
    expect(maxHpOf(mon({ stats: undefined }))).toBe(0);
    expect(currentHpOf(mon({ stats: undefined }))).toBe(0);
    expect(hpText(mon({ stats: undefined }))).toBe('—');
  });
});
