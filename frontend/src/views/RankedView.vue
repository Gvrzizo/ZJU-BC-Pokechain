<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  ARENA_ENTRY_FEES,
  RANK_TIERS,
  acceptRankedBot,
  acceptRankedMatch,
  arenaEntryFor,
  cancelRankedQueue,
  declineRankedMatch,
  enqueueRanked,
  getRankedLeaderboard,
  getRankedMe,
  nextTier,
  rankedQueueStatus,
  tierOf,
  tierProgress,
} from '@/api/ranked';
import { useI18n } from '@/composables/useI18n';
import { usePokemonStore } from '@/stores/pokemon';
import { toggleTeamMember } from '@/components/team-picker';
import OpponentTeamList from '@/components/OpponentTeamList.vue';
import { isFainted } from '@/utils/pokemon-hp';
import type { Pokemon, RankedEntry, RankedLeaderboard, RankedQueueMode, RankedQueueStatus } from '@/types';
import PixelButton from '@/ui/PixelButton.vue';
import PixelDialog from '@/ui/PixelDialog.vue';
import BondHearts from '@/ui/BondHearts.vue';
import SpriteIcon from '@/ui/SpriteIcon.vue';

const router = useRouter();
const store = usePokemonStore();
const { t, monName } = useI18n();

const me = ref<RankedEntry | null>(null);
const board = ref<RankedLeaderboard | null>(null);
const queue = ref<RankedQueueStatus | null>(null);
const teamIds = ref<string[]>([]);
const mode = ref<RankedQueueMode>('casual');
const message = ref('');
const error = ref('');
const helpOpen = ref(false);
/** 已等待毫秒：服务端 waitedMs 播种，本地 500ms 时钟推进（轮询每 2s 校准一次） */
const waitedMs = ref(0);
/** 接受期倒计时用的"当前时间"（同一个 500ms 时钟推进） */
const now = ref(Date.now());
let pollTimer: ReturnType<typeof setInterval> | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;
let leaving = false;

const myTeam = computed(() => store.myPokemon);
const rating = computed(() => me.value?.rating ?? 1000);
const tier = computed(() => tierOf(rating.value));
const progress = computed(() => tierProgress(rating.value));
const next = computed(() => nextTier(rating.value));
const queued = computed(() => queue.value?.state === 'QUEUED');
const pending = computed(() => (queue.value?.state === 'MATCH_PENDING' ? queue.value : null));
const waitedSec = computed(() => Math.floor(waitedMs.value / 1000));
const matched = computed(() =>
  queue.value?.state === 'MATCHED' && queue.value.battleId ? queue.value : null,
);
/** 当前匹配窗口（服务端给值，本地按等待时间推演到下一档） */
const window = computed(() => queue.value?.window ?? 200);
/** 我的积分场准入额（按段位） */
const myEntryFee = computed(() => arenaEntryFor(rating.value));
const acceptLeftSec = computed(() =>
  pending.value?.acceptDeadline ? Math.max(0, Math.ceil((pending.value.acceptDeadline - now.value) / 1000)) : 0,
);

function bondOf(p: Pokemon): number {
  return p.bond ?? 50; // 旧链上记录缺字段时按铸造默认值 50（chaincode-api.md §1）
}

/** 濒死（0 HP）的宝可梦不能入队/出战：灰显禁选 + 提示（伤势持久化，docs/backend-api.md §2） */
const myTeamFainted = computed(() => myTeam.value.filter((p) => p.status === 'IDLE' && isFainted(p)));
/** 已勾选但处于濒死的数量（如入队前刚在别的战斗里倒下） */
const pickedFainted = computed(() => myTeamFainted.value.filter((p) => teamIds.value.includes(p.id)));

function toggle(id: string) {
  if (queued.value || pending.value) return;
  const picked = myTeam.value.find((p) => p.id === id);
  if (picked && isFainted(picked)) {
    error.value = t('ranked.faintedHint');
    return;
  }
  // 出战队伍最多 6 只（与服务端 1-6 校验同一口径，见 components/team-picker.ts）
  const { team, rejected } = toggleTeamMember(teamIds.value, id);
  if (rejected) {
    error.value = t('ranked.teamMax');
    return;
  }
  error.value = '';
  teamIds.value = team;
}

function setMode(next: RankedQueueMode) {
  if (queued.value || pending.value) return;
  mode.value = next;
  error.value = '';
}

async function load() {
  error.value = '';
  try {
    const [entry, boardData] = await Promise.all([getRankedMe(), getRankedLeaderboard()]);
    me.value = entry;
    board.value = boardData;
  } catch (e: unknown) {
    error.value = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t('ranked.loadFail');
  }
}

/** 排队状态落库：MATCHED 直接进战斗，MATCH_PENDING 等接受，TIMEOUT/ERROR 给提示后停止轮询 */
function applyStatus(status: RankedQueueStatus) {
  queue.value = status;
  if (status.state === 'QUEUED') waitedMs.value = status.waitedMs ?? 0;
  if (status.message) message.value = status.message;
  if (status.state === 'MATCH_PENDING') {
    startPolling();
    return;
  }
  if (status.state === 'MATCHED' && status.battleId) {
    stopPolling();
    message.value = status.bot
      ? t('ranked.matchedBot', { name: status.opponent?.nickname ?? 'BOT' })
      : t('ranked.matched', {
          name: status.opponent?.nickname ?? status.opponent?.playerId ?? '—',
          rating: status.opponent?.rating ?? '—',
        });
    if (!leaving) {
      leaving = true;
      setTimeout(() => router.push(`/battle/${status.battleId}`), 800);
    }
    return;
  }
  if (status.state === 'TIMEOUT' || status.state === 'ERROR') {
    stopPolling();
    if (status.state === 'TIMEOUT') error.value = status.message ?? t('ranked.timeout');
    else error.value = t('ranked.error', { message: status.message ?? '' });
    queue.value = null;
  }
}

async function startQueue() {
  if (teamIds.value.length === 0) {
    error.value = t('ranked.teamEmpty');
    return;
  }
  // 入队前再筛一次：勾选之后可能刚好在别的战斗里倒下（服务端 assertTeam 也会 FAINTED 拒绝）
  const fainted = pickedFainted.value;
  if (fainted.length > 0) {
    teamIds.value = teamIds.value.filter((id) => !fainted.some((p) => p.id === id));
    error.value = t('ranked.faintedHint');
    return;
  }
  error.value = '';
  try {
    const status = await enqueueRanked(teamIds.value, mode.value);
    message.value = '';
    applyStatus(status);
    if (status.state === 'QUEUED' || status.state === 'MATCH_PENDING') startPolling();
  } catch (e: unknown) {
    const err = e as { response?: { data?: { code?: string; message?: string } } };
    error.value =
      err?.response?.data?.code === 'FAINTED'
        ? t('ranked.faintedHint')
        : (err?.response?.data?.message ?? t('ranked.loadFail'));
  }
}

async function cancelQueue() {
  try {
    const status = await cancelRankedQueue();
    stopPolling();
    queue.value = null;
    message.value = '';
    if (status.state === 'MATCHED' && status.battleId) applyStatus(status);
  } catch (e: unknown) {
    error.value = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t('ranked.loadFail');
  }
}

async function acceptMatch() {
  error.value = '';
  try {
    applyStatus(await acceptRankedMatch());
  } catch (e: unknown) {
    error.value = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t('ranked.loadFail');
  }
}

async function declineMatch() {
  error.value = '';
  try {
    applyStatus(await declineRankedMatch());
    startPolling();
  } catch (e: unknown) {
    error.value = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t('ranked.loadFail');
  }
}

async function acceptBot() {
  error.value = '';
  message.value = '';
  try {
    applyStatus(await acceptRankedBot());
  } catch (e: unknown) {
    error.value = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t('ranked.loadFail');
  }
}

function startPolling() {
  if (!clockTimer) {
    clockTimer = setInterval(() => {
      now.value = Date.now();
      if (queued.value || pending.value) waitedMs.value += 500;
    }, 500);
  }
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void (async () => {
      try {
        applyStatus(await rankedQueueStatus());
      } catch {
        /* 网络抖动：下一轮再试 */
      }
    })();
  }, 2000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

onMounted(async () => {
  void store.refreshAll();
  await load();
  // 进入页面先恢复一次排队状态（刷新/从战斗退回时仍能看到"回到对局"）
  try {
    const status = await rankedQueueStatus();
    if (status.state !== 'IDLE') applyStatus(status);
    if (status.state === 'QUEUED' || status.state === 'MATCH_PENDING') startPolling();
  } catch {
    /* 首次查询失败不影响页面 */
  }
});

onBeforeUnmount(() => {
  stopPolling();
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
});
</script>

<template>
  <div class="page">
    <div class="px-panel row" style="justify-content: space-between">
      <h2 style="margin: 0">{{ t('ranked.title') }}</h2>
      <div class="row">
        <PixelButton @click="helpOpen = true">{{ t('ranked.help') }}</PixelButton>
        <PixelButton @click="load">{{ t('ranked.refresh') }}</PixelButton>
        <PixelButton variant="blue" @click="router.push('/lobby')">{{ t('ranked.lobby') }}</PixelButton>
      </div>
    </div>

    <!-- 排位帮助：段位表 / ELO / 扩圈 / 机器人 / 补贴 -->
    <PixelDialog
      v-if="helpOpen"
      :title="t('ranked.help.title')"
      :show-cancel="false"
      :confirm-text="t('ranked.help.close')"
      @confirm="helpOpen = false"
      @cancel="helpOpen = false"
    >
      <h3 style="font-size: var(--px-fs-sm)">{{ t('ranked.help.tiers') }}</h3>
      <table class="lb-table">
        <thead>
          <tr>
            <th>{{ t('ranked.help.tierCol') }}</th>
            <th>{{ t('ranked.help.ratingCol') }}</th>
            <th>{{ t('ranked.help.entryCol') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in RANK_TIERS" :key="row.key">
            <td>
              <span class="tier-dot" :style="{ background: row.color }" />
              {{ t(`ranked.tier.${row.key}`) }}
            </td>
            <td>{{ row.min }} – {{ row.max >= 100000 ? '∞' : row.max - 1 }}</td>
            <td>{{ ARENA_ENTRY_FEES[row.key] }}</td>
          </tr>
        </tbody>
      </table>

      <h3 class="mt-16" style="font-size: var(--px-fs-sm)">{{ t('ranked.help.eloTitle') }}</h3>
      <ul class="rules">
        <li>{{ t('ranked.help.elo') }}</li>
        <li>{{ t('ranked.help.eloGap') }}</li>
      </ul>

      <h3 class="mt-16" style="font-size: var(--px-fs-sm)">{{ t('ranked.help.matchTitle') }}</h3>
      <ul class="rules">
        <li>{{ t('ranked.help.window') }}</li>
        <li>{{ t('ranked.help.accept') }}</li>
        <li>{{ t('ranked.help.decline') }}</li>
      </ul>

      <h3 class="mt-16" style="font-size: var(--px-fs-sm)">{{ t('ranked.help.botTitle') }}</h3>
      <ul class="rules">
        <li>{{ t('ranked.help.botOffer') }}</li>
        <li>{{ t('ranked.help.botHalved') }}</li>
        <li>{{ t('ranked.help.botLimit') }}</li>
      </ul>

      <h3 class="mt-16" style="font-size: var(--px-fs-sm)">{{ t('ranked.help.arenaTitle') }}</h3>
      <ul class="rules">
        <li>{{ t('ranked.help.arenaEntry') }}</li>
        <li>{{ t('ranked.help.arenaReward') }}</li>
        <li>{{ t('ranked.help.arenaDraw') }}</li>
        <li>{{ t('ranked.help.arenaSubsidy') }}</li>
        <li>{{ t('ranked.help.arenaAntiAbuse') }}</li>
      </ul>
    </PixelDialog>

    <p v-if="message" class="mb-8 mt-8" style="font-size: var(--px-fs-sm); color: var(--gba-blue)">{{ message }}</p>
    <p v-if="error" class="mb-8 mt-8" style="font-size: var(--px-fs-sm); color: var(--gba-red)">{{ error }}</p>

    <!-- 我的段位卡 -->
    <div class="px-panel mt-8 rank-card">
      <div class="tier-badge" :style="{ background: tier.color }">
        <span class="tier-badge__glyph">◆</span>
        <span class="tier-badge__name">{{ t(`ranked.tier.${tier.key}`) }}</span>
      </div>
      <div style="flex: 1; min-width: 220px">
        <p style="font-size: var(--px-fs-sm)">
          <strong>{{ t('ranked.rating') }}</strong> <span class="rank-rating">{{ rating }}</span>
          <span v-if="me?.rank" class="badge badge--blue" style="margin-left: 6px">
            {{ t('ranked.rank', { rank: me.rank, total: me.total ?? 0 }) }}
          </span>
        </p>
        <p style="font-size: var(--px-fs-sm)" class="mt-8">
          {{ t('ranked.record', { wins: me?.wins ?? 0, losses: me?.losses ?? 0 }) }}
        </p>
        <div class="px-hpbar mt-8">
          <div class="px-hpbar__fill" :style="{ width: progress + '%' }" />
        </div>
        <p class="mt-8" style="font-size: var(--px-fs-sm)">
          <template v-if="next">
            {{ t('ranked.nextTier', { tier: t(`ranked.tier.${next.tier.key}`), points: next.points }) }}
          </template>
          <template v-else>{{ t('ranked.maxTier') }}</template>
        </p>
      </div>
    </div>

    <div class="grid mt-8" style="grid-template-columns: repeat(auto-fit, minmax(320px, 1fr))">
      <!-- 匹配 -->
      <div class="px-panel">
        <h3 style="font-size: var(--px-fs-sm)">{{ t('ranked.matchTitle') }}</h3>
        <p style="font-size: var(--px-fs-sm)" class="text-dim">{{ t('ranked.teamHint') }}</p>

        <!-- 模式：休闲（只争 rating）/ 积分场（按段位收准入积分） -->
        <div class="row mt-8" style="gap: 6px; align-items: center">
          <PixelButton
            :variant="mode === 'casual' ? 'primary' : 'default'"
            :disabled="queued || !!pending"
            @click="setMode('casual')"
          >
            {{ t('ranked.mode.casual') }}
          </PixelButton>
          <PixelButton
            :variant="mode === 'arena' ? 'primary' : 'default'"
            :disabled="queued || !!pending"
            @click="setMode('arena')"
          >
            {{ t('ranked.mode.arena') }}
          </PixelButton>
          <span style="font-size: var(--px-fs-sm)" class="text-dim">
            {{
              mode === 'arena'
                ? t('ranked.mode.arenaFee', { fee: myEntryFee })
                : t('ranked.mode.casualHint')
            }}
          </span>
        </div>

        <div class="team-list mt-8">
          <button
            v-for="p in myTeam"
            :key="p.id"
            type="button"
            class="team-row"
            :class="{
              'team-row--picked': teamIds.includes(p.id),
              'team-row--locked': p.status !== 'IDLE' || isFainted(p) || queued || !!pending,
            }"
            :disabled="p.status !== 'IDLE' || isFainted(p) || queued || !!pending"
            @click="toggle(p.id)"
          >
            <SpriteIcon :species-id="p.speciesId" :size="24" />
            <span style="flex: 1">
              {{ monName(p.speciesId, p.name) }}
              <span class="text-dim">Lv{{ p.level }}</span>
            </span>
            <BondHearts :bond="bondOf(p)" size="sm" />
            <span v-if="isFainted(p)" class="badge badge--red">{{ t('team.fainted') }}</span>
            <span v-else-if="p.status !== 'IDLE'" class="badge">{{ p.status }}</span>
          </button>
          <p v-if="myTeam.length === 0" class="text-dim" style="font-size: var(--px-fs-sm)">
            {{ t('ranked.teamEmpty') }}
          </p>
        </div>
        <p
          v-if="myTeamFainted.length > 0"
          class="mt-8"
          style="font-size: var(--px-fs-sm); color: var(--gba-red)"
        >
          {{ t('ranked.faintedHint') }}
        </p>
        <p class="mt-8" style="font-size: var(--px-fs-sm)">{{ t('ranked.selected', { n: teamIds.length }) }}</p>

        <div class="row mt-8">
          <template v-if="!matched && !pending">
            <PixelButton
              v-if="!queued"
              variant="primary"
              :disabled="teamIds.length === 0"
              @click="startQueue"
            >
              {{ t('ranked.match') }}
            </PixelButton>
            <template v-else>
              <PixelButton variant="danger" @click="cancelQueue">{{ t('ranked.cancel') }}</PixelButton>
              <span class="tier-badge__glyph blink" style="color: var(--gba-green)">●</span>
              <span style="font-size: var(--px-fs-sm)">
                {{ t('ranked.queued', { sec: waitedSec, n: queue?.queueSize ?? 0, window }) }}
              </span>
            </template>
          </template>
          <PixelButton
            v-else-if="pending"
            variant="danger"
            @click="declineMatch"
          >
            {{ t('ranked.pending.decline') }}
          </PixelButton>
          <PixelButton v-else variant="blue" @click="router.push(`/battle/${matched?.battleId}`)">
            {{ t('ranked.backToBattle') }}
          </PixelButton>
        </div>

        <!-- 匹配确认：双方各 15 秒 -->
        <div v-if="pending" class="ranked-alert ranked-alert--pending mt-8">
          <p style="font-size: var(--px-fs-sm)">
            {{ t('ranked.pending.title', { name: pending.opponent?.nickname ?? '—', rating: pending.opponent?.rating ?? '—' }) }}
          </p>
          <p style="font-size: var(--px-fs-sm)" class="text-dim">
            {{ t('ranked.pending.deadline', { sec: acceptLeftSec }) }}
            <template v-if="(pending.entryFee ?? 0) > 0">
              · {{ t('ranked.pending.entry', { fee: pending.entryFee ?? 0 }) }}
            </template>
          </p>
          <!-- 接受前先看对手阵容（服务端只给公开信息：昵称/等级/闪光/最终能力值） -->
          <div v-if="pending.opponent?.team?.length" class="mt-8">
            <OpponentTeamList
              :team="pending.opponent.team"
              :title="t('ranked.pending.teamTitle', { n: pending.opponent.team.length })"
              :hint="t('ranked.pending.teamHint')"
            />
          </div>
          <div class="row mt-8">
            <PixelButton
              v-if="!pending.accepted"
              variant="primary"
              @click="acceptMatch"
            >
              {{ t('ranked.pending.accept') }}
            </PixelButton>
            <span v-else style="font-size: var(--px-fs-sm)">{{ t('ranked.pending.accepted') }}</span>
          </div>
        </div>

        <!-- 机器人对手（排队 60 秒无真人） -->
        <div v-if="queued && queue?.botOffer" class="ranked-alert ranked-alert--bot mt-8">
          <p style="font-size: var(--px-fs-sm)">{{ t('ranked.bot.title') }}</p>
          <p style="font-size: var(--px-fs-sm)" class="text-dim">
            {{ t('ranked.bot.rule', { remaining: queue.botRemainingToday ?? 0 }) }}
          </p>
          <div class="row mt-8">
            <PixelButton variant="blue" @click="acceptBot">{{ t('ranked.bot.accept') }}</PixelButton>
          </div>
        </div>
      </div>

      <!-- 排行榜 -->
      <div class="px-panel">
        <h3 style="font-size: var(--px-fs-sm)">{{ t('ranked.leaderboard') }}</h3>
        <table class="lb-table">
          <thead>
            <tr>
              <th>{{ t('ranked.lbRank') }}</th>
              <th>{{ t('ranked.lbName') }}</th>
              <th>{{ t('ranked.lbRating') }}</th>
              <th>{{ t('ranked.lbRecord') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in board?.top ?? []"
              :key="row.playerId"
              :class="row.isMe ? 'lb-row--me' : ''"
            >
              <td>{{ row.rank }}</td>
              <td>
                <span class="tier-dot" :style="{ background: tierOf(row.rating).color }" />
                {{ row.nickname }}
              </td>
              <td>{{ row.rating }}</td>
              <td>{{ row.wins }}–{{ row.losses }}</td>
            </tr>
            <tr v-if="(board?.top ?? []).length === 0">
              <td colspan="4" class="text-dim">{{ t('ranked.empty') }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="board?.me && board.me.rank > (board.top?.length ?? 0)" class="mt-8" style="font-size: var(--px-fs-sm)">
          {{ t('ranked.rank', { rank: board.me.rank, total: board.me.total ?? 0 }) }}
          · {{ t('ranked.rating') }} {{ board.me.rating }}
        </p>
      </div>
    </div>

    <!-- 规则说明 -->
    <div class="px-panel mt-8">
      <h3 style="font-size: var(--px-fs-sm)">{{ t('ranked.rules') }}</h3>
      <ul class="rules">
        <li>{{ t('ranked.rule.elo') }}</li>
        <li>{{ t('ranked.rule.match') }}</li>
        <li>{{ t('ranked.rule.wager') }}</li>
        <li>{{ t('ranked.rule.bond') }}</li>
        <li>{{ t('ranked.rule.chain') }}</li>
      </ul>
      <div class="tier-strip mt-8">
        <span
          v-for="row in RANK_TIERS"
          :key="row.key"
          class="tier-chip"
          :class="row.key === tier.key ? 'tier-chip--on' : ''"
          :style="{ background: row.color }"
        >
          {{ t(`ranked.tier.${row.key}`) }} {{ row.min }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rank-card {
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
}

.tier-badge {
  width: 96px;
  height: 96px;
  border: 4px solid var(--gba-ink);
  box-shadow: inset -4px -4px 0 0 rgba(0, 0, 0, 0.25), inset 4px 4px 0 0 rgba(255, 255, 255, 0.25);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--gba-ink);
  flex: none;
}

.tier-badge__glyph {
  font-size: var(--px-fs-xl);
  line-height: 1;
}

.tier-badge__name {
  font-size: var(--px-fs-sm);
  margin-top: 4px;
}

.rank-rating {
  font-size: var(--px-fs-lg);
  color: var(--gba-blue);
}

.team-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 260px;
  overflow-y: auto;
}

.team-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--px-fs-sm);
  text-align: left;
  padding: 4px 6px;
  background: var(--gba-cream);
  color: var(--gba-ink);
  border: 2px solid var(--gba-ink);
  cursor: pointer;
}

.team-row--picked {
  background: var(--gba-grass);
  box-shadow: inset 0 0 0 2px var(--gba-ink);
}

.team-row--locked {
  opacity: 0.55;
  cursor: not-allowed;
}

.lb-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--px-fs-sm);
}

.lb-table th,
.lb-table td {
  padding: 4px 6px;
  border-bottom: 2px solid var(--gba-cream-dark);
  text-align: left;
}

.lb-table th {
  font-size: var(--px-fs-sm);
  opacity: 0.75;
}

.lb-row--me {
  background: var(--gba-yellow);
}

.tier-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border: 2px solid var(--gba-ink);
  vertical-align: middle;
}

.rules {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: var(--px-fs-sm);
  line-height: var(--px-lh-body);
}

.tier-strip {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.tier-chip {
  font-size: var(--px-fs-sm);
  padding: 4px 6px;
  border: 2px solid var(--gba-ink);
  color: var(--gba-ink);
  opacity: 0.65;
}

.tier-chip--on {
  opacity: 1;
  box-shadow: 0 0 0 2px var(--gba-ink);
}

/* 匹配确认 / 机器人提示条 */
.ranked-alert {
  border: 2px solid var(--gba-ink);
  padding: 8px;
  background: var(--gba-cream);
  box-shadow: inset -2px -2px 0 0 rgba(0, 0, 0, 0.2);
}

.ranked-alert--pending {
  background: var(--gba-yellow);
}

.ranked-alert--bot {
  background: var(--gba-blue, #4c8bf5);
  color: #fff;
}
</style>
