<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from '@/composables/useI18n';
import ItemIcon from '@/ui/ItemIcon.vue';

const emit = defineEmits<{ (e: 'use', itemId: string): void }>();
const { t, itemName } = useI18n();
const id = ref('');

/** 输入命中道具 typeId 时给出图标 + 译名预览（填的是道具实例 id 就什么都不显示） */
const knownTypeId = computed(() => (id.value && itemName(id.value) !== id.value ? id.value : ''));
</script>

<template>
  <div class="row mt-8">
    <input v-model="id" class="px-input" style="flex: 1" placeholder="item id" />
    <template v-if="knownTypeId">
      <ItemIcon :type-id="knownTypeId" :size="24" />
      <span style="font-size: var(--px-fs-sm)">{{ itemName(knownTypeId) }}</span>
    </template>
    <button class="px-btn" :disabled="!id" @click="emit('use', id)">{{ t('common.use') }}</button>
  </div>
</template>
