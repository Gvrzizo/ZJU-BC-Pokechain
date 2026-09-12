<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { getRoomDetail } from '@/api/battles';
import { useI18n } from '@/composables/useI18n';
import { statsLine } from '@/components/wager-detail';
import type { BattleRoomDetail, WagerPokemonDetail } from '@/types';
import BondHearts from '@/ui/BondHearts.vue';
import PixelDialog from '@/ui/PixelDialog.vue';
import SpriteIcon from '@/ui/SpriteIcon.vue';

/**
 * 查看队伍：按房间 id 拉 `GET /battles/rooms/:id` 的队伍富化明细（teamDetailA/B），
 * 双方各一栏展示出战宝可梦（昵称/等级/闪光/羁绊/能力值）。**所有人可看**（含旁观者），
 * 大厅房间卡片、加入/确认押注面板共用。
 */
const props = defineProps<{ roomId: string; title?: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { monName } = useI18n();
const detail = ref<BattleRoomDetail | null>(null);
const loading = ref(true);
const error = ref('');

const columns = computed(() => {
  const d = detail.value;
  if (!d) return [];
  return [
    { side: 'A', label: '房主', player: d.playerA as string | null, team: d.teamDetailA ?? [] },
    { side: 'B', label: '挑战者', player: d.playerB, team: d.teamDetailB ?? [] },
  ];
});

/** 展示名：昵称（链上 name）优先，其次按当前语言显示种族名 */
function monLabel(mon: WagerPokemonDetail): string {
  if (mon.speciesId === null) return mon.name ?? mon.id;
  return monName(mon.speciesId, mon.name ?? undefined);
}

onMounted(async () => {
  try {
    detail.value = await getRoomDetail(props.roomId);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    error.value = err?.response?.data?.message ?? '出战队伍加载失败';
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <PixelDialog
    :title="title ?? '查看队伍'"
    :show-cancel="false"
    confirm-text="关闭"
    @confirm="emit('close')"
  >
    <p v-if="loading" class="text-dim">加载出战队伍…</p>
    <p v-else-if="error" style="color: var(--gba-red)">{{ error }}</p>
    <template v-else-if="detail">
      <div class="team-cols">
        <section v-for="col in columns" :key="col.side" class="team-col">
          <h3 class="team-col__title">
            {{ col.label }}：{{ col.player ?? '（未加入）' }}
            <span v-if="col.team.length" class="text-dim">（{{ col.team.length }} 只）</span>
          </h3>
          <template v-if="col.team.length">
            <div v-for="mon in col.team" :key="mon.id" class="team-mon">
              <SpriteIcon :species-id="mon.speciesId ?? 0" :size="40" />
              <div>
                <p style="font-size: var(--px-fs-sm)">
                  {{ monLabel(mon) }}
                  <span v-if="mon.level !== null" class="text-dim">Lv{{ mon.level }}</span>
                  <span v-if="mon.shiny" style="color: var(--gba-yellow)">★闪光</span>
                </p>
                <p v-if="mon.unavailable" style="font-size: var(--px-fs-sm); color: var(--gba-red)">
                  链上已不可读（已易主 / 被清理）
                </p>
                <p v-else class="row" style="font-size: var(--px-fs-sm); gap: 6px">
                  <BondHearts v-if="mon.bond !== null" :bond="mon.bond" size="sm" />
                  <span v-if="mon.stats" class="text-dim mono">{{ statsLine(mon.stats) }}</span>
                </p>
              </div>
            </div>
          </template>
          <p v-else class="text-dim" style="font-size: var(--px-fs-sm)">
            {{ col.player ? '尚未提交出战队伍' : '尚未加入房间' }}
          </p>
        </section>
      </div>
      <p class="mt-8 text-dim" style="font-size: var(--px-fs-sm)">
        出战队伍在加入房间时提交，战斗开始前都能看到；押注清单请用"查看押注"。
      </p>
    </template>
  </PixelDialog>
</template>

<style scoped>
.team-cols {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.team-col {
  flex: 1;
  min-width: 0;
  border: 2px solid var(--gba-ink);
  padding: 6px;
  background: rgba(255, 255, 255, 0.35);
}

.team-col__title {
  margin: 0 0 6px;
  font-size: var(--px-fs-sm);
}

.team-mon {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.team-mon p {
  margin: 0;
}
</style>
