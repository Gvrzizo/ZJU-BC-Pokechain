<script setup lang="ts">
import { computed } from 'vue';
import { itemKind } from './item-icon';
const props = defineProps<{ typeId: string }>();
const kind = computed(() => {
  if (props.typeId.includes('bottle-cap')) return 'crown';
  if (props.typeId.endsWith('-key')) return 'key';
  if (props.typeId === 'running-shoes') return 'shoes';
  if (props.typeId === 'rare-candy') return 'candy';
  return itemKind(props.typeId);
});
const colors: Record<string, string> = {
  'great-ball': '#4f91cb', 'ultra-ball': '#e3bd58', 'master-ball': '#aa78bc',
  'super-potion': '#d99455', 'gold-bottle-cap': '#e3bd58', 'bottle-cap': '#a1bbc1',
};
const color = computed(() => colors[props.typeId] ?? '#d96a6e');
</script>

<template>
  <svg viewBox="0 0 30 30" shape-rendering="crispEdges" aria-hidden="true" class="item-art">
    <path d="M7 26h16v2H7z" fill="#354f5c20" />
    <g v-if="kind === 'ball'">
      <path d="M10 4h10v2h4v4h2v10h-2v4h-4v2H10v-2H6v-4H4V10h2V6h4z" fill="#3d5362" />
      <path d="M10 6h10v2h4v6H6V8h4z" :fill="color" />
      <path d="M6 16h18v4h-2v2h-4v2h-8v-2H8v-2H6z" fill="#f9f1dc" />
      <path d="M8 8h6v2H8zm0 2h2v2H8z" fill="#ffffffa0" />
      <path d="M12 12h6v6h-6z" fill="#3d5362" /><path d="M14 14h2v2h-2z" fill="#fff9e8" />
    </g>
    <g v-else-if="kind === 'potion'">
      <path d="M10 2h10v4H10zm2 4h6v4h4v2h2v14H6V12h2v-2h4z" fill="#3d5362" />
      <path d="M12 2h6v2h-6zm2 4h2v4h-2z" fill="#c5c9e9" />
      <path d="M10 12h10v2h2v10H8V14h2z" fill="#b18cc1" />
      <path d="M10 16h10v6H10z" fill="#fff2d5" /><path d="M14 16h2v6h-2zm-2 2h6v2h-6z" fill="#d56a72" />
      <path d="M8 14h2v8H8z" fill="#d9b9dd" />
    </g>
    <g v-else-if="kind === 'stone'">
      <path d="M12 2h8v4h4v16h-4v4H8v-4H4V10h4V6h4z" fill="#3d5362" />
      <path d="M12 4h6v4h4v12h-4v4H10v-4H6v-8h4V8h2z" fill="#7db7a0" />
      <path d="M12 6h4v4h-4zm-4 6h4v6H8z" fill="#c7dfae" /><path d="M16 12h4v8h-4z" fill="#50877c" />
    </g>
    <g v-else-if="kind === 'tm' || kind === 'candy'">
      <path d="M10 4h10v2h4v4h2v10h-2v4h-4v2H10v-2H6v-4H4V10h2V6h4z" fill="#3d5362" />
      <path d="M10 6h10v2h4v12h-4v4H10v-4H6V10h4z" :fill="kind === 'tm' ? '#87bbcc' : '#9aa4db'" />
      <path d="M10 8h4v4h-4zm-2 4h4v4H8z" fill="#d9f0ea" />
      <path v-if="kind === 'tm'" d="M12 12h6v6h-6z" fill="#fff2d5" />
      <path v-else d="M12 2h6v4h-6zm0 22h6v4h-6z" fill="#c9d4ec" />
    </g>
    <g v-else-if="kind === 'crown'">
      <path d="M4 8h4v4h4V6h6v6h4V8h4v14H4z" fill="#3d5362" />
      <path d="M6 12h4v4h4V8h2v8h4v-4h4v8H6z" :fill="color" />
      <path d="M6 22h18v2H6z" :fill="color" /><path d="M12 18h6v2h-6z" fill="#f9f1dc" />
    </g>
    <g v-else-if="kind === 'key'">
      <path d="M6 2h12v2h2v10h-2v2h-4v12h-4V16H6v-2H4V4h2zm2 4v6h8V6z" fill="#526679" />
      <path d="M8 4h8v2H8zm-2 2h2v6H6zm2 6h8v2H8zm4 4h2v10h-2zm2 4h6v2h-6zm0 4h6v2h-6z" fill="#e4c078" />
    </g>
    <g v-else-if="kind === 'shoes'">
      <path d="M6 6h10v10h8v2h2v8H4V12h2z" fill="#3d5362" />
      <path d="M8 8h6v10h8v2h2v2H6V14h2z" fill="#d96a6e" />
      <path d="M6 22h18v2H6zm4-10h4v2h-4zm0 4h4v2h-4z" fill="#f9f1dc" />
    </g>
    <g v-else>
      <path d="M6 4h18v22H6z" fill="#526679" /><path d="M8 6h14v18H8z" fill="#e4c078" />
      <path d="M12 10h6v2h-6zm-2 4h10v2H10zm2 4h6v2h-6z" fill="#fff2d5" />
    </g>
  </svg>
</template>

<style scoped>
.item-art { display: block; width: 100%; height: 100%; }
</style>
