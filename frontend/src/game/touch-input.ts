/**
 * 移动端触控输入（纯模块，不依赖 Phaser / DOM）：
 * - 方向键是"按住持续移动"，所以只保存当前方向，由场景 update() 每帧读取；
 * - 跑步是开关（点一次切换），与键盘 Shift 通过 `isRunning(shift || touchRun, hasShoes)` 合并；
 * - 场景 sleep/resume/遇敌暂停/切页时调用 `resetTouchInput()`，避免指针丢失后方向卡住。
 * TouchControls.vue 与 OverworldScene 共用这份状态，单测直接验证互斥/替换/清理语义。
 */
export type TouchDir = 'up' | 'down' | 'left' | 'right';

export interface TouchInputState {
  dir: TouchDir | null;
  run: boolean;
}

const state: TouchInputState = { dir: null, run: false };

/** 按下/滑动方向键（null = 松开所有方向） */
export function setTouchDir(dir: TouchDir | null): void {
  state.dir = dir;
}

/** 跑步开关（右下角小按钮，等价于按住 Shift 的持续效果） */
export function setTouchRun(on: boolean): void {
  state.run = on;
}

/** 清空方向与跑步开关（场景休眠/唤醒/卸载/遇敌暂停时调用） */
export function resetTouchInput(): void {
  state.dir = null;
  state.run = false;
}

export function getTouchDir(): TouchDir | null {
  return state.dir;
}

export function isTouchRunning(): boolean {
  return state.run;
}
