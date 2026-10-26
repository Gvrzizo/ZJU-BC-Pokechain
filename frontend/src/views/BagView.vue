<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { mergeStacks, useItem } from '@/api/items';
import { usePokemonStore } from '@/stores/pokemon';
import { useI18n } from '@/composables/useI18n';
import type { Item } from '@/types';
import ItemIcon from '@/ui/ItemIcon.vue';
import PixelButton from '@/ui/PixelButton.vue';
import PixelDialog from '@/ui/PixelDialog.vue';

const store = usePokemonStore();
const { t, itemName, monName } = useI18n();
const usingItem = ref<Item | null>(null);
const targetPokemonId = ref('');
const message = ref('');
// --- [FEAT:bag] begin ---
const busy = ref(false);
/** 同 typeId 有多个 IDLE 堆叠时给出"合并"入口（真链 CouchDB 延迟会导致没合并）。 */
const duplicateTypes = computed(() => {
  const seen = new Map<string, number>();
  for (const item of store.items) {
    if (item.status !== 'IDLE' || item.quantity <= 0) continue;
    seen.set(item.typeId, (seen.get(item.typeId) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([typeId]) => typeId);
});
const targetMon = computed(() => store.myPokemon.find((p) => p.id === targetPokemonId.value) ?? null);
const candyCount = computed(() => {
  if (!targetMon.value) return 0;
  return Math.max(0, Math.min(99, 20 - targetMon.value.level));
});

async function doMergeAll() {
  if (busy.value || duplicateTypes.value.length === 0) return;
  busy.value = true;
  try {
    for (const typeId of duplicateTypes.value) await mergeStacks(typeId);
    message.value = '同名堆叠已合并';
    await store.refreshItems();
  } catch (e: any) {
    message.value = e?.response?.data?.message ?? '合并失败';
  } finally {
    busy.value = false;
  }
}
// --- [FEAT:bag] end ---

onMounted(() => store.refreshAll());

async function confirmUse(count = 1) {
  if (!usingItem.value || busy.value) return;
  busy.value = true;
  try {
    const options = { targetPokemonId: targetPokemonId.value || undefined, count };
    await useItem(usingItem.value.id, options);
    message.value = t('bag.used', { name: itemName(usingItem.value.typeId) });
    await store.refreshItems();
    usingItem.value = null;
    targetPokemonId.value = '';
  } catch (e: any) {
    message.value = e?.response?.data?.message ?? t('bag.useFailed');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <div class="px-panel">
      <h2>{{ t('bag.title') }}</h2>
      <!-- --- [FEAT:bag] begin --- -->
      <p v-if="duplicateTypes.length > 0" style="font-size: var(--px-fs-sm)">
        <PixelButton :disabled="busy" @click="doMergeAll">合并重复堆叠（{{ duplicateTypes.length }} 类）</PixelButton>
      </p>
      <!-- --- [FEAT:bag] end --- -->
      <p v-if="message" class="mb-8" style="font-size: var(--px-fs-sm); color: var(--gba-blue)">{{ message }}</p>
      <p v-if="store.loading" class="blink">{{ t('common.loading') }}</p>
      <div v-else class="table-scroll"><table style="font-size: var(--px-fs-sm)">
        <thead>
          <tr style="text-align: left; border-bottom: 3px solid var(--gba-ink)">
            <th>{{ t('common.item') }}</th>
            <th>{{ t('common.quantity') }}</th>
            <th>{{ t('common.status') }}</th>
            <th>metadataHash</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in store.items" :key="item.id" style="border-bottom: 1px solid #b8a878">
            <td>
              <span class="row" style="gap: 6px; flex-wrap: nowrap">
                <ItemIcon :type-id="item.typeId" :size="24" />
                <span>{{ itemName(item.typeId) }}</span>
                
              </span>
            </td>
            <td>×{{ item.quantity }}</td>
            <td>
              <span class="badge" :class="item.status === 'IDLE' ? 'badge--green' : 'badge--yellow'">
                {{ item.status }}
              </span>
            </td>
            <td class="mono">{{ item.metadataHash?.slice(0, 12) ?? '—' }}…</td>
            <td>
              <PixelButton
                :disabled="item.quantity <= 0 || item.status !== 'IDLE'"
                @click="usingItem = item"
              >
                {{ t('common.use') }}
              </PixelButton>
            </td>
          </tr>
          <tr v-if="store.items.length === 0">
            <td colspan="5" style="padding: 16px; text-align: center" class="text-dim">
              {{ t('bag.empty') }}
            </td>
          </tr>
        </tbody>
      </table></div>
    </div>

    <PixelDialog
      v-if="usingItem"
      :title="t('bag.useTitle', { name: itemName(usingItem.typeId) })"
      :confirm-text="t('common.use')"
      @confirm="confirmUse"
      @cancel="usingItem = null"
    >
      <div class="px-field">
        <label>{{ t('bag.target') }}</label>
        <select v-model="targetPokemonId" class="px-select" :disabled="busy">
          <option value="">{{ t('bag.noTarget') }}</option>
          <option v-for="p in store.myPokemon" :key="p.id" :value="p.id">
            {{ monName(p.speciesId, p.name) }} Lv{{ p.level }}
          </option>
        </select>
      </div>
      <!-- --- [FEAT:bag] begin --- -->
      <p v-if="usingItem.typeId === 'rare-candy' && candyCount > 0" class="mt-8">
        <PixelButton :disabled="busy" @click="confirmUse(candyCount)">
          喂到 20 级（{{ candyCount }} 颗）
        </PixelButton>
      </p>
      <!-- --- [FEAT:bag] end --- -->
    </PixelDialog>
  </div>
</template>
