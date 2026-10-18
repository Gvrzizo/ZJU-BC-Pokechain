<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { usePokemonStore } from '@/stores/pokemon';
import { useWorldStore } from '@/stores/world';

/**
 * 世界 HUD（叠在游戏画面左侧，不拦截鼠标）：当前地图/区域名 + 等级带常驻，
 * 传说区换特殊配色并显示"传说宝可梦的气息…"与可捕捉对象，跨图时在上方弹一条横幅。
 *
 * **自动避让**：玩家走进地图的"左半 + 上三分之一"区域时，卡片平滑滑到右上角
 * （判定在 world store 的 `hudAvoidsPlayer`，只看玩家在图里的相对位置，
 * 所以大地图跟着相机走、小图相机居中两种情况表现一致），离开该区域即滑回。
 */
const world = useWorldStore();
const pokemon = usePokemonStore();

const banner = computed(() => world.banner);
/** 安全区（未白镇）的区域名与地图名相同，避免重复显示 */
const zoneLine = computed(() => (world.zoneLabel === world.mapName ? '' : world.zoneLabel));
const legendary = computed(() => world.legendary);
/** 已经收服过该传说（后端会拒绝重复捕捉，HUD 提前说明） */
const alreadyOwned = computed(() => {
  const def = legendary.value;
  if (!def) return false;
  return def.speciesIds.some((id) => pokemon.ownedSpeciesIds.has(id));
});

let timer: ReturnType<typeof setTimeout> | null = null;

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

watch(
  () => banner.value?.seq,
  (seq) => {
    clearTimer();
    if (!seq) return;
    // 横幅停留 2.6 秒后淡出（seq 保证新旧横幅不会互相清掉）
    timer = setTimeout(() => world.clearBanner(seq), 2600);
  },
);

onBeforeUnmount(clearTimer);

/**
 * 避让平移的距离 = 容器宽度（HUD 覆盖整块游戏画面，宽度就是画面宽）。
 * 只能量出来：卡片宽度由内容决定（`100%` 在平移里没有参照物）。
 * SSR / 单测没有真实布局时按 0 处理，此时 `--hud-width` 由 CSS 兜底。
 */
const hudWidth = ref(0);
const hudEl = ref<HTMLElement | null>(null);

function measure() {
  hudWidth.value = hudEl.value?.clientWidth ?? 0;
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  measure();
  if (typeof ResizeObserver !== 'undefined' && hudEl.value) {
    resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(hudEl.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<template>
  <div
    ref="hudEl"
    class="world-hud"
    :style="hudWidth > 0 ? { '--hud-width': `${hudWidth}px` } : undefined"
  >
    <div
      class="px-panel hud-card"
      :class="{
        'hud-card--legendary': !!legendary,
        'hud-card--right': world.hudAvoidsPlayer,
      }"
      data-testid="world-hud-card"
      :data-hud-side="world.hudAvoidsPlayer ? 'right' : 'left'"
    >
      <div class="hud-name">{{ world.mapName }}</div>
      <div class="hud-line">
        <span v-if="zoneLine">{{ zoneLine }}</span>
        <span v-if="world.zoneHint" class="text-dim">{{ world.zoneHint }}</span>
      </div>
      <div v-if="legendary" class="hud-legendary">
        <div class="hud-legendary__warning">传说宝可梦的气息…</div>
        <div v-if="world.legendaryCatchable">
          可捕捉：<strong>{{ legendary.name }}</strong>
        </div>
        <div v-else class="text-dim">本层还没有它的踪迹，往更深处走</div>
        <div v-if="world.legendaryCatchable && alreadyOwned" class="text-dim">
          你已经收服过它了（同一只传说不会再次出现）
        </div>
      </div>
      <div class="hud-coord text-dim">
        ({{ world.position.x }}, {{ world.position.y }})
        <span v-if="pokemon.hasRunningShoes" class="hud-run">
          {{ world.isRunning ? '跑步中' : '按住 Shift 跑步' }}
        </span>
      </div>
    </div>

    <div v-if="banner" class="hud-banner" :class="`hud-banner--${banner.tone}`">
      <div class="hud-banner__title">—— {{ banner.title }} ——</div>
      <div v-if="banner.subtitle" class="hud-banner__sub">{{ banner.subtitle }}</div>
    </div>
  </div>
</template>

<style scoped>
.world-hud {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.hud-card {
  position: absolute;
  top: 16px;
  left: 16px;
  min-width: 160px;
  max-width: min(380px, 62%);
  padding: 12px 16px;
  font-size: var(--px-fs-sm);
  line-height: var(--px-lh-tight);
  /* 自动避让：只动 transform（合成层平滑滑动，不触发布局、不打断 Phaser 画布） */
  transition: transform 0.28s ease-out;
}

/* 避让状态：整张卡片平移到右上角（左右各留 16px；--hud-width 是画面宽度，SSR 时退回视口宽） */
.hud-card--right {
  transform: translateX(calc(var(--hud-width, 100vw) - 100% - 32px));
}

.hud-card--legendary {
  border-color: var(--gba-green);
  background: #3a1e5c;
  color: var(--gba-cream);
}

.hud-name {
  font-size: var(--px-fs-sm);
  color: var(--gba-green);
}

.hud-card--legendary .text-dim, .hud-card--legendary .hud-run { color: #d9cddd; }

.hud-card--legendary .hud-name {
  color: #f0d6ee;
}

.hud-line {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.hud-legendary {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 2px solid var(--gba-yellow);
}

.hud-legendary__warning {
  color: #f0d6ee;
  text-shadow: 1px 1px 0 var(--gba-ink);
  animation: legend-pulse 1.4s steps(2) infinite;
}

.hud-coord {
  margin-top: 4px;
  font-size: 12px;
}

/* 跑鞋提示 / 跑步状态（拿到跑鞋之后才显示） */
.hud-run {
  margin-left: 6px;
  color: var(--gba-green);
}

.hud-banner {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  padding: 12px 16px;
  width: max-content;
  max-width: calc(100% - 48px);
  text-align: center;
  border: 3px solid var(--gba-ink);
  background: var(--gba-cream);
  color: var(--gba-ink);
  animation: banner-in 0.4s steps(3) 1;
}

.hud-banner--legendary {
  background: #493e65;
  border-color: #b6a0c0;
}

.hud-banner--legendary .hud-banner__title { color: #f0d6ee; }
.hud-banner--legendary .hud-banner__sub { color: #fff5e8; }

.hud-banner__title {
  font-size: var(--px-fs-lg);
  color: var(--gba-green);
}

.hud-banner__sub {
  margin-top: 4px;
  font-size: var(--px-fs-sm);
}

@keyframes banner-in {
  from {
    opacity: 0;
    transform: translate(-50%, -8px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}

@keyframes legend-pulse {
  50% {
    opacity: 0.55;
  }
}
@media (max-width: 600px) {
  .hud-card { min-width: 0; padding: 8px 12px; max-width: 72%; }
  .hud-line, .hud-coord { display: none; }
  .hud-legendary { font-size: 12px; }
  .hud-legendary > div:not(:first-child) { display: none; }
  .hud-banner { bottom: 16px; max-width: 90%; width: max-content; padding: 8px 12px; }
  .hud-banner__title { font-size: 12px; }
  .hud-banner__sub { display: none; }
}
</style>
