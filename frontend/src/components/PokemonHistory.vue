<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { getPokemonHistory, type PokemonHistory } from '@/api/pokemon';
import { useI18n } from '@/composables/useI18n';
import PixelDialog from '@/ui/PixelDialog.vue';
import { eventDetail, formatBlockTime, summaryParts } from './pokemon-history';

// --- [FEAT:history] begin ---

/**
 * 宝可梦履历：数据来自链码 `HistoryContract:GetPokemonHistory`（账本历史），
 * 不是数据库里另存的一份。摘要（初训家/转手/版本）在完整历史上统计，
 * 时间线只展示最近 N 条（truncated 时给出提示）。
 */
const props = defineProps<{ pokemonId: string; pokemonName?: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { t, monName } = useI18n();
const history = ref<PokemonHistory | null>(null);
const loading = ref(true);
const error = ref('');

function speciesName(speciesId: number): string {
  if (!Number.isFinite(speciesId)) return '—';
  return monName(speciesId);
}

onMounted(async () => {
  try {
    history.value = await getPokemonHistory(props.pokemonId);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    error.value = err?.response?.data?.message ?? t('history.failed');
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <PixelDialog
    :title="t('history.title', { name: pokemonName || pokemonId })"
    :show-cancel="false"
    :confirm-text="t('common.close')"
    @confirm="emit('close')"
    @cancel="emit('close')"
  >
    <p v-if="loading" class="text-dim">{{ t('common.loading') }}</p>
    <p v-else-if="error" style="color: var(--gba-red)">{{ error }}</p>

    <template v-else-if="history">
      <div class="row history-summary">
        <span v-for="part in summaryParts(history)" :key="part.label">
          <span class="text-dim">{{ t(`history.${part.label}`) }}：</span>
          <strong>{{ part.value }}</strong>
        </span>
      </div>

      <p v-if="history.entries.length === 0" class="text-dim mt-16">{{ t('history.empty') }}</p>

      <ol v-else class="history-list mt-16">
        <li v-for="event in history.entries" :key="`${event.txId}-${event.type}`" class="history-item">
          <span class="history-time mono">{{ formatBlockTime(event.at) }}</span>
          <span class="history-type">{{ t(`history.type.${event.type}`) }}</span>
          <span v-if="eventDetail(event, speciesName)" class="history-detail">
            {{ eventDetail(event, speciesName) }}
          </span>
        </li>
      </ol>

      <p v-if="history.truncated" class="text-dim mt-16" style="font-size: var(--px-fs-sm)">
        {{ t('history.truncated', { versions: history.versions }) }}
      </p>
      <p class="text-dim mt-16" style="font-size: var(--px-fs-sm)">{{ t('history.note') }}</p>
    </template>
  </PixelDialog>
</template>

<style scoped>
.history-summary {
  gap: 16px;
  flex-wrap: wrap;
}
.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border-left: 2px solid var(--px-line);
}
.history-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 0 4px 12px;
  position: relative;
}
.history-item::before {
  content: '';
  position: absolute;
  left: -5px;
  top: 10px;
  width: 8px;
  height: 8px;
  background: var(--gba-yellow);
  border: 2px solid var(--px-line);
}
.history-time {
  color: var(--px-muted);
  font-size: var(--px-fs-sm);
  white-space: nowrap;
}
.history-type {
  font-weight: bold;
  min-width: 4em;
}
.history-detail {
  color: var(--px-muted);
  overflow-wrap: anywhere;
}
</style>

<!-- --- [FEAT:history] end --- -->
