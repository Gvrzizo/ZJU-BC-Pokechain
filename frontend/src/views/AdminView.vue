<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { listDisputes, mintItem } from '@/api/admin';
import { arbitrateBattle, getBattle } from '@/api/battles';
import { useAuthStore } from '@/stores/auth';
import type { BattleDetail, DisputeEntry } from '@/types';
import PixelButton from '@/ui/PixelButton.vue';

const auth = useAuthStore();

// ---- mint 道具 ----
const mintForm = ref({ playerId: '', typeId: 'poke-ball', quantity: 1, uri: '' });
const mintMsg = ref('');

async function doMint() {
  mintMsg.value = '';
  try {
    const item = await mintItem({
      playerId: mintForm.value.playerId,
      typeId: mintForm.value.typeId,
      quantity: mintForm.value.quantity,
      uri: mintForm.value.uri || undefined,
    });
    mintMsg.value = `已铸造 ${item.typeId} ×${item.quantity} → ${item.id}`;
  } catch (e: any) {
    mintMsg.value = e?.response?.data?.message ?? '铸造失败';
  }
}

// ---- 争议仲裁 ----
const disputes = ref<DisputeEntry[]>([]);
const disputesMsg = ref('');
const arbBattle = ref<BattleDetail | null>(null);
const arbOutcome = ref('DRAW');
const arbNote = ref('');
const arbMsg = ref('');

async function refreshDisputes() {
  disputesMsg.value = '';
  try {
    disputes.value = await listDisputes('disputed');
  } catch (e: any) {
    disputesMsg.value = e?.response?.data?.message ?? '争议列表加载失败';
  }
}

async function loadDispute(battleId: string) {
  arbMsg.value = '';
  try {
    const res = await getBattle(battleId);
    arbBattle.value = res.battle;
  } catch (e: any) {
    arbMsg.value = e?.response?.data?.message ?? '查询失败';
  }
}

async function doArbitrate() {
  if (!arbBattle.value) return;
  try {
    await arbitrateBattle(arbBattle.value.id, arbOutcome.value, arbNote.value);
    arbMsg.value = `已仲裁：${arbOutcome.value}（链上 Arbitrate 已提交）`;
    arbBattle.value = null;
    await refreshDisputes();
  } catch (e: any) {
    arbMsg.value = e?.response?.data?.message ?? '仲裁失败';
  }
}

onMounted(() => {
  if (!auth.isAdmin && !auth.isArbitrator) {
    mintMsg.value = '需要 admin / arbitrator 角色';
    return;
  }
  if (auth.isArbitrator) refreshDisputes();
});
</script>

<template>
  <div class="page">
    <!-- admin：mint 道具 -->
    <div v-if="auth.isAdmin" class="px-panel mb-16">
      <h2>Mint 道具（admin）</h2>
      <div class="grid mt-8" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr))">
        <div class="px-field">
          <label>目标玩家 ID</label>
          <input v-model="mintForm.playerId" class="px-input" placeholder="u_xxx / 用户名" />
        </div>
        <div class="px-field">
          <label>道具类型 typeId</label>
          <input v-model="mintForm.typeId" class="px-input" placeholder="poke-ball" />
        </div>
        <div class="px-field">
          <label>数量</label>
          <input v-model.number="mintForm.quantity" class="px-input" type="number" min="1" />
        </div>
        <div class="px-field">
          <label>资源 URI（可选）</label>
          <input v-model="mintForm.uri" class="px-input" placeholder="minio://…" />
        </div>
      </div>
      <PixelButton variant="primary" :disabled="!mintForm.playerId" @click="doMint">
        Mint（链上 MintItem）
      </PixelButton>
      <p v-if="mintMsg" class="mt-8" style="font-size: var(--px-fs-sm)">{{ mintMsg }}</p>
    </div>

    <!-- arbitrator：争议列表 + 仲裁 -->
    <div v-if="auth.isArbitrator" class="px-panel">
      <div class="row" style="justify-content: space-between">
        <h2 style="margin: 0">争议仲裁（arbitrator）</h2>
        <PixelButton @click="refreshDisputes">刷新列表</PixelButton>
      </div>
      <p style="font-size: var(--px-fs-sm)">GET /battles?status=disputed —— 点击一案查看链上详情并裁决。</p>
      <p v-if="disputesMsg" class="mt-8" style="font-size: var(--px-fs-sm); color: var(--gba-red)">
        {{ disputesMsg }}
      </p>

      <div class="mt-8" style="font-size: var(--px-fs-sm)">
        <div
          v-for="d in disputes"
          :key="d.id"
          class="row"
          style="justify-content: space-between; border-bottom: 1px dashed var(--gba-ink); padding: 6px 0"
        >
          <span>
            <span class="badge badge--red">{{ d.status }}</span>
            {{ d.playerA }} vs {{ d.playerB }}
            <span class="text-dim" style="font-size: var(--px-fs-sm)">　{{ d.disputeReason }}</span>
          </span>
          <PixelButton variant="blue" @click="loadDispute(d.id)">处理</PixelButton>
        </div>
        <p v-if="disputes.length === 0" class="text-dim" style="font-size: var(--px-fs-sm)">
          暂无待仲裁的争议对局。
        </p>
      </div>

      <div v-if="arbBattle" class="mt-16">
        <p style="font-size: var(--px-fs-sm)">
          对局 {{ arbBattle.id }}　状态：<span class="badge badge--red">{{ arbBattle.status }}</span>
        </p>
        <p class="mt-8" style="font-size: var(--px-fs-sm)">
          双方：{{ arbBattle.playerA }} vs {{ arbBattle.playerB }}
        </p>
        <p class="mt-8" style="font-size: var(--px-fs-sm)">争议原因：{{ arbBattle.disputeReason || '—' }}</p>
        <div class="px-field mt-8">
          <label>裁决结果</label>
          <select v-model="arbOutcome" class="px-select">
            <option value="DRAW">DRAW（各自取回）</option>
            <option value="REFUND">REFUND（全额退款）</option>
            <option :value="arbBattle.playerA">{{ arbBattle.playerA }} 胜</option>
            <option :value="arbBattle.playerB">{{ arbBattle.playerB }} 胜</option>
          </select>
        </div>
        <div class="px-field">
          <label>仲裁备注</label>
          <textarea v-model="arbNote" class="px-textarea" rows="2" />
        </div>
        <PixelButton variant="danger" @click="doArbitrate">提交仲裁（链上 Arbitrate）</PixelButton>
      </div>
      <p v-if="arbMsg" class="mt-8" style="font-size: var(--px-fs-sm)">{{ arbMsg }}</p>
    </div>
  </div>
</template>
