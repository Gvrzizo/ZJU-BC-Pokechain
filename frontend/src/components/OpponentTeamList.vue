<script setup lang="ts">
import { statsLine } from '@/components/wager-detail';
import { useI18n } from '@/composables/useI18n';
import type { RankedOpponentPokemon } from '@/types';
import SpriteIcon from '@/ui/SpriteIcon.vue';

/**
 * 排位接受期的对手阵容预览（docs/backend-api.md §11.1）：服务端只给公开信息——
 * 昵称/种族/等级/闪光/最终能力值（不含 IV/EV/性格/羁绊），这里原样展示。
 */
defineProps<{
  team: RankedOpponentPokemon[];
  title: string;
  hint?: string;
}>();

const { monName } = useI18n();
</script>

<template>
  <div>
    <p style="font-size: var(--px-fs-sm); margin: 0 0 4px">{{ title }}</p>
    <div class="opponent-team">
      <div v-for="mon in team" :key="mon.id" class="opponent-mon">
        <SpriteIcon :species-id="mon.speciesId ?? 0" :size="24" />
        <span>{{ monName(mon.speciesId ?? 0, mon.name ?? undefined) }}</span>
        <span class="text-dim">Lv{{ mon.level ?? '?' }}</span>
        <span v-if="mon.shiny" style="color: var(--gba-yellow)">★</span>
        <span v-if="mon.stats" class="text-dim mono">{{ statsLine(mon.stats) }}</span>
      </div>
    </div>
    <p v-if="hint" class="text-dim" style="font-size: var(--px-fs-sm)">{{ hint }}</p>
  </div>
</template>

<style scoped>
.opponent-team {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 2px solid var(--gba-ink);
  background: rgba(255, 255, 255, 0.35);
  padding: 4px;
}

.opponent-mon {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--px-fs-sm);
}
</style>
