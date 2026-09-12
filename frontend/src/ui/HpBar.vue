<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  hp: number;
  maxHp: number;
  showText?: boolean;
}>();

const pct = computed(() =>
  props.maxHp > 0 ? Math.max(0, Math.min(100, (props.hp / props.maxHp) * 100)) : 0,
);

const cls = computed(() => {
  if (pct.value <= 20) return 'px-hpbar__fill--low';
  if (pct.value <= 50) return 'px-hpbar__fill--mid';
  return '';
});
</script>

<template>
  <div>
    <div class="px-hpbar">
      <div class="px-hpbar__fill" :class="cls" :style="{ width: pct + '%' }" />
    </div>
    <div v-if="showText" class="mt-8" style="font-size: var(--px-fs-sm)">
      HP {{ hp }} / {{ maxHp }}
    </div>
  </div>
</template>
