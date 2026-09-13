import { describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  RUNNING_SHOES_TYPE_ID,
  RUNNING_SPEED_MULTIPLIER,
  hasRunningShoes,
  isRunning,
  ownsRunningShoes,
  setRunningShoes,
  stepDuration,
} from './running';

/**
 * 跑鞋：按住 Shift 跑步（速度 ×2）。没跑鞋时按 Shift 无效——
 * 判定只认背包里的 `running-shoes`（数量 > 0 且未锁定），
 * 与后端 `POST /users/me/running-shoes` 的幂等领取配合。
 */
describe('跑鞋：持有判定', () => {
  it('背包里有跑鞋（数量 > 0 且未锁定）才算持有', () => {
    expect(ownsRunningShoes([])).toBe(false);
    expect(ownsRunningShoes([{ typeId: 'potion', quantity: 3 }])).toBe(false);
    expect(ownsRunningShoes([{ typeId: RUNNING_SHOES_TYPE_ID, quantity: 1 }])).toBe(true);
    expect(ownsRunningShoes([{ typeId: RUNNING_SHOES_TYPE_ID, quantity: 1, status: 'IDLE' }])).toBe(true);
    // 数量 0 / 锁在交易或对战里的跑鞋不算（与 gates.ts 的钥匙口径一致）
    expect(ownsRunningShoes([{ typeId: RUNNING_SHOES_TYPE_ID, quantity: 0 }])).toBe(false);
    expect(ownsRunningShoes([{ typeId: RUNNING_SHOES_TYPE_ID, quantity: 1, status: 'LOCKED_TRADE' }])).toBe(false);
  });
});

describe('跑鞋：跑步判定与速度', () => {
  it('Shift 按下且持有跑鞋才跑（没跑鞋按 Shift 无效）', () => {
    expect(isRunning(true, true)).toBe(true);
    expect(isRunning(true, false)).toBe(false);
    expect(isRunning(false, true)).toBe(false);
    expect(isRunning(false, false)).toBe(false);
  });

  it('跑步时每格耗时减半（×2 速度），动画帧率同步加快', () => {
    expect(RUNNING_SPEED_MULTIPLIER).toBe(2);
    expect(stepDuration(150, false)).toBe(150);
    expect(stepDuration(150, true)).toBe(75);
    expect(stepDuration(120, true)).toBe(60);
  });
});

describe('跑鞋：引擎兜底缓存', () => {
  it('Pinia 里没有跑鞋时退回 setRunningShoes 的记忆', () => {
    setActivePinia(createPinia());
    setRunningShoes(false);
    expect(hasRunningShoes()).toBe(false);
    setRunningShoes(true);
    expect(hasRunningShoes()).toBe(true);
    setRunningShoes(false);
  });
});
