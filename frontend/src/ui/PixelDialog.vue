<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import PixelButton from './PixelButton.vue';

const props = withDefaults(
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
const panel = ref<HTMLElement | null>(null);
let previousFocus: HTMLElement | null = null;
function trapFocus(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.showCancel) {
    event.preventDefault();
    emit('cancel');
  }
  if (event.key !== 'Tab') return;
  const elements = Array.from(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])
    .filter((element) => element.getClientRects().length > 0);
  const first = elements[0]; const last = elements[elements.length - 1];
  if (!first) { event.preventDefault(); return; }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first.focus();
  }
}
onMounted(() => {
  previousFocus = document.activeElement as HTMLElement | null;
  panel.value?.focus();
});
onBeforeUnmount(() => previousFocus?.focus());
</script>

<template>
  <teleport to="body">
    <div class="px-overlay" @click.self="showCancel && emit('cancel')">
      <div ref="panel" class="px-panel px-dialog" role="dialog" aria-modal="true" :aria-label="title || '提示'" tabindex="-1" @keydown="trapFocus">
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
  background: #253c4caa;
  padding: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.px-dialog {
  max-width: 560px;
  width: 100%;
  max-height: calc(100dvh - 48px);
  outline: none;
  overflow: auto;
}

.px-dialog > h2 { padding-bottom: 16px; border-bottom: 2px solid var(--px-line); }

.px-dialog__body {
  font-size: var(--px-fs-sm);
  line-height: var(--px-lh-body);
}
</style>
