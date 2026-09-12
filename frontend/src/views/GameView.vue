<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type Phaser from 'phaser';
import { createGame, destroyGame } from '@/game/createGame';
import { gameBus, BUS_EVENTS } from '@/game/bus';
import { useAssetsStore } from '@/stores/assets';
import { usePokemonStore } from '@/stores/pokemon';
import CaptureOverlay from '@/components/CaptureOverlay.vue';

const gameHost = ref<HTMLElement | null>(null);
const capturing = ref(false);
const pos = ref({ x: 5, y: 5 });
const assets = useAssetsStore();
const pokemonStore = usePokemonStore();
let game: Phaser.Game | null = null;

function onEncounter() {
  capturing.value = true;
}

function onPlayerMoved(p: { x: number; y: number }) {
  pos.value = p;
}

function onCaptureDone() {
  capturing.value = false;
  const scene = game?.scene.getScene('OverworldScene') as
    | { resumeFromEncounter?: () => void }
    | undefined;
  scene?.resumeFromEncounter?.();
}

onMounted(() => {
  if (gameHost.value) game = createGame(gameHost.value, 'overworld');
  gameBus.on(BUS_EVENTS.ENCOUNTER, onEncounter);
  gameBus.on(BUS_EVENTS.PLAYER_MOVED, onPlayerMoved);
  pokemonStore.refreshAll();
});

onBeforeUnmount(() => {
  gameBus.off(BUS_EVENTS.ENCOUNTER, onEncounter);
  gameBus.off(BUS_EVENTS.PLAYER_MOVED, onPlayerMoved);
  destroyGame(game);
  game = null;
});
</script>

<template>
  <div class="page">
    <div class="game-wrap px-panel" style="padding: 8px; position: relative">
      <div ref="gameHost" class="game-host" />
      <CaptureOverlay v-if="capturing" @done="onCaptureDone" />
    </div>
    <div class="row mt-8" style="justify-content: space-between">
      <div class="px-panel px-panel--dark" style="padding: 8px 12px; font-size: var(--px-fs-sm)">
        方向键 / WASD 移动 · 走进深草（暗绿色）会遇敌 · 坐标 ({{ pos.x }}, {{ pos.y }})
      </div>
      <div class="px-panel" style="padding: 8px 12px; font-size: var(--px-fs-sm)">
        素材：vendor {{ Object.keys(assets.loadedFromVendor).length }} / 占位
        {{ assets.placeholderKeys.length }}
        <span v-if="assets.manifestError" class="text-dim">（{{ assets.manifestError }}）</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.game-wrap {
  width: fit-content;
  margin: 0 auto;
}

.game-host {
  width: 960px;
  max-width: 100%;
  aspect-ratio: 3 / 2;
}

.game-host :deep(canvas) {
  image-rendering: pixelated;
  display: block;
  margin: 0 auto;
}
</style>
