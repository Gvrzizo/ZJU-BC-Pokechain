<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { cancelTrade, confirmTrade, createTrade, listTrades } from '@/api/trades';
import { useAuthStore } from '@/stores/auth';
import { usePokemonStore } from '@/stores/pokemon';
import { useI18n } from '@/composables/useI18n';
import type { Trade, TradeAssets } from '@/types';
import ItemIcon from '@/ui/ItemIcon.vue';
import PixelButton from '@/ui/PixelButton.vue';
import PixelDialog from '@/ui/PixelDialog.vue';
import { myTradeConfirmed } from '@/components/trade-confirm';

const auth = useAuthStore();
const store = usePokemonStore();
const { t, itemName, monName } = useI18n();
const box = ref<'in' | 'out'>('in');
const trades = ref<Trade[]>([]);
const message = ref('');
const showCreate = ref(false);

const form = ref({
  toPlayerId: '',
  ttlSeconds: 3600,
  offerPoints: 0,
  requestPoints: 0,
  offerPokemon: [] as string[],
  requestPokemon: [] as string[],
  offerItems: [] as string[],
  requestItems: [] as string[],
});

async function refresh() {
  try {
    trades.value = await listTrades(box.value);
  } catch (e: any) {
    message.value = e?.response?.data?.message ?? t('trade.loadFail');
  }
}

onMounted(() => {
  store.refreshAll();
  refresh();
});

function toggle(arr: string[], id: string) {
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(id);
}

function assetsSummary(a: TradeAssets): string {
  const parts: string[] = [];
  if (a.pokemonIds.length) parts.push(t('trade.assetsPokemon', { n: a.pokemonIds.length }));
  if (a.itemIds.length) parts.push(t('trade.assetsItems', { n: a.itemIds.length }));
  if (a.points) parts.push(`${a.points}P`);
  return parts.join(' + ') || t('trade.nothing');
}

async function submitCreate() {
  try {
    await createTrade({
      toPlayerId: form.value.toPlayerId,
      offer: {
        pokemonIds: form.value.offerPokemon,
        itemIds: form.value.offerItems,
        points: form.value.offerPoints,
      },
      request: {
        pokemonIds: form.value.requestPokemon,
        itemIds: form.value.requestItems,
        points: form.value.requestPoints,
      },
      ttlSeconds: form.value.ttlSeconds,
    });
    message.value = t('trade.created');
    showCreate.value = false;
    await refresh();
  } catch (e: any) {
    message.value = e?.response?.data?.message ?? t('trade.createFail');
  }
}

async function doConfirm(trade: Trade) {
  try {
    await confirmTrade(trade.id);
    message.value = t('trade.confirmed');
    await refresh();
  } catch (e: any) {
    message.value = e?.response?.data?.message ?? t('trade.confirmFail');
  }
}

async function doCancel(trade: Trade) {
  try {
    await cancelTrade(trade.id);
    message.value = t('trade.cancelled');
    await refresh();
  } catch (e: any) {
    message.value = e?.response?.data?.message ?? t('trade.cancelFail');
  }
}

function myConfirmed(trade: Trade): boolean {
  // H14：fromId/toId 是 username（链上 playerId），不是 UUID
  return myTradeConfirmed(trade, auth.user?.username);
}
</script>

<template>
  <div class="page">
    <div class="px-panel mb-16 row" style="justify-content: space-between">
      <h2 style="margin: 0">{{ t('trade.title') }}</h2>
      <div class="row">
        <PixelButton :variant="box === 'in' ? 'primary' : 'default'" @click="box = 'in'; refresh()">
          {{ t('trade.inbox') }}
        </PixelButton>
        <PixelButton :variant="box === 'out' ? 'primary' : 'default'" @click="box = 'out'; refresh()">
          {{ t('trade.outbox') }}
        </PixelButton>
        <PixelButton variant="blue" @click="showCreate = true">{{ t('trade.create') }}</PixelButton>
      </div>
    </div>
    <p v-if="message" class="mb-8" style="font-size: var(--px-fs-sm); color: var(--gba-blue)">{{ message }}</p>

    <div v-for="trade in trades" :key="trade.id" class="px-panel mb-16">
      <div class="row" style="justify-content: space-between">
        <strong style="font-size: var(--px-fs-sm)">{{ trade.id }}</strong>
        <span class="badge" :class="trade.status === 'OPEN' ? 'badge--yellow' : trade.status === 'EXECUTED' ? 'badge--green' : 'badge--red'">
          {{ trade.status }}
        </span>
      </div>
      <div class="grid trade-columns mt-8">
        <div>
          <p><strong>{{ trade.fromId }}</strong>{{ t('trade.fromSide') }}</p>
          <p>{{ assetsSummary(trade.offer) }}</p>
          <p>
            {{ t('trade.confirmLabel') }}
            <span :class="trade.confirmations.from ? 'check-pop' : ''">{{ trade.confirmations.from ? '✔' : '…' }}</span>
          </p>
        </div>
        <div>
          <p><strong>{{ trade.toId }}</strong>{{ t('trade.toSide') }}</p>
          <p>{{ assetsSummary(trade.request) }}</p>
          <p>
            {{ t('trade.confirmLabel') }}
            <span :class="trade.confirmations.to ? 'check-pop' : ''">{{ trade.confirmations.to ? '✔' : '…' }}</span>
          </p>
        </div>
      </div>
      <p class="mono text-dim mt-8">manifestHash: {{ trade.manifestHash?.slice(0, 32) }}…　{{ t('trade.expires') }}: {{ trade.expiresAt }}</p>
      <div v-if="trade.status === 'OPEN'" class="row mt-8">
        <PixelButton variant="primary" :disabled="myConfirmed(trade)" @click="doConfirm(trade)">
          {{ myConfirmed(trade) ? t('trade.waitOther') : t('trade.confirm') }}
        </PixelButton>
        <PixelButton variant="danger" @click="doCancel(trade)">{{ t('common.cancel') }}</PixelButton>
      </div>
    </div>
    <p v-if="trades.length === 0" class="px-panel text-dim" style="font-size: var(--px-fs-sm)">{{ t('trade.empty') }}</p>

    <PixelDialog
      v-if="showCreate"
      :title="t('trade.createTitle')"
      :confirm-text="t('trade.submit')"
      @confirm="submitCreate"
      @cancel="showCreate = false"
    >
      <div class="px-field">
        <label>{{ t('trade.counterparty') }}</label>
        <input v-model="form.toPlayerId" class="px-input" placeholder="u_xxx / 用户名" />
      </div>
      <div class="grid trade-columns">
        <div>
          <h3 style="font-size: var(--px-fs-sm)">{{ t('trade.mine') }}</h3>
          <div class="px-field">
            <label>{{ t('common.points') }}</label>
            <input v-model.number="form.offerPoints" class="px-input" type="number" min="0" />
          </div>
          <label style="font-size: var(--px-fs-sm)">{{ t('trade.pickPokemon') }}</label>
          <div style="max-height: 120px; overflow: auto; font-size: var(--px-fs-sm)">
            <label v-for="p in store.myPokemon.filter((x) => x.status === 'IDLE')" :key="p.id" style="display: block">
              <input type="checkbox" :checked="form.offerPokemon.includes(p.id)" @change="toggle(form.offerPokemon, p.id)" />
              {{ monName(p.speciesId, p.name) }} Lv{{ p.level }}
            </label>
          </div>
          <label style="font-size: var(--px-fs-sm)">{{ t('common.items') }}</label>
          <div style="max-height: 100px; overflow: auto; font-size: var(--px-fs-sm)">
            <label v-for="i in store.items.filter((x) => x.status === 'IDLE' && x.quantity > 0)" :key="i.id" style="display: block">
              <input type="checkbox" :checked="form.offerItems.includes(i.id)" @change="toggle(form.offerItems, i.id)" />
              <ItemIcon :type-id="i.typeId" :size="24" />
              {{ itemName(i.typeId) }} ×{{ i.quantity }}
            </label>
          </div>
        </div>
        <div>
          <h3 style="font-size: var(--px-fs-sm)">{{ t('trade.want') }}</h3>
          <div class="px-field">
            <label>{{ t('common.points') }}</label>
            <input v-model.number="form.requestPoints" class="px-input" type="number" min="0" />
          </div>
          <div class="px-field">
            <label>{{ t('trade.requestPokemonIds') }}</label>
            <input
              class="px-input"
              :value="form.requestPokemon.join(',')"
              @input="form.requestPokemon = ($event.target as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean)"
            />
          </div>
          <div class="px-field">
            <label>{{ t('trade.requestItemIds') }}</label>
            <input
              class="px-input"
              :value="form.requestItems.join(',')"
              @input="form.requestItems = ($event.target as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean)"
            />
          </div>
        </div>
      </div>
      <div class="px-field mt-8">
        <label>{{ t('trade.ttl') }}</label>
        <input v-model.number="form.ttlSeconds" class="px-input" type="number" min="60" />
      </div>
    </PixelDialog>
  </div>
</template>

<style scoped>
.trade-columns { grid-template-columns: repeat(2, minmax(0, 1fr)); }
@media (max-width: 640px) { .trade-columns { grid-template-columns: minmax(0, 1fr); } }
</style>
