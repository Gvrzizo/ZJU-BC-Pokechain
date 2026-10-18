<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { getMyItems } from '@/api/items';
import { buyItem, getShop, sellItem, type ShopEntry } from '@/api/shop';
import { useAuthStore } from '@/stores/auth';
import { useI18n } from '@/composables/useI18n';
import type { Item } from '@/types';
import ItemIcon from '@/ui/ItemIcon.vue';
import PixelButton from '@/ui/PixelButton.vue';
import PixelDialog from '@/ui/PixelDialog.vue';

const auth = useAuthStore();
const { t, itemName } = useI18n();

const tab = ref<'buy' | 'sell'>('buy');
const entries = ref<ShopEntry[]>([]);
const owned = ref<Item[]>([]);
const points = ref(auth.user?.points ?? 0);
const maxQty = ref(99);
const loading = ref(false);
const busy = ref('');
const message = ref('');
const error = ref('');
const buyQty = ref<Record<string, number>>({});
const sellQty = ref<Record<string, number>>({});
const selling = ref<Item | null>(null);

/** typeId → 回收价（null = 商店不回收） */
const sellPrices = computed<Record<string, number | null>>(() =>
  Object.fromEntries(entries.value.map((e) => [e.typeId, e.sellPrice])),
);

/** 卖出页签：IDLE 且有回收价的堆叠（锁定中的不可卖，master-ball 不在价目表里也不可卖） */
const sellable = computed(() =>
  owned.value.filter((i) => i.status === 'IDLE' && sellPrices.value[i.typeId] != null),
);
const locked = computed(() => owned.value.filter((i) => i.status !== 'IDLE' || sellPrices.value[i.typeId] == null));

function clampQty(value: number, max: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(Math.floor(value), 1), Math.max(1, max));
}

const buyQuantity = (entry: ShopEntry) => buyQty.value[entry.typeId] ?? 1;
function setBuyQty(typeId: string, value: number) {
  buyQty.value = { ...buyQty.value, [typeId]: clampQty(value, maxQty.value) };
}
const sellQuantity = (item: Item) => sellQty.value[item.id] ?? item.quantity;
function setSellQty(item: Item, value: number) {
  sellQty.value = { ...sellQty.value, [item.id]: clampQty(value, item.quantity) };
}

function displayName(typeId: string, fallback: string) {
  return itemName(typeId, fallback);
}

function setPoints(next: number) {
  points.value = next;
  if (auth.user) auth.setUser({ ...auth.user, points: next });
}

function errorText(e: any, fallback: string): string {
  const code = e?.response?.data?.code;
  if (code === 'INSUFFICIENT_POINTS') return t('shop.insufficient');
  if (code === 'ASSET_LOCKED') return t('shop.locked');
  return e?.response?.data?.message ?? fallback;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [shop, items] = await Promise.all([getShop(), getMyItems()]);
    entries.value = shop.items;
    maxQty.value = shop.maxQty;
    setPoints(shop.points);
    owned.value = items;
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? t('common.failed');
  } finally {
    loading.value = false;
  }
}

async function refreshOwned() {
  owned.value = await getMyItems();
}

async function buy(entry: ShopEntry) {
  const qty = buyQuantity(entry);
  busy.value = entry.typeId;
  message.value = '';
  error.value = '';
  try {
    const res = await buyItem(entry.typeId, qty);
    setPoints(res.points);
    message.value = t('shop.bought', { name: displayName(entry.typeId, entry.nameZh), qty });
    await refreshOwned();
  } catch (e: any) {
    error.value = errorText(e, t('shop.buyFailed'));
  } finally {
    busy.value = '';
  }
}

function askSell(item: Item) {
  selling.value = item;
}

const sellRefund = computed(() => {
  const item = selling.value;
  if (!item) return 0;
  return (sellPrices.value[item.typeId] ?? 0) * (sellQty.value[item.id] ?? item.quantity);
});

async function confirmSell() {
  const item = selling.value;
  if (!item) return;
  const qty = sellQty.value[item.id] ?? item.quantity;
  busy.value = item.id;
  message.value = '';
  error.value = '';
  try {
    const res = await sellItem(item.id, qty);
    setPoints(res.points);
    message.value = t('shop.sold', { name: displayName(item.typeId, res.nameZh), qty, refund: res.refund });
    await refreshOwned();
  } catch (e: any) {
    error.value = errorText(e, t('shop.sellFailed'));
  } finally {
    busy.value = '';
    selling.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="px-panel">
      <h2>{{ t('shop.title') }}</h2>

      <div class="row shop-bar">
        <span class="badge badge--blue">{{ t('shop.points', { points }) }}</span>
        <span class="spacer" />
        <PixelButton :variant="tab === 'buy' ? 'primary' : undefined" @click="tab = 'buy'">
          {{ t('shop.buyTab') }}
        </PixelButton>
        <PixelButton :variant="tab === 'sell' ? 'primary' : undefined" @click="tab = 'sell'">
          {{ t('shop.sellTab') }}
        </PixelButton>
      </div>

      <p class="shop-hint">{{ t('shop.hint') }}</p>
      <p v-if="message" class="shop-msg">{{ message }}</p>
      <p v-if="error" class="shop-error">{{ error }}</p>
      <p v-if="loading" class="blink">{{ t('common.loading') }}</p>

      <template v-else-if="tab === 'buy'">
        <p v-if="entries.length === 0" class="text-dim">{{ t('shop.empty') }}</p>
        <div class="shop-grid">
          <div
            v-for="entry in entries"
            :key="entry.typeId"
            class="shop-card"
            :class="{ 'shop-card--off': !entry.available }"
          >
            <div class="row" style="gap: 8px; flex-wrap: nowrap">
              <ItemIcon :type-id="entry.typeId" :size="30" />
              <div>
                <div style="font-size: var(--px-fs-sm)">
                  {{ displayName(entry.typeId, entry.nameZh) }}
                </div>
                
              </div>
            </div>

            <template v-if="entry.available">
              <div class="row shop-buy">
                <span class="badge badge--yellow">{{ t('shop.price', { price: entry.price ?? 0 }) }}</span>
                <input
                  class="px-input shop-qty"
                  type="number"
                  min="1"
                  :max="maxQty"
                  :value="buyQuantity(entry)"
                  :aria-label="t('shop.qty')"
                  @input="setBuyQty(entry.typeId, Number(($event.target as HTMLInputElement).value))"
                />
                <PixelButton :disabled="busy === entry.typeId" @click="buy(entry)">
                  {{ t('shop.buy') }}
                </PixelButton>
              </div>
              <div class="text-dim" style="font-size: var(--px-fs-sm)">
                {{ t('shop.total', { total: (entry.price ?? 0) * buyQuantity(entry) }) }} ·
                {{ t('shop.sellPrice', { price: entry.sellPrice ?? 0 }) }}
              </div>
            </template>
            <div v-else class="text-dim" style="font-size: var(--px-fs-sm)">{{ t('shop.notForSale') }}</div>
          </div>
        </div>
      </template>

      <template v-else>
        <p v-if="owned.length === 0" class="text-dim">{{ t('shop.sellEmpty') }}</p>
        <div class="shop-grid">
          <div v-for="item in sellable" :key="item.id" class="shop-card">
            <div class="row" style="gap: 8px; flex-wrap: nowrap">
              <ItemIcon :type-id="item.typeId" :size="30" />
              <div>
                <div style="font-size: var(--px-fs-sm)">{{ displayName(item.typeId, item.typeId) }} ×{{ item.quantity }}</div>
                <div class="mono text-dim">{{ item.id.slice(0, 18) }}…</div>
              </div>
            </div>
            <div class="row shop-buy">
              <span class="badge badge--yellow">
                {{ t('shop.sellPrice', { price: sellPrices[item.typeId] ?? 0 }) }}
              </span>
              <input
                class="px-input shop-qty"
                type="number"
                min="1"
                :max="item.quantity"
                :value="sellQuantity(item)"
                :aria-label="t('shop.qty')"
                @input="setSellQty(item, Number(($event.target as HTMLInputElement).value))"
              />
              <PixelButton :disabled="busy === item.id" @click="askSell(item)">
                {{ t('shop.sell') }}
              </PixelButton>
            </div>
          </div>

          <div v-for="item in locked" :key="item.id" class="shop-card shop-card--off">
            <div class="row" style="gap: 8px; flex-wrap: nowrap">
              <ItemIcon :type-id="item.typeId" :size="30" />
              <div>
                <div style="font-size: var(--px-fs-sm)">{{ displayName(item.typeId, item.typeId) }} ×{{ item.quantity }}</div>
                <div class="text-dim" style="font-size: var(--px-fs-sm)">
                  {{ item.status !== 'IDLE' ? t('shop.locked') : t('shop.notForSale') }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <PixelDialog
      v-if="selling"
      :title="t('shop.sellTitle', { name: displayName(selling.typeId, selling.typeId) })"
      :confirm-text="t('shop.sell')"
      @confirm="confirmSell"
      @cancel="selling = null"
    >
      <p>
        {{
          t('shop.sellAsk', {
            name: displayName(selling.typeId, selling.typeId),
            qty: sellQty[selling.id] ?? selling.quantity,
            refund: sellRefund,
          })
        }}
      </p>
    </PixelDialog>
  </div>
</template>

<style scoped>
.shop-bar {
  align-items: center;
  margin-bottom: 8px;
}

.shop-hint,
.shop-msg,
.shop-error {
  font-size: var(--px-fs-sm);
  line-height: var(--px-lh-body);
  margin: 0 0 8px;
}

.shop-hint {
  color: var(--gba-brown-dark);
}

.shop-msg {
  color: var(--gba-blue);
}

.shop-error {
  color: var(--gba-red);
}

.shop-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.shop-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  background: var(--px-surface);
  border: 2px solid var(--px-line);
  box-shadow: inset 2px 2px 0 var(--px-highlight);
}

.shop-card--off {
  opacity: 0.6;
}

.shop-card > .row:first-child { min-height: 44px; }

.shop-buy {
  align-items: center;
  gap: 8px;
}

.shop-qty {
  width: 80px;
  margin-left: auto;
  font-size: var(--px-fs-sm);
}

@media (max-width: 720px) {
  .shop-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
