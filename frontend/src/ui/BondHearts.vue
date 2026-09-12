<script setup lang="ts">
import { computed } from 'vue';

/**
 * 羁绊爱心（链上 `Pokemon.bond`，0-255）：5 颗心按比例点亮。
 * 共用组件：队伍页 / 战斗结算面板都用它，数值与爱心可任选。
 */
const props = withDefaults(
  defineProps<{
    bond: number;
    /** 满值，默认链上上限 255 */
    max?: number;
    /** 爱心数量（默认 5） */
    hearts?: number;
    size?: 'sm' | 'md' | 'lg';
    /** 显示 "羁绊 60/255" 文本 */
    showValue?: boolean;
    /** 本次变化量（正数显示 +N，红色负数显示 -N） */
    delta?: number;
  }>(),
  { max: 255, hearts: 5, size: 'md', showValue: false, delta: undefined },
);

const value = computed(() => Math.max(0, Math.min(props.max, props.bond)));
/** 向上取整：1-50 也是"有一颗心"，0 才是空 */
const filled = computed(() => {
  if (value.value <= 0) return 0;
  return Math.max(1, Math.round((value.value / props.max) * props.hearts));
});
const items = computed(() =>
  Array.from({ length: props.hearts }, (_, i) => i < filled.value),
);
const label = computed(() => `羁绊 ${value.value}/${props.max}`);

/**
 * 羁绊 ≥200 = **灵魂搭档**（陪伴以月计：每日每宠上限 +6，从 50 刷到 200 至少 25 个全勤日）。
 * 纯前端徽章，链上不加字段（docs/backend-api.md §11）。
 */
const SOULMATE_BOND = 200;
const soulmate = computed(() => value.value >= SOULMATE_BOND);
</script>

<template>
  <span class="bond-hearts" :class="`bond-hearts--${size}`" :title="label">
    <span
      v-for="(on, i) in items"
      :key="i"
      class="bond-hearts__heart"
      :class="on ? 'bond-hearts__heart--on' : 'bond-hearts__heart--off'"
      >♥</span
    >
    <span v-if="showValue" class="bond-hearts__value">{{ label }}</span>
    <span
      v-if="soulmate"
      class="bond-hearts__soulmate"
      :title="`灵魂搭档：羁绊 ≥ ${SOULMATE_BOND}（长期陪伴的证明）`"
      >灵魂搭档</span
    >
    <span
      v-if="delta !== undefined && delta !== 0"
      class="bond-hearts__delta"
      :class="delta > 0 ? 'bond-hearts__delta--up' : 'bond-hearts__delta--down'"
      >{{ delta > 0 ? `+${delta}` : delta }}</span
    >
  </span>
</template>

<style scoped>
.bond-hearts {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  white-space: nowrap;
}

.bond-hearts__heart--on {
  color: #e8455f;
  text-shadow: 1px 1px 0 var(--gba-ink);
}

.bond-hearts__heart--off {
  color: #6b6b6b;
  opacity: 0.45;
}

.bond-hearts__value {
  margin-left: 4px;
}

.bond-hearts__delta--up {
  margin-left: 4px;
  color: var(--gba-green);
}

.bond-hearts__delta--down {
  margin-left: 4px;
  color: var(--gba-red);
}

/* 灵魂搭档徽章（羁绊 ≥200，前端标识，链上无字段） */
.bond-hearts__soulmate {
  margin-left: 6px;
  padding: 0 4px;
  font-size: var(--px-fs-sm);
  color: #3a2a10;
  background: linear-gradient(180deg, #ffe9a8, #e6c53c);
  border: 2px solid var(--gba-ink);
  box-shadow: 1px 1px 0 var(--gba-ink);
}

/* ♥ 取自中文像素字体（12px 点阵），字号取 12 的整数倍才清晰；
   羁绊文本（羁绊 60/255）同样受 12px 中文下限约束 */
.bond-hearts--sm {
  font-size: var(--px-fs-sm);
}

.bond-hearts--md {
  font-size: var(--px-fs-lg);
}

.bond-hearts--lg {
  font-size: var(--px-fs-xl);
}
</style>
