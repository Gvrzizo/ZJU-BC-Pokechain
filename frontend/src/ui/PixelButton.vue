<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'default' | 'primary' | 'danger' | 'blue';
    disabled?: boolean;
    type?: 'button' | 'submit';
  }>(),
  { variant: 'default', disabled: false, type: 'button' },
);

const emit = defineEmits<{ (e: 'click', ev: MouseEvent): void }>();
</script>

<template>
  <button
    class="px-btn"
    :class="variant !== 'default' ? `px-btn--${variant}` : ''"
    :disabled="disabled"
    :type="type"
    @click="emit('click', $event)"
  >
    <slot />
  </button>
</template>
