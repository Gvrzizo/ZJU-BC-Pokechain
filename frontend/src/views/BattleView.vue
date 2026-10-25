<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type Phaser from 'phaser';
import { createGame, destroyGame } from '@/game/createGame';
import { BattleSocket } from '@/game/net/BattleSocket';
import { pvpTurnLines, type PvpLogContext } from '@/game/battle-log';
import { disputeBattle, forfeitBattle, getBattle } from '@/api/battles';
import { getBattleRewardOutcome } from '@/api/ranked';
import { getMe } from '@/api/auth';
import { http } from '@/api/http';
import { useAuthStore } from '@/stores/auth';
import { usePokemonStore } from '@/stores/pokemon';
import { createSettlement } from '@/composables/useSettlement';
import {
  BATTLE_ERROR_TEXT,
  battleErrorText,
  moveDetailText,
  moveStatsLine,
  useBattleStore,
} from '@/stores/battle';
import { useI18n } from '@/composables/useI18n';
import type { BattleDetail, BattleEnd, BattleMoveCatalogResponse, BattleRewardOutcome } from '@/types';
import PixelButton from '@/ui/PixelButton.vue';
import PixelDialog from '@/ui/PixelDialog.vue';
import BondHearts from '@/ui/BondHearts.vue';
import HpBar from '@/ui/HpBar.vue';
import ItemActionRow from '@/components/ItemActionRow.vue';
import WagerInspectDialog from '@/components/WagerInspectDialog.vue';

const route = useRoute();
const router = useRouter();
const battleId = route.params.id as string;

const battleStore = useBattleStore();
const auth = useAuthStore();
const pokemonStore = usePokemonStore();
const { monName, moveName } = useI18n();
const gameHost = ref<HTMLElement | null>(null);
const detail = ref<BattleDetail | null>(null);
const showDispute = ref(false);
const disputeReason = ref('');
const hudMessage = ref('');
const closing = ref(false);
const mode = ref<'root' | 'moves' | 'switch' | 'item'>('root');
/** 悬停/聚焦的技能 id：在下方面板显示威力/命中/属性/说明 */
const hoveredMove = ref('');
/** 本局对应的房间 id（GET /battles/:id 的 roomId）：结算面板"查看押注"用它拉富化明细 */
const roomId = ref('');
const showWager = ref(false);

let game: Phaser.Game | null = null;
let socket: BattleSocket | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let backTimer: ReturnType<typeof setTimeout> | null = null;

/** 结算确认：battle:end 后双方都自动 confirm，SETTLED 后刷新背包/积分（见 useSettlement） */
const settlement = createSettlement(battleId, {
  onSettled: () => {
    hudMessage.value = '结算完成，押注已交付';
    void pokemonStore.refreshAll();
    void getMe()
      .then((user) => auth.setUser(user))
      .catch(() => undefined);
  },
});
const settleStatus = settlement.status;
const settleConfirmed = settlement.confirmedCount;
const settleError = settlement.error;
const settleSettled = settlement.settled;

/** 结算面板的排位分 / 羁绊变化（服务端在链上 SETTLED 后应用，稍晚于结算确认，故轮询几轮） */
const rewardOutcome = ref<BattleRewardOutcome | null>(null);
/** 结算数据仍在应用/拉取中（面板显示"结算中…"） */
const rewardPending = ref(false);
let rewardPollTimer: ReturnType<typeof setInterval> | null = null;
let rewardTries = 0;

const myPlayerId = computed(() => auth.user?.username ?? '');
/** 我方是 A 还是 B（刷新后 battleStore.you 为空，用链上 playerA 判定） */
const myBattleSide = computed<'A' | 'B'>(() => (detail.value?.playerA === myPlayerId.value ? 'A' : 'B'));
const myRatingChange = computed(
  () => rewardOutcome.value?.ratings?.find((r) => r.playerId === myPlayerId.value) ?? null,
);
const myBondChanges = computed(
  () => (rewardOutcome.value?.bonds ?? []).filter((b) => b.side === myBattleSide.value),
);
const foeBondChanges = computed(
  () => (rewardOutcome.value?.bonds ?? []).filter((b) => b.side !== myBattleSide.value),
);
/** 有押注宝可梦时提示"易主后羁绊重置为 30"（换手仪式感） */
const wageredPokemon = computed(
  () =>
    (detail.value?.wagerA.pokemonIds.length ?? 0) + (detail.value?.wagerB.pokemonIds.length ?? 0) > 0,
);

/** 结算面板的排位/羁绊数据：SETTLED 后轮询（应用完成前 status=PENDING） */
function startRewardPoll() {
  if (rewardPollTimer || rewardOutcome.value) return;
  rewardPending.value = true;
  const tick = async () => {
    rewardTries += 1;
    try {
      const outcome = await getBattleRewardOutcome(battleId);
      if (outcome.status !== 'PENDING') {
        rewardOutcome.value = outcome.status === 'NONE' ? null : outcome;
        stopRewardPoll();
        return;
      }
    } catch {
      /* 链上/网络抖动：下一轮再试 */
    }
    if (rewardTries >= 10) stopRewardPoll();
  };
  void tick();
  rewardPollTimer = setInterval(() => void tick(), 2000);
}

function stopRewardPoll() {
  if (rewardPollTimer) clearInterval(rewardPollTimer);
  rewardPollTimer = null;
  rewardPending.value = false;
}

/** 结算面板数据：实时推送（battle:end）优先，刷新页面后回退到链上 result */
const endInfo = computed<BattleEnd | null>(() => {
  if (battleStore.end) return battleStore.end;
  const result = detail.value?.result;
  if (!result?.serverSubmitted) return null;
  return { winnerId: result.winnerId, resultHash: result.resultHash, serverSig: result.serverSig, reason: '' };
});

/** 对局不可重连时的友好提示 + 自动退回大厅 */
function leaveToLobby(text: string, delayMs = 2000) {
  hudMessage.value = text;
  battleStore.setLobbyNotice(text);
  if (backTimer) clearTimeout(backTimer);
  closing.value = true;
  backTimer = setTimeout(() => router.replace('/lobby'), delayMs);
}

/** 这些错误码意味着本局无法继续，提示后自动退回大厅（文案见 BATTLE_ERROR_TEXT） */
const FATAL_ERRORS: string[] = ['BATTLE_NOT_LIVE', 'NOT_PARTY', 'BATTLE_FINISHED'];

// 我方阵营由服务端在 battle:join 应答里下发（store.you），与用户名对齐
const mySide = computed(() => battleStore.mySide);
const foeSide = computed(() => battleStore.foeSide);

const myMon = computed(() => {
  const s = mySide.value;
  return s ? (s.team[s.active] ?? null) : null;
});

const isMyTurn = computed(() => {
  if (battleStore.end || mySide.value?.acted) return false;
  const username = auth.user?.username ?? '';
  if (battleStore.turn) return battleStore.turn.awaitingPlayerIds.includes(username);
  // H15 兜底：刷新后 battle:turn 快照还没到，先按 state 推断（未行动即轮到我），
  // 避免错误地禁用出招按钮直到下一次 30s 回合。
  return Boolean(battleStore.state && !battleStore.state.finished);
});

const turnPct = computed(() =>
  battleStore.entry
    ? (battleStore.entryLeftMs / (battleStore.entry.graceMs || 90000)) * 100
    : (battleStore.timeLeftMs / 30000) * 100,
);

const winnerIsMe = computed(() => endInfo.value?.winnerId === auth.user?.username);

/** 入场宽限剩余秒数（双方都到齐前不计回合 30s） */
const entrySeconds = computed(() => Math.ceil(battleStore.entryLeftMs / 1000));
const turnSeconds = computed(() => Math.ceil(battleStore.timeLeftMs / 1000));
const entryText = computed(() =>
  battleStore.entry ? `等待 ${battleStore.entry.awaitingPlayerIds.join('、')} 入场…` : '',
);

/** 服务端拒绝出招时的中文提示（原始 code/message 在控制台） */
const errorText = computed(() => battleErrorText(battleStore.lastError, battleStore.lastErrorMessage));

const moveLabel = (moveId: string) => moveName(moveId, battleStore.moveInfo(moveId)?.name ?? moveId);
const moveStats = (moveId: string) => moveStatsLine(battleStore.moveInfo(moveId));
const moveDetail = (moveId: string) => moveDetailText(moveLabel(moveId), battleStore.moveInfo(moveId));
const shownMoveDetail = computed(() => (hoveredMove.value ? moveDetail(hoveredMove.value) : ''));

/** 出战宝可梦名（按图鉴编号本地化，查不到回退链上英文名） */
function monLabel(mon: { speciesId: number; name: string } | null | undefined): string {
  return mon ? monName(mon.speciesId, mon.name) : '—';
}

// ---- 实时战斗日志（服务端每结算一个回合就随 battle:state 推送事件，这里渲染成中文行）----
const logBox = ref<HTMLElement | null>(null);

/** 全场宝可梦 id → 显示名：换下场的成员在历史日志里同样能解析（名称走 i18n） */
const monNames = computed<Record<string, string>>(() => {
  const names: Record<string, string> = {};
  for (const side of ['A', 'B'] as const) {
    for (const mon of battleStore.state?.[side].team ?? []) names[mon.pokemonId] = monLabel(mon);
  }
  return names;
});

/** 技能 id → 显示名（GET /battles/moves 的静态全表；未加载时 pvpEventText 回退技能 id） */
const moveNames = computed<Record<string, string>>(() => {
  const names: Record<string, string> = {};
  for (const id of Object.keys(battleStore.moveCatalog)) names[id] = moveLabel(id);
  return names;
});

const logCtx = computed<PvpLogContext>(() => ({
  monNames: monNames.value,
  moveNames: moveNames.value,
  playerNames: { A: detail.value?.playerA, B: detail.value?.playerB },
}));

/** 每个已结算回合 → 日志面板的行（回合标题 + 中文事件行） */
const logTurns = computed(() =>
  (battleStore.state?.log ?? []).map((turn) => ({ turn: turn.turn, lines: pvpTurnLines(turn, logCtx.value) })),
);

// 新回合到达后滚到底部（与野怪战斗 CaptureOverlay 的日志行为一致）
watch(
  () => battleStore.state?.log?.length ?? 0,
  () => {
    void nextTick(() => {
      if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
    });
  },
  { immediate: true },
);

/** 押注道具数量求和：items 形态按 qty 累加（qty=0 为旧格式整堆标记，按堆叠数计） */
function wagerItemCount(wager: { items?: { qty?: number }[]; itemIds?: string[] } | null | undefined): number {
  const refs = wager?.items;
  if (refs) return refs.reduce((sum, r) => sum + (r.qty || 0), 0) || refs.length;
  return wager?.itemIds?.length ?? 0;
}

function act(action: Parameters<BattleSocket['sendAction']>[0]) {
  socket?.sendAction(action);
  mode.value = 'root';
}

/** 技能元数据（GET /battles/moves）：失败时按钮只显示技能名，不影响出招 */
async function loadMoveCatalog() {
  try {
    const { data } = await http.get<BattleMoveCatalogResponse>('/battles/moves');
    battleStore.setMoveCatalog(data?.moves ?? []);
  } catch (e) {
    console.warn('[battle] 技能元数据加载失败，技能按钮仅显示技能名', e);
  }
}

onMounted(async () => {
  battleStore.reset();
  try {
    const res = await getBattle(battleId);
    detail.value = res.battle;
    roomId.value = res.roomId ?? '';
    // RESULT_SUBMITTED：没有实时引擎但还没结算 —— 当事双方直接进结算确认流程（自动 confirm + 等待对方）
    if (!res.live && res.battle.status === 'RESULT_SUBMITTED') {
      const me = auth.user?.username;
      if (me === res.battle.playerA || me === res.battle.playerB) {
        void settlement.start();
      } else {
        leaveToLobby('该对局已结束或已清理，正在返回大厅…');
      }
      return;
    }
    // 已结束/退款/争议中的对局没有实时引擎，直接给出友好提示
    if (!res.live && ['SETTLED', 'REFUNDED', 'DISPUTED'].includes(res.battle.status)) {
      leaveToLobby(
        res.battle.status === 'DISPUTED'
          ? '本局争议仲裁中，资产暂时冻结；可在大厅等待裁决结果'
          : `本局已结束（${res.battle.status}），即将返回大厅…`,
        3000,
      );
      return;
    }
  } catch (e: unknown) {
    // 房间/对局不存在（被对账清理、id 过期）：友好提示后回大厅
    console.warn('[battle] 对局详情加载失败', e);
    leaveToLobby('该对局已结束或已清理，正在返回大厅…');
    return;
  }
  if (closing.value) return;
  if (gameHost.value) game = createGame(gameHost.value, 'battle');
  socket = new BattleSocket();
  socket.connect(battleId);
  void loadMoveCatalog();
  timer = setInterval(() => battleStore.tick(), 200);
});

// battle:end -> 双方客户端自动确认结算（押注资产尽快交付）
watch(
  () => battleStore.end,
  (end) => {
    if (end) void settlement.start();
  },
);

// SETTLED -> 拉取排位分 / 羁绊变化（服务端此时才应用，轮询几轮等它落库）
watch(settleSettled, (settled) => {
  if (settled) startRewardPoll();
});

// battle:error -> 中文友好提示并退回大厅（例如对局已结束后的误入）
watch(
  () => battleStore.lastError,
  (code) => {
    if (!code) return;
    if (FATAL_ERRORS.includes(code)) {
      socket?.disconnect();
      leaveToLobby(BATTLE_ERROR_TEXT[code] ?? battleErrorText(code));
    }
  },
);

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  if (backTimer) clearTimeout(backTimer);
  stopRewardPoll();
  settlement.stop();
  socket?.disconnect();
  destroyGame(game);
  game = null;
  battleStore.reset();
});

async function doForfeit() {
  try {
    await forfeitBattle(battleId);
  } catch (e: any) {
    hudMessage.value = e?.response?.data?.message ?? '认输失败';
  }
}

async function doDispute() {
  try {
    await disputeBattle(battleId, disputeReason.value);
    hudMessage.value = '已提交争议申诉，等待仲裁';
    showDispute.value = false;
  } catch (e: any) {
    hudMessage.value = e?.response?.data?.message ?? '申诉失败';
  }
}
</script>

<template>
  <div class="page">
    <div class="px-panel" style="padding: 8px; position: relative">
      <div ref="gameHost" class="battle-host" />
      <!-- 对局不可用（已结束/误入）：友好提示 + 自动回大厅 -->
      <div v-if="closing && hudMessage" class="reconnect-banner">{{ hudMessage }}</div>
      <!-- 入场宽限提示 -->
      <div v-else-if="battleStore.entry" class="reconnect-banner reconnect-banner--info">
        {{ entryText }}（{{ entrySeconds }}s 内未到判负）
      </div>
      <!-- 断线重连提示 -->
      <div v-if="battleStore.reconnecting" class="reconnect-banner blink">
        连接断开，重连中…（60 秒内重连不会判负）
      </div>
      <div v-else-if="!battleStore.connected && !closing" class="reconnect-banner">连接中…</div>
    </div>

    <!-- 回合计时条（入场宽限期内显示入场倒计时） -->
    <div class="px-panel mt-8" style="padding: 8px">
      <div class="row" style="justify-content: space-between; font-size: var(--px-fs-sm)">
        <span>
          {{
            battleStore.entry
              ? entryText
              : isMyTurn
                ? '轮到你行动！'
                : battleStore.turn
                  ? '等待对方…'
                  : '同步战斗状态…'
          }}
        </span>
        <span>
          {{
            battleStore.entry
              ? entrySeconds + 's'
              : battleStore.turn
                ? turnSeconds + 's'
                : '—'
          }}
        </span>
      </div>
      <div class="px-hpbar mt-8">
        <div
          class="px-hpbar__fill"
          :class="turnPct < 30 ? 'px-hpbar__fill--low' : ''"
          :style="{ width: turnPct + '%' }"
        />
      </div>
    </div>

    <!-- 结算面板（battle:end 或刷新后链上 RESULT_SUBMITTED）：自动确认 + 提示押注交付 -->
    <div v-if="endInfo" class="px-panel mt-8" style="text-align: center">
      <h2 :style="{ color: winnerIsMe ? 'var(--gba-green)' : 'var(--gba-red)' }">
        {{ endInfo.winnerId === 'DRAW' ? '平局！' : winnerIsMe ? '胜利！' : '战败…' }}
      </h2>
      <p style="font-size: var(--px-fs-sm)">赢家：{{ endInfo.winnerId }}</p>
      <div v-if="detail" class="mt-8" style="font-size: var(--px-fs-sm); text-align: left">
        <p><strong>赢家获得全部押注：</strong></p>
        <p>
          A 押注：宝可梦×{{ detail.wagerA.pokemonIds.length }} + 道具×{{
            wagerItemCount(detail.wagerA)
          }}
          + {{ detail.wagerA.points }}P
        </p>
        <p>
          B 押注：宝可梦×{{ detail.wagerB.pokemonIds.length }} + 道具×{{
            wagerItemCount(detail.wagerB)
          }}
          + {{ detail.wagerB.points }}P
        </p>
        <p class="mono text-dim">resultHash: {{ endInfo.resultHash }}</p>
        <p class="mono text-dim">serverSig: {{ endInfo.serverSig }}</p>
        <p class="mono text-dim">eventId: ev_battle_{{ battleId }}（可在公平性页面复核）</p>
      </div>

      <!-- 结算确认状态：确认后链上立即 SETTLED，押注资产此时才交付 -->
      <div class="mt-8 settle-box">
        <p v-if="settleSettled" data-test="settled" style="color: var(--gba-green)">
          ✔ 押注已交付（积分与资产已到账，背包已刷新）
        </p>
        <template v-else-if="settleStatus === 'error'">
          <p style="color: var(--gba-red)">{{ settleError }}</p>
          <PixelButton variant="primary" class="mt-8" @click="settlement.confirm()">
            确认结算
          </PixelButton>
        </template>
        <p v-else-if="settleStatus === 'sending'">正在确认结算结果…</p>
        <p v-else data-test="waiting">
          已确认 {{ settleConfirmed }}/2，等待对方确认…
          <span class="text-dim">（对方确认后自动结算，2 分钟无确认由服务端兜底）</span>
        </p>

        <!-- 排位分变化（仅排位房） -->
        <div v-if="myRatingChange" class="mt-8" style="text-align: left" data-test="ranked-change">
          <p style="font-size: var(--px-fs-sm)">
            <strong>排位分：</strong>{{ myRatingChange.before }} →
            <span :class="myRatingChange.delta >= 0 ? 'stat-up' : 'stat-down'">
              {{ myRatingChange.after }}（{{ myRatingChange.delta >= 0 ? '+' : ''
              }}{{ myRatingChange.delta }}）
            </span>
            <span class="text-dim"> 链上 UpdateRating（reason=ranked:{{ battleId }}）</span>
          </p>
        </div>

        <!-- 羁绊变化（PvP 结算） -->
        <div
          v-if="myBondChanges.length > 0 || foeBondChanges.length > 0"
          class="mt-8"
          style="text-align: left"
          data-test="bond-change"
        >
          <p style="font-size: var(--px-fs-sm)"><strong>羁绊变化：</strong></p>
          <p v-for="b in myBondChanges" :key="b.pokemonId" style="font-size: var(--px-fs-sm)">
            我方 {{ monLabel(b) }} 羁绊 {{ b.before }}→{{ b.after }}
            <BondHearts :bond="b.after" size="sm" :delta="b.delta" />
          </p>
          <p v-for="b in foeBondChanges" :key="b.pokemonId" style="font-size: var(--px-fs-sm)" class="text-dim">
            对方 {{ monLabel(b) }} 羁绊 {{ b.before }}→{{ b.after }}
            <BondHearts :bond="b.after" size="sm" :delta="b.delta" />
          </p>
          <p v-if="settleSettled" class="text-dim" style="font-size: var(--px-fs-sm)">
            链上 BondUp（reason=bond:pvp:{{ battleId }}）
          </p>
        </div>
        <p v-else-if="rewardPending" class="text-dim" style="font-size: var(--px-fs-sm)">排位分 / 羁绊结算中…</p>

        <!-- 换手仪式感：押注宝可梦易主后羁绊重置 -->
        <p v-if="wageredPokemon" class="mt-8" style="font-size: var(--px-fs-sm); color: var(--gba-blue)">
          ⚠ 本局押注的宝可梦易主后，羁绊将重置为 30
        </p>
      </div>

      <div class="row mt-8" style="justify-content: center">
        <PixelButton v-if="roomId" variant="blue" @click="showWager = true">查看押注</PixelButton>
        <PixelButton variant="blue" @click="showDispute = true">争议申诉</PixelButton>
        <PixelButton variant="primary" @click="router.push('/lobby')">返回大厅</PixelButton>
      </div>
    </div>

    <!-- 查看押注：双方押注资产的富化明细（房间已被对账清理时 roomId 为空，按钮不显示） -->
    <WagerInspectDialog
      v-if="showWager && roomId"
      :room-id="roomId"
      title="本局押注"
      @close="showWager = false"
    />

    <!-- 操作区 + 日志 -->
    <div v-else class="mt-8" style="display: flex; gap: 12px; flex-wrap: wrap">
      <div class="px-panel" style="flex: 1; min-width: min(100%, 300px)">
        <p v-if="hudMessage" style="font-size: var(--px-fs-sm); color: var(--gba-red)">{{ hudMessage }}</p>
        <template v-if="mode === 'root'">
          <div class="grid" style="grid-template-columns: 1fr 1fr">
            <PixelButton variant="primary" :disabled="!isMyTurn" @click="mode = 'moves'">
              技能
            </PixelButton>
            <PixelButton :disabled="!isMyTurn" @click="mode = 'switch'">换宠</PixelButton>
            <PixelButton :disabled="!isMyTurn" @click="mode = 'item'">道具</PixelButton>
            <PixelButton variant="danger" :disabled="!isMyTurn" @click="doForfeit">
              逃跑/认输
            </PixelButton>
          </div>
        </template>
        <template v-else-if="mode === 'moves'">
          <div class="grid" style="grid-template-columns: 1fr 1fr">
            <PixelButton
              v-for="m in myMon?.moves ?? []"
              :key="m"
              variant="primary"
              :title="moveDetail(m)"
              @mouseenter="hoveredMove = m"
              @focus="hoveredMove = m"
              @click="act({ type: 'move', moveId: m })"
            >
              <span class="move-btn__name">{{ moveLabel(m) }}</span>
              <span v-if="moveStats(m)" class="move-btn__stats">{{ moveStats(m) }}</span>
            </PixelButton>
            <PixelButton @click="mode = 'root'">返回</PixelButton>
          </div>
          <!-- 悬停/聚焦的技能说明：威力/命中/属性 + 效果描述（效果系统落地前省略说明行） -->
          <p class="move-detail">
            {{ shownMoveDetail || '悬停技能可查看 威力 / 命中 / 属性 / 说明' }}
          </p>
        </template>
        <template v-else-if="mode === 'switch'">
          <div class="grid" style="grid-template-columns: 1fr 1fr">
            <div v-for="(p, i) in mySide?.team ?? []" :key="p.pokemonId" class="switch-cell">
              <PixelButton
                :disabled="i === mySide?.active || p.fainted"
                @click="act({ type: 'switch', targetPokemonId: p.pokemonId })"
              >
                {{ monLabel(p) }} {{ p.hp }}/{{ p.maxHp }}
                <span v-if="p.fainted" class="text-dim">（濒死）</span>
              </PixelButton>
              <!-- 伤势持久化：换宠面板直接展示当前 HP 条（docs/backend-api.md §2） -->
              <HpBar :hp="p.hp" :max-hp="p.maxHp" />
            </div>
            <PixelButton @click="mode = 'root'">返回</PixelButton>
          </div>
        </template>
        <template v-else>
          <p style="font-size: var(--px-fs-sm)">输入道具 ID 使用（对战内道具由服务端校验）</p>
          <ItemActionRow @use="(id: string) => act({ type: 'item', itemId: id })" />
          <PixelButton class="mt-8" @click="mode = 'root'">返回</PixelButton>
        </template>
      </div>

      <!-- 战斗状态 -->
      <div class="px-panel" style="flex: 1; min-width: min(100%, 300px)">
        <h3 style="font-size: var(--px-fs-sm)">战斗状态</h3>
        <div style="min-height: 96px; font-size: var(--px-fs-sm)">
          <template v-if="battleStore.state">
            <p class="mt-8">> 回合 {{ battleStore.state.turn }}</p>
            <p class="mt-8">
              > 我方：{{ myMon ? `${monLabel(myMon)} ${myMon.hp}/${myMon.maxHp}` : '—' }}
              <span v-if="mySide?.acted">（已行动）</span>
              <span v-else-if="mySide?.mustSwitch">（必须换宠！）</span>
            </p>
            <HpBar v-if="myMon" :hp="myMon.hp" :max-hp="myMon.maxHp" />
            <p class="mt-8">
              > 对方：{{
                foeSide ? `${monLabel(foeSide.team[foeSide.active])} ${foeSide.team[foeSide.active]?.hp ?? 0}/${foeSide.team[foeSide.active]?.maxHp ?? 0}` : '—'
              }}
              <span v-if="foeSide?.acted">（已行动）</span>
            </p>
            <HpBar
              v-if="foeSide?.team[foeSide.active]"
              :hp="foeSide.team[foeSide.active].hp ?? 0"
              :max-hp="foeSide.team[foeSide.active].maxHp ?? 0"
            />
          </template>
          <p v-else class="text-dim mt-8">
            {{ battleStore.entry ? '等待双方入场…' : '等待战斗开始…' }}
          </p>
        </div>
        <p v-if="battleStore.lastError" style="font-size: var(--px-fs-sm); color: var(--gba-red)">
          {{ errorText }}
        </p>
      </div>
    </div>

    <!-- 实时战斗日志：服务端每结算一个回合就随 battle:state 推送，逐行滚动到底部；
         结算面板出现后仍然保留（回看最后几个回合的击倒/胜负） -->
    <div class="px-panel mt-8">
      <h3 style="font-size: var(--px-fs-sm)">战斗日志</h3>
      <div ref="logBox" class="battle-log">
        <template v-for="turn in logTurns" :key="turn.turn">
          <p class="battle-log__turn">— 第 {{ turn.turn }} 回合 —</p>
          <p v-for="(line, i) in turn.lines" :key="`${turn.turn}-${i}`" class="battle-log__line">{{ line }}</p>
        </template>
        <p v-if="logTurns.length === 0" class="text-dim battle-log__line">
          {{ battleStore.entry ? '等待双方入场…' : '等待第一回合结算…' }}
        </p>
      </div>
    </div>

    <!-- 争议申诉 -->
    <PixelDialog
      v-if="showDispute"
      title="争议申诉"
      danger
      confirm-text="提交申诉"
      @confirm="doDispute"
      @cancel="showDispute = false"
    >
      <p style="font-size: var(--px-fs-sm)">
        提交后本局进入 DISPUTED，押注资产冻结，由仲裁员裁决。请描述争议原因：
      </p>
      <textarea v-model="disputeReason" class="px-textarea mt-8" rows="3" />
    </PixelDialog>
  </div>
</template>

<style scoped>
.battle-host {
  width: 100%;
  max-width: 960px;
  margin: 0 auto;
  aspect-ratio: 3 / 2;
}

.battle-host :deep(canvas) {
  image-rendering: pixelated;
  display: block;
  margin: 0 auto;
}

/* 换宠面板：按钮 + 当前 HP 条 */
.switch-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.reconnect-banner {
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--gba-red);
  color: #fff;
  font-size: var(--px-fs-sm);
  padding: 8px 16px;
  border: 3px solid var(--gba-ink);
  z-index: 20;
}

.reconnect-banner--info {
  background: var(--gba-blue);
  text-align: center;
}

/* 技能按钮：上行技能名，下行 威力/命中/属性 */
.move-btn__name {
  display: block;
}

.settle-box {
  font-size: var(--px-fs-sm);
  border-top: 2px solid var(--gba-ink);
  padding-top: 8px;
}

.move-btn__stats {
  display: block;
  margin-top: 2px;
  font-size: var(--px-fs-sm);
  opacity: 0.85;
}

.move-detail {
  margin-top: 8px;
  min-height: 20px;
  font-size: var(--px-fs-sm);
  line-height: var(--px-lh-tight);
  white-space: pre-line;
  color: var(--gba-ink);
}

/* 实时战斗日志：固定高度 + 自动滚到底部（新回合到达时） */
.battle-log {
  height: 132px;
  margin-top: 8px;
  padding: 6px 8px;
  overflow-y: auto;
  background: #fffef0;
  border: 3px solid var(--gba-ink);
  font-size: var(--px-fs-sm);
  line-height: var(--px-lh-body);
}

.battle-log__turn {
  margin: 0;
  color: var(--gba-blue);
}

.battle-log__line {
  margin: 0;
}
</style>
