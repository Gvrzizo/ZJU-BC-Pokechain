<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue';
import { usePokemonStore } from '@/stores/pokemon';
import { useWorldStore } from '@/stores/world';

/**
 * 世界 HUD（叠在游戏画面左上角，不拦截鼠标）：当前地图/区域名 + 等级带常驻，
 * 传说区换特殊配色并显示"传说宝可梦的气息…"与可捕捉对象，跨图时在上方弹一条横幅。
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
</script>

<template>
  <div class="world-hud">
    <div class="px-panel px-panel--dark hud-card" :class="{ 'hud-card--legendary': !!legendary }">
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
      <div class="mono hud-coord text-dim">({{ world.position.x }}, {{ world.position.y }})</div>
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
  top: 8px;
  left: 8px;
  min-width: 200px;
  max-width: 62%;
  padding: 6px 10px;
  font-size: var(--px-fs-sm);
  line-height: var(--px-lh-tight);
}

.hud-card--legendary {
  border-color: var(--gba-yellow);
  background: #3a1e5c;
  color: var(--gba-cream);
}

.hud-name {
  font-size: var(--px-fs-sm);
  color: var(--gba-yellow);
}

.hud-card--legendary .hud-name {
  color: #ffd8f8;
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
  color: #ffd8f8;
  text-shadow: 1px 1px 0 var(--gba-ink);
  animation: legend-pulse 1.4s steps(2) infinite;
}

.hud-coord {
  margin-top: 2px;
}

.hud-banner {
  position: absolute;
  top: 40px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 18px;
  text-align: center;
  border: 3px solid var(--gba-ink);
  background: rgba(28, 58, 30, 0.92);
  color: var(--gba-cream);
  animation: banner-in 0.4s steps(3) 1;
}

.hud-banner--legendary {
  background: rgba(58, 30, 92, 0.94);
  border-color: var(--gba-yellow);
}

.hud-banner__title {
  font-size: var(--px-fs-lg);
  color: var(--gba-yellow);
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
</style>
