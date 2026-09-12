<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useItem } from '@/api/items';
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

onMounted(() => store.refreshAll());

async function confirmUse() {
  if (!usingItem.value) return;
  try {
    await useItem(usingItem.value.id, targetPokemonId.value || undefined);
    message.value = t('bag.used', { name: itemName(usingItem.value.typeId) });
    await store.refreshItems();
  } catch (e: any) {
    message.value = e?.response?.data?.message ?? t('bag.useFailed');
  } finally {
    usingItem.value = null;
    targetPokemonId.value = '';
  }
}
</script>

<template>
  <div class="page">
    <div class="px-panel">
      <h2>{{ t('bag.title') }}</h2>
      <p v-if="message" class="mb-8" style="font-size: var(--px-fs-sm); color: var(--gba-blue)">{{ message }}</p>
      <p v-if="store.loading" class="blink">{{ t('common.loading') }}</p>
      <table v-else style="width: 100%; font-size: var(--px-fs-sm); border-collapse: collapse">
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
                <span class="mono text-dim">{{ item.typeId }}</span>
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
      </table>
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
        <select v-model="targetPokemonId" class="px-select">
          <option value="">{{ t('bag.noTarget') }}</option>
          <option v-for="p in store.myPokemon" :key="p.id" :value="p.id">
            {{ monName(p.speciesId, p.name) }} Lv{{ p.level }}
          </option>
        </select>
      </div>
    </PixelDialog>
  </div>
</template>
