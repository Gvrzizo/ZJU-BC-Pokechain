<script setup lang="ts">
import { computed, ref } from 'vue';
import { getFairness } from '@/api/fairness';
import { buildFairnessChecks, type FairnessCheck } from '@/utils/fairness-checks';
import type { FairnessResponse } from '@/types';
import PixelButton from '@/ui/PixelButton.vue';

const eventId = ref('');
const record = ref<FairnessResponse | null>(null);
const error = ref('');
const loading = ref(false);

// 前端复算/验签项（承诺-揭示 + 战斗回放 + serverSig）
const checks = ref<FairnessCheck[]>([]);

const battleChecks = computed(() =>
  checks.value.filter(
    (c) =>
      c.label.startsWith('sha256(canonical(回合日志))') ||
      c.label.startsWith('无回放日志') ||
      c.label.startsWith('serverSig 验签'),
  ),
);
const battleFailed = computed(() => battleChecks.value.some((c) => !c.pass));
/** battle_logs 里记录的签名密钥与当前服务端公钥不一致：提示可能是换钥后的旧签名 */
const keyMismatch = computed(() => {
  const battle = record.value?.battle;
  const current = record.value?.serverKeyId;
  return !!battle?.serverKeyId && !!current && battle.serverKeyId !== current;
});

async function verify() {
  error.value = '';
  record.value = null;
  checks.value = [];
  loading.value = true;
  try {
    const r = await getFairness(eventId.value.trim());
    record.value = r;
    const results = await buildFairnessChecks(r);

    // 打勾动画：逐条显示
    for (const c of results) {
      checks.value.push(c);
      await new Promise((res) => setTimeout(res, 250));
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
        <strong>serverSeed 在结算后揭示</strong>：尚未结算的 COMMITTED 事件只展示承诺，无法预测后续判定。
        战斗事件（ev_battle_&lt;battleId&gt;）还会返回回放日志，前端复算
        <code>sha256(canonical(turnLog))</code> 并用 secp256k1 验证服务端签名。
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
        <p>serverSeed: <span class="mono">{{ record.event.serverSeed || '（结算后揭示）' }}</span></p>
        <p v-if="record.serverKeyId" class="mt-8">签名公钥指纹: <span class="mono">{{ record.serverKeyId }}</span></p>
        <p>clientSeed: <span class="mono">{{ record.event.clientSeed }}</span></p>
        <p>resultHash: <span class="mono">{{ record.event.resultHash || '—' }}</span></p>
        <p v-if="record.event.meta">meta: <span class="mono">{{ record.event.meta }}</span></p>
      </div>

      <section v-if="record.battle" class="battle-audit mt-16" :class="{ 'battle-audit--fail': battleFailed }">
        <h3 style="font-size: var(--px-fs-sm)">战斗审计（battle_logs + 链上结果）</h3>
        <div class="mt-8" style="font-size: var(--px-fs-sm)">
          <p>battleId: <span class="mono">{{ record.battle.battleId }}</span></p>
          <p>winnerId: <span class="mono">{{ record.battle.winnerId || '—' }}</span></p>
          <p>resultHash: <span class="mono">{{ record.battle.resultHash || '—' }}</span></p>
          <p>serverSig: <span class="mono">{{ record.battle.serverSig || '—' }}</span></p>
          <p>
            serverKeyId: <span class="mono">{{ record.battle.serverKeyId || '—' }}</span>
            <span v-if="keyMismatch" class="battle-warn">
              （与当前服务端公钥 {{ record.serverKeyId }} 不一致：可能已换钥）
            </span>
          </p>
          <p>
            回放日志:
            <span v-if="record.battle.turnLog !== null" class="mono">
              {{ record.battle.turnLog.length }} 条回合
            </span>
            <span v-else>无回放日志，仅展示链上签名</span>
          </p>
        </div>
        <p v-if="battleFailed" class="battle-status battle-status--fail">
          ✘ 战斗结果复核未通过：请对照下方逐项结果（回放日志缺失或签名/哈希不一致）。
        </p>
        <p v-else class="battle-status battle-status--pass">
          ✔ 战斗结果复核通过：回放复算与 serverSig 验签均一致。
        </p>
      </section>

      <h3 class="mt-16" style="font-size: var(--px-fs-sm)">前端重算结果</h3>
      <div class="mt-8" style="font-size: var(--px-fs-sm)">
        <div v-for="c in checks" :key="c.label" class="check-row">
          <p>
            <span v-if="c.pass" class="check-pop">✔</span>
            <span v-else style="color: var(--gba-red)">✘</span>
            {{ c.label }}
          </p>
          <p v-if="c.detail" class="check-detail mono">{{ c.detail }}</p>
        </div>
      </div>
      <h3 class="mt-16" style="font-size: var(--px-fs-sm)">派生算法（服务端公示）</h3>
      <div class="mt-8 mono">
        <p v-for="(v, k) in record.derivation" :key="k">{{ k }}: {{ v }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.battle-audit {
  padding: 12px 16px;
  border: 2px solid var(--px-line);
  border-left: 4px solid var(--gba-green);
  background: var(--px-surface);
}
.battle-audit--fail {
  border-left-color: var(--gba-red);
  background: #f7e7e2;
}
.battle-warn {
  color: var(--gba-red);
  font-size: var(--px-fs-sm);
}
.battle-status {
  margin: 12px 0 0;
  font-size: var(--px-fs-sm);
}
.battle-status--pass { color: var(--gba-green); }
.battle-status--fail { color: var(--gba-red); }
.check-row { margin-bottom: 8px; }
.check-row p { margin: 0; }
.check-detail { color: var(--px-muted); }
</style>
