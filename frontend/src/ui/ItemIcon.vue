<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import ItemArtwork from './ItemArtwork.vue';
import { itemName } from '@/composables/useI18n';
import {
  ITEM_ICON_BORDER,
  ITEM_ICON_NATIVE,
  itemIconBox,
  itemIconUrl,
} from './item-icon';

// 道具图标：vendor 正版图标（原生 30×30，整数倍最近邻放大），
// 缺失 / 加载失败时回退为ItemArtwork 的自绘像素图标（球、药、石、王冠、钥匙、跑鞋等）。
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
    <ItemArtwork v-else :type-id="typeId" />
  </span>
</template>

<style scoped>
.item-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  vertical-align: middle;
  border: 2px solid transparent;
  image-rendering: pixelated;
}

.item-icon__img {
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}

</style>
