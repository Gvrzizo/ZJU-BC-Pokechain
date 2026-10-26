<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { breed, getBreedingConfig, type BreedingConfig } from '@/api/breeding';
import { getMyPokemon } from '@/api/pokemon';
import { useI18n } from '@/composables/useI18n';
import { usePokemonStore } from '@/stores/pokemon';
import type { Pokemon } from '@/types';
import SpriteIcon from '@/ui/SpriteIcon.vue';
import { eligiblePartners, ivTotal, partnerBlockReason } from './breeding-pick';
import PixelDialog from '@/ui/PixelDialog.vue';

// --- [FEAT:breeding] begin ---

/**
 * 培育屋：以当前选中的宝可梦为亲代 A，再挑一只亲代 B。
 * 规则（等级/费用/遗传）全部来自链上 `GetBreedingConfig`，子代属性由链码重算校验。
 */
const props = defineProps<{ parentAId: string }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'bred', child: Pokemon): void }>();

const { t, monName } = useI18n();
const store = usePokemonStore();

const loading = ref(true);
const busy = ref(false);
const error = ref('');
const config = ref<BreedingConfig | null>(null);
const list = ref<Pokemon[]>([]);
const selectedBId = ref('');
const child = ref<Pokemon | null>(null);

const parentA = computed(() => list.value.find((p) => p.id === props.parentAId) ?? null);
const partners = computed(() =>
  config.value ? eligiblePartners(list.value, props.parentAId, config.value.minLevel) : [],
);
const selectedB = computed(() => partners.value.find((p) => p.id === selectedBId.value) ?? null);
const cost = computed(() => config.value?.cost ?? 0);
const minLevel = computed(() => config.value?.minLevel ?? 0);

function reasonText(p: Pokemon): string {
  const reason = partnerBlockReason(p, props.parentAId, config.value?.minLevel ?? 0);
  return reason ? t(`breeding.blocked.${reason}`) : '';
}

function label(p: Pokemon): string {
  return `${monName(p.speciesId, p.name)} Lv${p.level}`;
}

onMounted(async () => {
  try {
    const [cfg, mons] = await Promise.all([
      getBreedingConfig(),
      store.myPokemon.length > 0 ? Promise.resolve(store.myPokemon) : getMyPokemon(),
    ]);
    config.value = cfg;
    list.value = mons;
    selectedBId.value = eligiblePartners(mons, props.parentAId, cfg.minLevel)[0]?.id ?? '';
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    error.value = err?.response?.data?.message ?? t('breeding.loadFailed');
  } finally {
    loading.value = false;
  }
});

async function confirm(): Promise<void> {
  if (child.value) {
    emit('close');
    return;
  }
  if (!selectedB.value) {
    error.value = t('breeding.pickPartner');
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const result = await breed(props.parentAId, selectedB.value.id);
    child.value = result;
    store.upsertPokemon(result);
    emit('bred', result);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    error.value = err?.response?.data?.message ?? t('breeding.failed');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <PixelDialog
    :title="t('breeding.title')"
    :confirm-text="child ? t('common.close') : t('breeding.confirm', { cost })"
    :show-cancel="!child"
    :cancel-text="t('common.close')"
    @confirm="confirm"
    @cancel="emit('close')"
  >
    <p v-if="loading" class="text-dim">{{ t('common.loading') }}</p>

    <template v-else-if="config">
      <div class="row breed-parentA">
        <SpriteIcon v-if="parentA" :species-id="parentA.speciesId" :size="48" />
        <div>
          <div class="text-dim" style="font-size: var(--px-fs-sm)">{{ t('breeding.parentA') }}</div>
          <strong>{{ parentA ? label(parentA) : parentAId }}</strong>
        </div>
      </div>

      <template v-if="!child">
        <p class="text-dim mt-16" style="font-size: var(--px-fs-sm)">
          {{ t('breeding.rule', { level: minLevel, cost }) }}
        </p>

        <p v-if="partners.length === 0" class="mt-16">{{ t('breeding.noPartner', { level: minLevel }) }}</p>

        <template v-else>
          <h3 class="mt-16" style="font-size: var(--px-fs-sm)">{{ t('breeding.pickTitle') }}</h3>
          <p class="text-dim" style="font-size: var(--px-fs-sm)">{{ t('breeding.pickHint') }}</p>
          <div class="breed-list">
            <button
              v-for="p in partners"
              :key="p.id"
              type="button"
              class="breed-item px-panel"
              :class="{ 'breed-item--on': p.id === selectedBId }"
              :aria-pressed="p.id === selectedBId"
              @click="selectedBId = p.id"
            >
              <SpriteIcon :species-id="p.speciesId" :size="32" />
              <span>{{ p.id === selectedBId ? '▶ ' : '' }}{{ label(p) }}</span>
              <span class="text-dim" style="font-size: var(--px-fs-sm)">IV {{ ivTotal(p) }}</span>
            </button>
          </div>

          <p v-if="selectedB" class="mt-8" style="font-size: var(--px-fs-sm)">
            {{ t('breeding.selected', { name: label(selectedB) }) }}
          </p>

          <h3 class="mt-16" style="font-size: var(--px-fs-sm)">{{ t('breeding.othersTitle') }}</h3>
          <p class="text-dim" style="font-size: var(--px-fs-sm)">
            <span v-for="p in list.filter((x) => partnerBlockReason(x, parentAId, minLevel))" :key="p.id">
              {{ label(p) }}（{{ reasonText(p) }}）、
            </span>
            <span v-if="list.filter((x) => partnerBlockReason(x, parentAId, minLevel)).length === 0">—</span>
          </p>
        </template>
      </template>

      <template v-else>
        <div class="breed-child px-panel mt-16">
          <SpriteIcon :species-id="child.speciesId" :size="64" />
          <div>
            <div><strong>{{ label(child) }}</strong></div>
            <div class="text-dim" style="font-size: var(--px-fs-sm)">
              {{ t('breeding.childBond', { bond: child.bond ?? 0 }) }} · {{ t('breeding.childIv', { total: ivTotal(child) }) }}
            </div>
            <div class="text-dim mono" style="font-size: var(--px-fs-sm); overflow-wrap: anywhere">
              {{ t('breeding.lineageHash') }} {{ child.dnaHash.slice(0, 16) }}…
            </div>
          </div>
        </div>
        <p class="text-dim mt-8" style="font-size: var(--px-fs-sm)">{{ t('breeding.childNote') }}</p>
      </template>

      <p v-if="error" class="mt-8" style="color: var(--gba-red)">{{ error }}</p>
      <p v-if="busy" class="text-dim mt-8">{{ t('breeding.working') }}</p>
    </template>

    <p v-else-if="error" style="color: var(--gba-red)">{{ error }}</p>
  </PixelDialog>
</template>

<style scoped>
.breed-parentA {
  gap: 12px;
  align-items: center;
}
.breed-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 240px;
  overflow: auto;
}
.breed-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  text-align: left;
  cursor: pointer;
  font-size: var(--px-fs-sm);
}
.breed-item--on {
  border-color: var(--gba-yellow);
  box-shadow: inset 0 0 0 2px var(--gba-yellow);
}
.breed-child {
  display: flex;
  gap: 12px;
  align-items: center;
}
</style>

<!-- --- [FEAT:breeding] end --- -->
