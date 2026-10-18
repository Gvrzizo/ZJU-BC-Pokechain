<script lang="ts">
/**
 * 显式组件名：`App.vue` 的 `<KeepAlive :include="['GameView']">` 按名字匹配，
 * 而 `<script setup>` 的组件默认名是文件名推导出来的（打包器转换后不一定保留），
 * 显式声明最稳妥（同时也让 Vue Devtools 里能看到 GameView）。
 */
export default { name: 'GameView' };
</script>

<script setup lang="ts">
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
import type Phaser from 'phaser';
import { useRouter } from 'vue-router';
import { createGame, destroyGame } from '@/game/createGame';
import { gameBus, BUS_EVENTS } from '@/game/bus';
import { RUNNING_SPEED_MULTIPLIER, setRunningShoes } from '@/game/running';
import { usePokemonStore } from '@/stores/pokemon';
import { useWorldStore } from '@/stores/world';
import CaptureOverlay from '@/components/CaptureOverlay.vue';
import WorldHud from '@/components/WorldHud.vue';

const gameHost = ref<HTMLElement | null>(null);
const capturing = ref(false);
/** 首次拿到跑鞋的提示（HUD 里也常驻一条"按住 Shift 跑步"） */
const runHint = ref('');
const pokemonStore = usePokemonStore();
const world = useWorldStore();
const router = useRouter();
let game: Phaser.Game | null = null;
let hintTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 保活（App.vue 的 `KeepAlive :include="['GameView']"`）：离开 /game 时组件不销毁，
 * Phaser 也只 sleep 主循环（`game.loop.sleep()`）并暂停所有音频（`sound.pauseAll()`），
 * 回来 `activate()` 直接 wake + resume——因此来回切换不会再跑一遍 BootScene
 * （控制台不会重复出现加载日志），背包/商店逛完回来还在原地。
 *
 * **20 分钟失效**：`deactivated` 记时间戳，`activated` 时超过 `KEEP_ALIVE_TTL_MS`
 * 就销毁并重建实例（`boot()` 会递增 `data-game-build`，便于验证"是重建还是唤醒"）。
 */
const KEEP_ALIVE_TTL_MS = 20 * 60 * 1000;
let sleepingSince = 0;
let buildSeq = 0;

function onEncounter() {
  capturing.value = true;
}

function onPlayerMoved(p: { x: number; y: number; running?: boolean }) {
  world.moveTo(p.x, p.y, p.running ?? false);
}

function onCaptureDone() {
  capturing.value = false;
  const scene = game?.scene.getScene('OverworldScene') as
    | { resumeFromEncounter?: () => void }
    | undefined;
  scene?.resumeFromEncounter?.();
}

/** 商店店员 / 道具店门口：离开游戏页去商店（回来时从原地继续，world store 记着位置） */
function onOpenShop() {
  capturing.value = false;
  void router.push('/shop');
}

/** 妈妈赠送跑鞋：刷新背包缓存 + 弹一条"按住 Shift 跑步"提示（HUD 里常驻同款提示） */
function onRunningShoes(payload: { speedMultiplier?: number }) {
  const multiplier = payload?.speedMultiplier ?? RUNNING_SPEED_MULTIPLIER;
  setRunningShoes(true);
  void pokemonStore.refreshItems().catch(() => undefined);
  runHint.value = `拿到跑鞋！按住 Shift 跑步（速度 ×${multiplier}）`;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    runHint.value = '';
    hintTimer = null;
  }, 6000);
}

function boot() {
  if (!gameHost.value) return;
  buildSeq += 1;
  gameHost.value.dataset.gameBuild = String(buildSeq);
  game = createGame(gameHost.value, 'overworld');
}

function teardown() {
  destroyGame(game);
  game = null;
}

/** 唤醒保活中的 Phaser（sleep → wake，不重建实例、不重跑 BootScene） */
function wake() {
  if (!game) return;
  game.loop.wake();
  game.sound.resumeAll();
}

onMounted(() => {
  boot();
  gameBus.on(BUS_EVENTS.ENCOUNTER, onEncounter);
  gameBus.on(BUS_EVENTS.PLAYER_MOVED, onPlayerMoved);
  gameBus.on(BUS_EVENTS.OPEN_SHOP, onOpenShop);
  gameBus.on(BUS_EVENTS.RUNNING_SHOES, onRunningShoes);
  pokemonStore.refreshAll();
});

onBeforeUnmount(() => {
  gameBus.off(BUS_EVENTS.ENCOUNTER, onEncounter);
  gameBus.off(BUS_EVENTS.PLAYER_MOVED, onPlayerMoved);
  gameBus.off(BUS_EVENTS.OPEN_SHOP, onOpenShop);
  gameBus.off(BUS_EVENTS.RUNNING_SHOES, onRunningShoes);
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = null;
  teardown();
});

onDeactivated(() => {
  sleepingSince = Date.now();
  // sleep 主循环（update 不再执行）+ 暂停所有 Phaser 音频；画布保留，回来直接接上
  if (game) {
    game.loop.sleep();
    game.sound.pauseAll();
  }
});

onActivated(() => {
  const expired = sleepingSince > 0 && Date.now() - sleepingSince > KEEP_ALIVE_TTL_MS;
  if (expired || !game) {
    // 超过 20 分钟没回来（或实例已经没了）：销毁重建，让场景与资源回到干净状态
    sleepingSince = 0;
    teardown();
    boot();
    return;
  }
  sleepingSince = 0;
  wake();
});
</script>

<template>
  <div class="page game-page">
    <div class="journey-heading">
      <div><span class="journey-label">HOENN · FIELD GUIDE</span><h1>{{ world.mapName }}</h1></div>
      <div class="journey-links"><router-link to="/team">查看队伍 →</router-link><router-link to="/bag">打开背包 →</router-link></div>
    </div>
    <div class="game-wrap px-panel">
      <div ref="gameHost" class="game-host" />
      <WorldHud />
      <CaptureOverlay v-if="capturing" @done="onCaptureDone" />
    </div>
    <div class="game-guide">
      <div><kbd>WASD</kbd><span>移动</span><kbd>SPACE / Z</kbd><span>对话</span><template v-if="pokemonStore.hasRunningShoes"><kbd>SHIFT</kbd><span>跑步</span></template></div>
      <span class="terrain-key"><i />深草中会遇到宝可梦</span>
    </div>
    <p v-if="runHint" class="px-panel run-hint" role="status">{{ runHint }}</p>
  </div>
</template>

<style scoped>
.game-page { max-width: 1040px; }
.journey-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.journey-label { color: var(--px-muted); font-size: 8px; letter-spacing: 1px; }
.journey-heading h1 { font-size: 24px; margin: 4px 0 0; }
.journey-links { display: flex; gap: 24px; flex-wrap: wrap; }
.game-wrap { width: 100%; padding: 8px; background: #516f69; box-shadow: inset 0 0 0 2px #a6bba3, inset 0 0 0 4px #283f40, 0 6px 0 #354f5c30; }
.game-host { width: 100%; max-width: 960px; aspect-ratio: 3 / 2; margin: auto; }
.game-host :deep(canvas) { image-rendering: pixelated; display: block; margin: 0 auto; }
.game-guide { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; padding: 16px 4px; color: var(--px-muted); }
.game-guide > div { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
kbd { padding: 4px 8px; background: var(--gba-cream); border: 1px solid var(--px-border); border-bottom-width: 3px; font: inherit; font-size: 8px; color: var(--gba-ink); }
.terrain-key { display: inline-flex; align-items: center; gap: 8px; }
.terrain-key i { width: 12px; height: 12px; background: var(--gba-green); box-shadow: inset 2px 2px 0 var(--gba-grass); }
.run-hint { margin: 8px 0 0; padding: 16px; color: var(--gba-green); }
@media (max-width: 600px) { .journey-links { gap: 12px; font-size: 12px; } .journey-heading { align-items: flex-start; } .journey-heading h1 { font-size: 16px; } .journey-label { letter-spacing: 0; } }
</style>
