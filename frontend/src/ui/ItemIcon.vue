<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { itemName } from '@/composables/useI18n';
import {
  ITEM_ICON_BORDER,
  ITEM_ICON_NATIVE,
  ITEM_KIND_COLOR,
  ITEM_KIND_GLYPH,
  itemIconBox,
  itemIconUrl,
  itemKind,
} from './item-icon';

// 道具图标：vendor 正版图标（原生 30×30，整数倍最近邻放大），
// 缺失 / 加载失败时回退为按类别配色的像素占位块（与宝可梦 SpriteIcon 同一套风格）。
const props = withDefaults(
  defineProps<{
    typeId: string;
    /** 期望显示边长，实际取原生边长的整数倍 */
    size?: number;
  }>(),
  { size: 24 },
);

const failed = ref(false);
const native = ref(ITEM_ICON_NATIVE);

watch(
  () => props.typeId,
  () => {
    failed.value = false;
    native.value = ITEM_ICON_NATIVE;
  },
);

const label = computed(() => itemName(props.typeId));
const src = computed(() => itemIconUrl(props.typeId));
const kind = computed(() => itemKind(props.typeId));
const box = computed(() => itemIconBox(props.size, native.value));
const total = computed(() => box.value + ITEM_ICON_BORDER * 2);

/** 图片真实边长用于整数倍缩放，换用 24×24/48×48 素材时自动适配 */
function onLoad(ev: Event) {
  const img = ev.target as HTMLImageElement;
  if (img.naturalWidth > 0) native.value = img.naturalWidth;
}
</script>

<template>
  <span
    class="item-icon"
    :title="label"
    :style="{
      width: total + 'px',
      height: total + 'px',
      background: failed ? ITEM_KIND_COLOR[kind] : 'transparent',
    }"
  >
    <img
      v-if="!failed"
      class="item-icon__img"
      :src="src"
      :alt="label"
      loading="lazy"
      decoding="async"
      @load="onLoad"
      @error="failed = true"
    />
    <span v-else class="item-icon__glyph" :style="{ fontSize: Math.max(8, box / 2) + 'px' }">
      {{ ITEM_KIND_GLYPH[kind] }}
    </span>
  </span>
</template>

<style scoped>
.item-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  vertical-align: middle;
  border: 2px solid var(--gba-ink);
  box-shadow: inset -2px -2px 0 0 rgba(0, 0, 0, 0.25);
  image-rendering: pixelated;
}

.item-icon__img {
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}

.item-icon__glyph {
  color: #fff;
  line-height: 1;
  text-shadow: 2px 2px 0 #282828;
}
</style>
