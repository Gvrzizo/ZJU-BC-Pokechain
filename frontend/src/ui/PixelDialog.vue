<script setup lang="ts">
import PixelButton from './PixelButton.vue';

withDefaults(
  defineProps<{
    title?: string;
    showCancel?: boolean;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
  }>(),
  {
    title: '',
    showCancel: true,
    confirmText: '确定',
    cancelText: '取消',
    danger: false,
  },
);

const emit = defineEmits<{
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();
</script>

<template>
  <teleport to="body">
    <div class="px-overlay" @click.self="emit('cancel')">
      <div class="px-panel px-dialog" role="dialog" aria-modal="true">
        <h2 v-if="title" class="mb-16">{{ title }}</h2>
        <div class="px-dialog__body">
          <slot />
        </div>
        <div class="row mt-16" style="justify-content: flex-end">
          <PixelButton v-if="showCancel" @click="emit('cancel')">{{ cancelText }}</PixelButton>
          <PixelButton :variant="danger ? 'danger' : 'primary'" @click="emit('confirm')">
            {{ confirmText }}
          </PixelButton>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.px-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.px-dialog {
  max-width: 560px;
  width: calc(100% - 32px);
  max-height: 80vh;
  overflow: auto;
}

.px-dialog__body {
  font-size: var(--px-fs-sm);
  line-height: var(--px-lh-body);
}
</style>
