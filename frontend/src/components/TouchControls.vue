<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  isTouchRunning,
  resetTouchInput,
  setTouchDir,
  setTouchRun,
  type TouchDir,
} from '@/game/touch-input';

/**
 * 移动端触控层：左下 D-pad（按住持续移动）、右下 A（对话/互动）、小跑步开关。
 * 只改 `game/touch-input.ts` 的模块状态，方向由 OverworldScene.update() 读取；
 * 组件本身不发移动事件（避免每个 pointermove 都过 Vue/Phaser 事件总线）。
 */
const props = defineProps<{ visible?: boolean }>();
const emit = defineEmits<{ action: [] }>();

const autoVisible = ref(false);
const pressedDir = ref<TouchDir | null>(null);
const runOn = ref(false);
/** 多指同时按方向键时，最后按下的方向生效；松开一指回退到仍按住的方向 */
const activePointers = new Map<number, TouchDir>();

const shown = computed(() => props.visible ?? autoVisible.value);

function detectTouchDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  try {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) {
      return true;
    }
  } catch {
    /* 老浏览器/隐私模式：忽略，继续看 maxTouchPoints */
  }
  return typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 0;
}

function capture(event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement | null;
  try {
    target?.setPointerCapture?.(event.pointerId);
  } catch {
    /* 指针已释放 / 非标准实现：继续处理，不阻塞输入 */
  }
}

function pressDir(dir: TouchDir, event: PointerEvent): void {
  event.preventDefault();
  capture(event);
  activePointers.set(event.pointerId, dir);
  pressedDir.value = dir;
  setTouchDir(dir);
}

function releaseDir(dir: TouchDir, event: PointerEvent): void {
  event.preventDefault();
  activePointers.delete(event.pointerId);
  if (pressedDir.value !== dir) return;
  // 回退到最后仍按住的方向；没有则清空（松开 = 停止移动）
  const remaining = [...activePointers.values()].pop() ?? null;
  pressedDir.value = remaining;
  setTouchDir(remaining);
}

function toggleRun(event: PointerEvent): void {
  event.preventDefault();
  runOn.value = !runOn.value;
  setTouchRun(runOn.value);
}

function doAction(event: PointerEvent): void {
  event.preventDefault();
  emit('action');
}

onMounted(() => {
  if (props.visible === undefined) autoVisible.value = detectTouchDevice();
  // 组件重建时回到中性状态，避免上一层的残留方向让角色自己走
  resetTouchInput();
  activePointers.clear();
  pressedDir.value = null;
  runOn.value = isTouchRunning();
});

onBeforeUnmount(() => {
  resetTouchInput();
  activePointers.clear();
  pressedDir.value = null;
});

// 供场景/GameView 主动清理（KeepAlive 休眠时也可直接调模块函数）
defineExpose({ reset: resetTouchInput });
</script>

<template>
  <div
    v-if="shown"
    class="touch-controls"
    data-testid="touch-controls"
    role="group"
    aria-label="触控操作"
    @contextmenu.prevent
  >
    <div class="touch-dpad" data-testid="touch-dpad">
      <button
        type="button"
        class="touch-btn touch-btn--dir touch-btn--up"
        :class="{ 'is-pressed': pressedDir === 'up' }"
        data-testid="touch-up"
        aria-label="向上"
        @pointerdown="pressDir('up', $event)"
        @pointerup="releaseDir('up', $event)"
        @pointercancel="releaseDir('up', $event)"
        @lostpointercapture="releaseDir('up', $event)"
      >
        ▲
      </button>
      <button
        type="button"
        class="touch-btn touch-btn--dir touch-btn--left"
        :class="{ 'is-pressed': pressedDir === 'left' }"
        data-testid="touch-left"
        aria-label="向左"
        @pointerdown="pressDir('left', $event)"
        @pointerup="releaseDir('left', $event)"
        @pointercancel="releaseDir('left', $event)"
        @lostpointercapture="releaseDir('left', $event)"
      >
        ◀
      </button>
      <button
        type="button"
        class="touch-btn touch-btn--dir touch-btn--right"
        :class="{ 'is-pressed': pressedDir === 'right' }"
        data-testid="touch-right"
        aria-label="向右"
        @pointerdown="pressDir('right', $event)"
        @pointerup="releaseDir('right', $event)"
        @pointercancel="releaseDir('right', $event)"
        @lostpointercapture="releaseDir('right', $event)"
      >
        ▶
      </button>
      <button
        type="button"
        class="touch-btn touch-btn--dir touch-btn--down"
        :class="{ 'is-pressed': pressedDir === 'down' }"
        data-testid="touch-down"
        aria-label="向下"
        @pointerdown="pressDir('down', $event)"
        @pointerup="releaseDir('down', $event)"
        @pointercancel="releaseDir('down', $event)"
        @lostpointercapture="releaseDir('down', $event)"
      >
        ▼
      </button>
      <span class="touch-dpad__hub" aria-hidden="true" />
    </div>

    <button
      type="button"
      class="touch-btn touch-btn--run"
      :class="{ 'is-on': runOn }"
      data-testid="touch-run"
      :aria-pressed="runOn"
      aria-label="跑步切换"
      @pointerdown="toggleRun"
    >
      跑
    </button>

    <button
      type="button"
      class="touch-btn touch-btn--action"
      data-testid="touch-action"
      aria-label="互动/确认"
      @pointerdown="doAction"
    >
      A
    </button>
  </div>
</template>

<style scoped>
.touch-controls {
  position: absolute;
  inset: 0;
  z-index: 15;
  pointer-events: none;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}

.touch-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  font-family: var(--px-font);
  font-size: var(--px-fs-sm);
  line-height: 1;
  color: var(--gba-ink);
  background: rgb(250 248 233 / 82%);
  border: 2px solid var(--gba-ink);
  box-shadow: inset 2px 2px 0 #fffef2, inset -2px -2px 0 #ccd7c0, 0 2px 0 #354f5c8c;
  cursor: pointer;
  pointer-events: auto;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.touch-btn.is-pressed,
.touch-btn:active {
  background: rgb(240 205 121 / 92%);
  transform: translateY(2px);
  box-shadow: inset 2px 2px 0 #0000001f;
}

.touch-dpad {
  position: absolute;
  left: 12px;
  bottom: 12px;
  display: grid;
  grid-template-columns: repeat(3, 48px);
  grid-template-rows: repeat(3, 48px);
  gap: 2px;
  pointer-events: none;
}
.touch-btn--dir { width: 48px; height: 48px; }
.touch-btn--up { grid-area: 1 / 2; }
.touch-btn--left { grid-area: 2 / 1; }
.touch-btn--right { grid-area: 2 / 3; }
.touch-btn--down { grid-area: 3 / 2; }
.touch-dpad__hub {
  grid-area: 2 / 2;
  align-self: center;
  justify-self: center;
  width: 14px;
  height: 14px;
  background: rgb(53 79 92 / 26%);
  border: 2px solid rgb(53 79 92 / 38%);
}

.touch-btn--action {
  position: absolute;
  right: 16px;
  bottom: 20px;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  font-size: var(--px-fs-lg);
  background: rgb(188 77 89 / 82%);
  color: #fffdf0;
  box-shadow: inset 2px 2px 0 #ffffff4d, inset -2px -2px 0 #00000020, 0 2px 0 var(--gba-ink);
}
.touch-btn--run {
  position: absolute;
  right: 24px;
  bottom: 96px;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: var(--px-muted);
  opacity: 0.92;
}
.touch-btn--run.is-on {
  color: #fffdf0;
  background: rgb(53 121 102 / 90%);
}

@media (max-width: 420px) {
  .touch-dpad {
    left: 8px;
    bottom: 8px;
    grid-template-columns: repeat(3, 44px);
    grid-template-rows: repeat(3, 44px);
  }
  .touch-btn--dir { width: 44px; height: 44px; }
  .touch-btn--action { right: 12px; bottom: 16px; width: 58px; height: 58px; }
  .touch-btn--run { right: 19px; bottom: 84px; width: 40px; height: 40px; }
}
</style>
