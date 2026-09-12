<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { getRoomDetail } from '@/api/battles';
import type { BattleRoomDetail, WagerDetail } from '@/types';
import { statsLine, wagerMonLabel } from '@/components/wager-detail';
import ItemIcon from '@/ui/ItemIcon.vue';
import PixelDialog from '@/ui/PixelDialog.vue';
import SpriteIcon from '@/ui/SpriteIcon.vue';

/**
 * 查看押注：按房间 id 拉富化明细（GET /battles/rooms/:id），双方各一栏展示
 * 宝可梦（sprite + 等级/闪光/羁绊/能力值）与道具（图标 + 中英文名 + 数量）。
 * 大厅房间卡片、加入/确认押注面板、战斗结算面板共用。
 */
const props = defineProps<{ roomId: string; title?: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const detail = ref<BattleRoomDetail | null>(null);
const loading = ref(true);
const error = ref('');

const columns = computed(() => {
  const d = detail.value;
  if (!d) return [];
  return [
    { side: 'A', label: '房主', player: d.playerA, wager: d.wagerDetailA as WagerDetail | null },
    { side: 'B', label: '挑战者', player: d.playerB, wager: d.wagerDetailB },
  ];
});

onMounted(async () => {
  try {
    detail.value = await getRoomDetail(props.roomId);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    error.value = err?.response?.data?.message ?? '押注明细加载失败';
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <PixelDialog
    :title="title ?? '查看押注'"
    :show-cancel="false"
    confirm-text="关闭"
    @confirm="emit('close')"
  >
    <p v-if="loading" class="text-dim">加载押注明细…</p>
    <p v-else-if="error" style="color: var(--gba-red)">{{ error }}</p>
    <template v-else-if="detail">
      <div class="wager-cols">
        <section v-for="col in columns" :key="col.side" class="wager-col">
          <h3 class="wager-col__title">
            {{ col.label }}：{{ col.player ?? '（未加入）' }}
          </h3>
          <template v-if="col.wager">
            <p style="font-size: var(--px-fs-sm)">
              <strong>押注积分：</strong>{{ col.wager.points }}P
              <span class="text-dim">
                （宝可梦×{{ col.wager.totals.pokemon }}、道具×{{ col.wager.totals.itemQty }}）
              </span>
            </p>
            <p v-if="!col.wager.pokemon.length && !col.wager.items.length && !col.wager.points" class="text-dim">
              未押注资产
            </p>
            <div v-for="mon in col.wager.pokemon" :key="mon.id" class="wager-asset">
              <SpriteIcon :species-id="mon.speciesId ?? 0" :size="48" />
              <div>
                <p style="font-size: var(--px-fs-sm)">
                  {{ wagerMonLabel(mon) }}
                  <span v-if="mon.level !== null">Lv{{ mon.level }}</span>
                  <span v-if="mon.shiny" style="color: var(--gba-yellow)">★闪光</span>
                  <span v-if="mon.bond !== null" class="text-dim">羁绊{{ mon.bond }}</span>
                </p>
                <p v-if="mon.unavailable" style="font-size: var(--px-fs-sm); color: var(--gba-red)">
                  链上已不可读（已消耗 / 已易主）
                </p>
                <p v-else-if="mon.stats" class="text-dim mono">
                  {{ statsLine(mon.stats) }}
                </p>
              </div>
            </div>
            <div v-for="it in col.wager.items" :key="it.id" class="wager-asset">
              <ItemIcon :type-id="it.typeId" :size="24" />
              <p style="font-size: var(--px-fs-sm)">
                {{ it.nameZh }} <span class="text-dim">{{ it.name }}</span> ×{{ it.qty }}
                <span v-if="it.unavailable" style="color: var(--gba-red)">（链上已不可读）</span>
                <span v-else class="text-dim">（持有 {{ it.held }}）</span>
              </p>
            </div>
          </template>
          <p v-else class="text-dim">尚未加入房间</p>
        </section>
      </div>
      <p v-if="detail.name || detail.note" class="mt-8" style="font-size: var(--px-fs-sm)">
        <span v-if="detail.name">房名：{{ detail.name }}</span>
        <span v-if="detail.note" class="text-dim">　备注：{{ detail.note }}</span>
      </p>
      <p v-if="detail.joinMessage" style="font-size: var(--px-fs-sm)">对手留言：{{ detail.joinMessage }}</p>
    </template>
  </PixelDialog>
</template>

<style scoped>
.wager-cols {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.wager-col {
  flex: 1;
  min-width: 0;
  border: 2px solid var(--gba-ink);
  padding: 6px;
  background: rgba(255, 255, 255, 0.35);
}

.wager-col__title {
  margin: 0 0 6px;
  font-size: var(--px-fs-sm);
}

.wager-asset {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.wager-asset p {
  margin: 0;
}
</style>
