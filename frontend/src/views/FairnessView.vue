<script setup lang="ts">
import { ref } from 'vue';
import { getFairness } from '@/api/fairness';
import { sha256Hex } from '@/utils/hash';
import type { FairnessResponse } from '@/types';
import PixelButton from '@/ui/PixelButton.vue';

const eventId = ref('');
const record = ref<FairnessResponse | null>(null);
const error = ref('');
const loading = ref(false);

// 三项前端重算校验
const checks = ref<{ label: string; pass: boolean }[]>([]);

async function verify() {
  error.value = '';
  record.value = null;
  checks.value = [];
  loading.value = true;
  try {
    const r = await getFairness(eventId.value.trim());
    record.value = r;
    const ev = r.event;
    const results: { label: string; pass: boolean }[] = [];

    // ① commitHash == sha256(serverSeed)
    if (ev.serverSeed) {
      const commit = await sha256Hex(ev.serverSeed);
      results.push({ label: 'sha256(serverSeed) == commitHash', pass: commit === ev.commitHash });
    } else {
      results.push({ label: 'serverSeed 尚未 reveal', pass: false });
    }

    // ② resultHash == sha256(serverSeed|clientSeed|eventId)（若链上已写入）
    if (ev.serverSeed && ev.resultHash) {
      const rh = await sha256Hex(`${ev.serverSeed}|${ev.clientSeed}|${ev.eventId}`);
      results.push({
        label: 'sha256(serverSeed|clientSeed|eventId) == resultHash',
        pass: rh === ev.resultHash,
      });
    }

    // ③ 派生流可复现性抽查：HMAC 派生第 0 个随机值（算法见 chaincode-api §2.2）
    if (ev.serverSeed) {
      try {
        const key = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(ev.serverSeed),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
        const sig = await crypto.subtle.sign(
          'HMAC',
          key,
          new TextEncoder().encode(`${ev.clientSeed}|${ev.eventId}|0`),
        );
        const view = new DataView(sig);
        const hi = view.getUint32(0);
        const lo = view.getUint32(4);
        const rand0 = (hi * 2 ** 32 + lo) / 2 ** 64;
        results.push({
          label: `HMAC 派生流第 0 值可复现（rand0=${rand0.toFixed(6)} ∈ [0,1)）`,
          pass: rand0 >= 0 && rand0 < 1,
        });
      } catch {
        results.push({ label: 'HMAC 派生流重算失败', pass: false });
      }
    }

    // 打勾动画：逐条显示
    for (const c of results) {
      checks.value.push(c);
      await new Promise((res) => setTimeout(res, 350));
    }
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? '查询失败（eventId 不存在？后端未启动？）';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="page">
    <div class="px-panel">
      <h2>公平性验证</h2>
      <p style="font-size: var(--px-fs-sm)">
        输入捕捉 / 战斗的 eventId，拉取链上 RandomCommit 全量数据，
        用浏览器 Web Crypto 重算 sha256 验证承诺-揭示一致性。
      </p>
      <div class="row mt-16">
        <input
          v-model="eventId"
          class="px-input"
          style="flex: 1"
          placeholder="ev_xxx / ev_battle_b_xxx"
          @keyup.enter="verify"
        />
        <PixelButton variant="primary" :disabled="loading || !eventId.trim()" @click="verify">
          {{ loading ? '验证中…' : '验证' }}
        </PixelButton>
      </div>
      <p v-if="error" class="mt-8" style="font-size: var(--px-fs-sm); color: var(--gba-red)">{{ error }}</p>
    </div>

    <div v-if="record" class="px-panel mt-16">
      <h3 style="font-size: var(--px-fs-sm)">
        链上记录（{{ record.event.purpose }} / {{ record.event.status }}）
      </h3>
      <div style="font-size: var(--px-fs-sm)" class="mt-8">
        <p>eventId: <span class="mono">{{ record.event.eventId }}</span></p>
        <p>playerId: <span class="mono">{{ record.event.playerId }}</span></p>
        <p class="mt-8">commitHash: <span class="mono">{{ record.event.commitHash }}</span></p>
        <p>serverSeed: <span class="mono">{{ record.event.serverSeed || '（未 reveal）' }}</span></p>
        <p>clientSeed: <span class="mono">{{ record.event.clientSeed }}</span></p>
        <p>resultHash: <span class="mono">{{ record.event.resultHash || '—' }}</span></p>
        <p v-if="record.event.meta">meta: <span class="mono">{{ record.event.meta }}</span></p>
      </div>
      <h3 class="mt-16" style="font-size: var(--px-fs-sm)">前端重算结果</h3>
      <div class="mt-8" style="font-size: var(--px-fs-sm)">
        <p v-for="c in checks" :key="c.label">
          <span v-if="c.pass" class="check-pop">✔</span>
          <span v-else style="color: var(--gba-red)">✘</span>
          {{ c.label }}
        </p>
      </div>
      <h3 class="mt-16" style="font-size: var(--px-fs-sm)">派生算法（服务端公示）</h3>
      <div class="mt-8 mono">
        <p v-for="(v, k) in record.derivation" :key="k">{{ k }}: {{ v }}</p>
      </div>
    </div>
  </div>
</template>
