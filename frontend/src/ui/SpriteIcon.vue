<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { MON_NATIVE, pokemonSpriteUrl } from '@/game/mon-assets';
import { speciesColor } from '@/game/textures';

// 宝可梦图标：优先使用 vendor 正版 sprite（64×64，整数倍最近邻放大），
// 缺失 / 加载失败时回退为底色 + 编号的占位色块（与 Phaser 占位贴图同一套配色）。
const props = withDefaults(
  defineProps<{
    speciesId: number;
    size?: number;
  }>(),
  { size: 64 },
);

const failed = ref(false);
watch(
  () => props.speciesId,
  () => {
    failed.value = false;
  },
);

const label = computed(() => String(props.speciesId).padStart(3, '0'));
const src = computed(() => pokemonSpriteUrl(props.speciesId));
// 取整到 64 的整数倍（1×/2×…），避免非整数放大造成像素错位
const scale = computed(() => Math.max(1, Math.round(props.size / MON_NATIVE)));
const box = computed(() => scale.value * MON_NATIVE);
const total = computed(() => box.value + 6); // 含 3px 像素边框
</script>

<template>
  <div
    class="sprite-icon pixel"
    :style="{
      width: total + 'px',
      height: total + 'px',
      background: failed ? speciesColor(speciesId) : 'transparent',
    }"
  >
    <img
      v-if="!failed"
      class="sprite-icon__img"
      :src="src"
      alt=""
      loading="lazy"
      decoding="async"
      @error="failed = true"
    />
    <span v-else class="sprite-icon__no" :style="{ fontSize: 12 + 'px' }">
      #{{ label }}
    </span>
  </div>
</template>

<style scoped>
.sprite-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 3px solid transparent;
  flex: none;
  background-image: linear-gradient(transparent 85%, #8fa58b26 85%);
  color: #fff;
  text-shadow: 2px 2px 0 #282828;
  font-family: var(--px-font);
}

.sprite-icon__img {
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}
</style>
