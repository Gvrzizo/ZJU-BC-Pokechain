<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 16 });
const paths: Record<string, string> = {
  ball: 'M5 1h6v1h2v2h1v2h1v5h-1v2h-2v1H4v-1H2v-2H1V6h1V4h1V2h2zm0 2H4v2H3v2h3V6h4v1h3V5h-1V3zm-2 6v2h1v1h2v1h5v-1h1v-1h1V9h-3v1H6V9zm4-2v2h2V7z',
  game: 'M1 3h4V1h6v2h4v12H1zm2 2v8h3V9h4v4h3V5H9V3H7v2z',
  bag: 'M5 1h6v3h2v2h1v9H2V6h1V4h2zm2 2v1h2V3zM4 6v7h8V6zm1 3h6v2H5z',
  shop: 'M2 1h12v3h1v3h-1v8H2V7H1V4h1zm1 2v2h2V3zm4 0v2h2V3zm4 0v2h2V3zM4 7v6h3V9h3v4h2V7z',
  pokedex: 'M3 1h10v14H3zm2 2v2h2V3zm4 0v1h2V3zM5 7v4h6V7zm0 6h3v1H5z',
  team: 'M3 1h4v4H3zm6 2h4v4H9zM1 7h8v6H1zm10 2h4v6h-4z',
  trade: 'M10 1l5 4-5 4V6H2V4h8zM6 7v3h8v2H6v3l-5-4z',
  lobby: 'M2 1h2v2h2v2h2v2h2v2h2v2h2v3h-3v-2H9v-2H7V9H5V7H3V5H1V2zm10 0h3v3h-2v2h-2V4h1zM3 10h2v2H3v3H1v-3h2z',
  ranked: 'M4 1h8v2h3v5h-3v2h-2v3h3v2H3v-2h3v-3H4V8H1V3h3zm-1 4v1h1V5zm9 0v1h1V5z',
  fairness: 'M7 1h2v2h5v2h-2l3 5h-6l2-5H9v8h4v2H3v-2h4V5H5l2 5H1l3-5H2V3h5z',
  admin: 'M6 1h4v2h2v2h3v5h-3v2h-2v3H6v-3H4v-2H1V5h3V3h2zm0 5v4h4V6z',
};
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 16 16" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true" class="pixel-icon">
    <path :d="paths[name] ?? paths.ball" />
  </svg>
</template>

<style scoped>
.pixel-icon { flex: none; vertical-align: middle; }
</style>
