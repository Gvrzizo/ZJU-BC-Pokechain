<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { usePokemonStore } from '@/stores/pokemon';
import { useI18n } from '@/composables/useI18n';
import type { PokedexEntry } from '@/types';
import SpriteIcon from '@/ui/SpriteIcon.vue';

/**
 * 后端 /pokedex 返回 speciesId/name/nameZh/type（单属性）/ownedCount，
 * 前端 PokedexEntry 里是 types（数组）/owned —— 这里做一层兼容归一化。
 */
type DexEntry = PokedexEntry & { type?: string; nameZh?: string; ownedCount?: number };

const store = usePokemonStore();
const { t, monName, itemName } = useI18n();
const selected = ref<DexEntry | null>(null);

const entries = computed<DexEntry[]>(() => store.pokedex as DexEntry[]);
const ownedIds = computed(() => store.ownedSpeciesIds);
const ownedCount = computed(
  () => entries.value.filter((e) => ownedOf(e) > 0 || ownedIds.value.has(e.speciesId)).length,
);

function ownedOf(e: DexEntry): number {
  return e.owned ?? e.ownedCount ?? 0;
}

function typesOf(e: DexEntry): string[] {
  return e.types ?? (e.type ? [e.type] : []);
}

onMounted(() => store.refreshAll());

function isOwned(e: DexEntry) {
  return ownedOf(e) > 0 || ownedIds.value.has(e.speciesId);
}

/** 属性名走词典（'electric' → 电 / Electric），未收录回退英文原名 */
function typeLabel(type: string): string {
  const key = `type.${type}`;
  const label = t(key);
  return label === key ? type : label;
}
</script>

<template>
  <div class="page">
    <div class="px-panel mb-16">
      <h2>{{ t('dex.title') }}</h2>
      <p style="font-size: var(--px-fs-sm)">
        {{ t('dex.progress', { owned: ownedCount, total: entries.length || '?' }) }}
      </p>
    </div>
    <div style="display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap">
      <!-- 386 格：sprite 由 SpriteIcon 懒加载（loading=lazy），网格本身不做虚拟滚动 -->
      <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); flex: 1">
        <button
          v-for="e in entries"
          :key="e.speciesId"
          class="px-panel dex-cell"
          :class="{ 'dex-cell--owned': isOwned(e) }"
          style="padding: 8px; cursor: pointer; text-align: center"
          @click="selected = e"
        >
          <SpriteIcon :species-id="e.speciesId" :size="48" style="margin: 0 auto" />
          <div style="font-size: var(--px-fs-sm); margin-top: 6px">
            #{{ String(e.speciesId).padStart(3, '0') }}
          </div>
          <div style="font-size: var(--px-fs-sm)">{{ isOwned(e) ? monName(e.speciesId, e.name) : t('dex.unknown') }}</div>
        </button>
        <p v-if="entries.length === 0" class="text-dim" style="font-size: var(--px-fs-sm)">
          {{ t('dex.empty') }}
        </p>
      </div>

      <div v-if="selected" class="px-panel" style="width: 300px">
        <h2>
          #{{ String(selected.speciesId).padStart(3, '0') }}
          {{ isOwned(selected) ? monName(selected.speciesId, selected.name) : t('dex.unknown') }}
        </h2>
        <SpriteIcon :species-id="selected.speciesId" :size="96" style="margin: 12px auto" />
        <p style="font-size: var(--px-fs-sm)">
          {{ t('dex.types', { types: typesOf(selected).map(typeLabel).join(' / ') || t('dex.unknownType') }) }}
        </p>
        <p style="font-size: var(--px-fs-sm)">{{ t('dex.baseRate', { rate: selected.baseRate ?? '—' }) }}</p>
        <p style="font-size: var(--px-fs-sm)">
          {{ t('dex.ownedCount', { count: ownedOf(selected) || (isOwned(selected) ? '≥1' : 0) }) }}
          <span v-if="isOwned(selected)" class="badge badge--green">{{ t('dex.owned') }}</span>
        </p>

        <!-- 进化链：当前 → 目标（sprite + 中文名 + 条件），条件来自后端 /pokedex 的 evolutions -->
        <h3 class="mt-16" style="font-size: var(--px-fs-sm)">{{ t('dex.evolution') }}</h3>
        <div v-if="(selected.evolutions ?? []).length > 0">
          <div
            v-for="step in selected.evolutions"
            :key="step.targetSpeciesId"
            class="row"
            style="align-items: center; gap: 6px; margin-top: 6px"
          >
            <SpriteIcon :species-id="selected.speciesId" :size="40" />
            <span style="font-size: var(--px-fs-sm)">→</span>
            <SpriteIcon :species-id="step.targetSpeciesId" :size="40" />
            <div style="flex: 1; font-size: var(--px-fs-sm)">
              <div>
                #{{ String(step.targetSpeciesId).padStart(3, '0') }}
                {{ monName(step.targetSpeciesId, step.targetNameZh || step.targetName) }}
              </div>
              <div class="text-dim">
                {{
                  step.stoneTypeId
                    ? t('dex.evoStone', { stone: itemName(step.stoneTypeId), level: step.minLevel })
                    : t('dex.evoLevel', { level: step.minLevel })
                }}
              </div>
            </div>
          </div>
        </div>
        <p v-else class="text-dim" style="font-size: var(--px-fs-sm)">{{ t('dex.evoNone') }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dex-cell {
  opacity: 0.55;
  filter: saturate(0.3);
}

.dex-cell--owned {
  opacity: 1;
  filter: none;
  border-color: var(--gba-green);
}
</style>
