<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { blockPlayer, listBlockedPlayers, unblockPlayer } from '@/api/battles';
import { blockRemainingText } from '@/components/wager-inventory';
import type { BlockedPlayer } from '@/types';
import PixelDialog from '@/ui/PixelDialog.vue';

/**
 * 屏蔽名单管理（小界面）：列出自己仍在有效期内的屏蔽（默认 30 分钟），
 * 可手动输入玩家名补充屏蔽或解除。被屏蔽者加入我创建的房间会 403 BLOCKED_BY_HOST。
 */
const emit = defineEmits<{ (e: 'close'): void }>();

const blocked = ref<BlockedPlayer[]>([]);
const target = ref('');
const message = ref('');
const busy = ref(false);

async function load() {
  try {
    blocked.value = await listBlockedPlayers();
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    message.value = err?.response?.data?.message ?? '屏蔽名单加载失败';
  }
}

onMounted(load);

async function add() {
  const playerId = target.value.trim();
  if (!playerId || busy.value) return;
  busy.value = true;
  try {
    await blockPlayer(playerId);
    target.value = '';
    message.value = `已屏蔽 ${playerId}（30 分钟内无法加入你创建的房间）`;
    await load();
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    message.value = err?.response?.data?.message ?? '屏蔽失败';
  } finally {
    busy.value = false;
  }
}

async function remove(playerId: string) {
  if (busy.value) return;
  busy.value = true;
  try {
    await unblockPlayer(playerId);
    message.value = `已解除对 ${playerId} 的屏蔽`;
    await load();
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    message.value = err?.response?.data?.message ?? '解除屏蔽失败';
  } finally {
    busy.value = false;
  }
}

/** 剩余时长（不足 1 分钟按 1 分钟显示） */
const remainingText = blockRemainingText;
</script>

<template>
  <PixelDialog title="屏蔽名单（30 分钟）" :show-cancel="false" confirm-text="关闭" @confirm="emit('close')">
    <p class="text-dim" style="font-size: var(--px-fs-sm)">
      被屏蔽的玩家在有效期内无法加入你创建的任何对战房间；到期自动失效。
    </p>
    <div class="row mt-8">
      <input
        v-model="target"
        class="px-input"
        placeholder="玩家名"
        maxlength="64"
        @keyup.enter="add"
      />
      <button class="px-btn" type="button" :disabled="busy || !target.trim()" @click="add">屏蔽</button>
    </div>
    <p v-if="message" class="mt-8" style="font-size: var(--px-fs-sm); color: var(--gba-blue)">{{ message }}</p>

    <div class="mt-8" style="font-size: var(--px-fs-sm)">
      <p v-if="blocked.length === 0" class="text-dim">名单为空</p>
      <div v-for="b in blocked" :key="b.playerId" class="blocked-row">
        <span>{{ b.playerId }}</span>
        <span class="text-dim">{{ remainingText(b.remainingMs) }}</span>
        <button class="px-btn" type="button" :disabled="busy" @click="remove(b.playerId)">解除</button>
      </div>
    </div>
  </PixelDialog>
</template>

<style scoped>
.blocked-row {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
  border-bottom: 1px dashed var(--gba-ink);
  padding: 4px 0;
}
</style>
