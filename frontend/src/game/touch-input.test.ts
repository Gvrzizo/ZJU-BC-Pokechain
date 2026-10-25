import { beforeEach, describe, expect, it } from 'vitest';
import {
  getTouchDir,
  isTouchRunning,
  resetTouchInput,
  setTouchDir,
  setTouchRun,
} from './touch-input';

describe('touch-input', () => {
  beforeEach(() => resetTouchInput());

  it('方向设置、替换与清除', () => {
    expect(getTouchDir()).toBeNull();
    setTouchDir('left');
    expect(getTouchDir()).toBe('left');
    setTouchDir('up');
    expect(getTouchDir()).toBe('up');
    setTouchDir(null);
    expect(getTouchDir()).toBeNull();
  });

  it('跑步开关独立于方向，可反复切换', () => {
    setTouchDir('right');
    setTouchRun(true);
    expect(isTouchRunning()).toBe(true);
    expect(getTouchDir()).toBe('right');
    setTouchRun(false);
    expect(isTouchRunning()).toBe(false);
    setTouchRun(true);
    expect(isTouchRunning()).toBe(true);
  });

  it('reset 同时清掉方向与跑步（防卡键）', () => {
    setTouchDir('down');
    setTouchRun(true);
    resetTouchInput();
    expect(getTouchDir()).toBeNull();
    expect(isTouchRunning()).toBe(false);
  });

  it('模块初始状态为中性', () => {
    resetTouchInput();
    expect(getTouchDir()).toBeNull();
    expect(isTouchRunning()).toBe(false);
  });
});
