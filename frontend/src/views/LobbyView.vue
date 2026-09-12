<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  blockPlayer,
  confirmWager,
  createRoom,
  deleteRoom,
  joinRoom,
  kickPlayer,
  listRooms,
  updateRoom,
} from '@/api/battles';
import { LobbySocket } from '@/game/net/BattleSocket';
import { useAuthStore } from '@/stores/auth';
import { useBattleStore } from '@/stores/battle';
import { usePokemonStore } from '@/stores/pokemon';
import { useI18n } from '@/composables/useI18n';
import type { BattleRoom, WagerBundle, WagerRequest } from '@/types';
import PixelButton from '@/ui/PixelButton.vue';
import PixelDialog from '@/ui/PixelDialog.vue';
import ItemIcon from '@/ui/ItemIcon.vue';
import WagerPicker from '@/components/WagerPicker.vue';
import WagerInspectDialog from '@/components/WagerInspectDialog.vue';
import TeamInspectDialog from '@/components/TeamInspectDialog.vue';
import BlockedPlayersPanel from '@/components/BlockedPlayersPanel.vue';

const router = useRouter();
const store = usePokemonStore();
const auth = useAuthStore();
const battleStore = useBattleStore();
const { monName, itemName } = useI18n();
const rooms = ref<BattleRoom[]>([]);
const message = ref('');
const notice = ref('');
const showCreate = ref(false);
const joining = ref<BattleRoom | null>(null);
const confirming = ref<BattleRoom | null>(null);
const wagerLocked = ref(false);
/** "查看押注"弹窗（房间卡片 / 加入面板 / 确认面板共用） */
const inspecting = ref<BattleRoom | null>(null);
/** "查看队伍"弹窗（同上，展示双方出战队伍，旁观者也能看） */
const inspectingTeam = ref<BattleRoom | null>(null);
const deleting = ref<BattleRoom | null>(null);
const kicking = ref<BattleRoom | null>(null);
const blocking = ref<BattleRoom | null>(null);
const editing = ref<BattleRoom | null>(null);
const showBlocked = ref(false);

/** 每个房间上一次看到的状态：用于轮询兜底发现"刚被激活" */
const seenStatus = new Map<string, BattleRoom['status']>();
/** 我作为挑战者所在房间的快照（roomId → 房主名）：轮询发现"被请离" */
const myJoins = new Map<string, string>();
let leaving = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lobbySocket: LobbySocket | null = null;

const emptyWager = (): WagerRequest => ({ pokemonIds: [], items: [], points: 0 });

const createForm = ref({ name: '', note: '', wager: emptyWager(), teamPokemonIds: [] as string[] });
const joinForm = ref({ message: '', wager: emptyWager(), teamPokemonIds: [] as string[] });
const editForm = ref({ name: '', note: '' });

const STATUS_LABEL: Record<BattleRoom['status'], string> = {
  WAITING: '等待加入',
  JOINED: '待确认押注',
  ACTIVE: '战斗中',
  FINISHED: '已结束',
};

function isParty(r: BattleRoom): boolean {
  const me = auth.user?.username;
  return !!me && (r.playerA === me || r.playerB === me);
}

function isHost(r: BattleRoom): boolean {
  return auth.user?.username === r.playerA;
}

/** 房名（未命名时回退"房主 X 的房间"） */
function roomTitle(r: BattleRoom): string {
  return r.name || `房主 ${r.playerA} 的房间`;
}

function myConfirmed(r: BattleRoom): boolean {
  const me = auth.user?.username;
  if (!me) return false;
  if (r.playerA === me) return r.confirmations.A;
  if (r.playerB === me) return r.confirmations.B;
  return false;
}

/** 对方（房主视角为 B，加入者视角为 A）的押注 */
function opponentWager(r: BattleRoom): WagerBundle {
  return auth.user?.username === r.playerA ? (r.wagerB ?? emptyWager()) : r.wagerA;
}

/** 自己（房主视角为 A，加入者视角为 B）的押注 */
function myWager(r: BattleRoom): WagerBundle {
  return auth.user?.username === r.playerA ? r.wagerA : (r.wagerB ?? emptyWager());
}

/** 进入战斗（同一时刻只跳一次） */
function enterBattle(battleId: string) {
  if (leaving) return;
  leaving = true;
  battleStore.clearActivation();
  router.push(`/battle/${battleId}`);
}

/** 服务端错误 → 中文提示（屏蔽等房间相关 code 单独给文案） */
function errorText(e: unknown, fallback: string): string {
  const err = e as { response?: { data?: { code?: string; message?: string } } };
  const code = err?.response?.data?.code;
  if (code === 'BLOCKED_BY_HOST') return '你已被房主屏蔽（30 分钟内不能加入该房主的房间）';
  if (code === 'NOT_HOST') return '只有房主能做这个操作';
  if (code === 'ROOM_NOT_OPEN') return '房间已进入对战，不能再用这个操作';
  if (code === 'ROOM_NOT_EMPTY') return '房间里已有挑战者——请先"请离"对方，再删除房间';
  if (code === 'PLAYER_NOT_IN_ROOM') return '该玩家已不在房间里';
  if (code === 'INVALID_TEAM_SIZE') return '出战队伍需要 1-6 只宝可梦';
  return err?.response?.data?.message ?? fallback;
}

async function refresh() {
  try {
    const list = await listRooms();
    // 轮询兜底：押注双确认后房间转 ACTIVE，先确认方即使没收到 WS 推送也能入场
    for (const r of list) {
      const was = seenStatus.get(r.id);
      seenStatus.set(r.id, r.status);
      if (r.status === 'ACTIVE' && r.battleId && was === 'JOINED' && isParty(r)) {
        enterBattle(r.battleId);
      }
    }
    detectKick(list);
    rooms.value = list;
  } catch (e: unknown) {
    message.value = errorText(e, '加载失败');
  }
}

/**
 * 被请离检测：上次我还在某房间当挑战者（JOINED），这次房主已把我移出、房间回到
 * WAITING —— 轮询（5s）就能给提示；服务端同时会推 `battle:room-kicked`。
 */
function detectKick(list: BattleRoom[]) {
  const me = auth.user?.username;
  if (!me) return;
  const next = new Map<string, string>();
  for (const r of list) {
    if (r.playerB === me && r.status === 'JOINED') next.set(r.id, r.playerA);
  }
  for (const [roomId, host] of myJoins) {
    if (next.has(roomId)) continue;
    const now = list.find((r) => r.id === roomId);
    if (!now || now.status !== 'WAITING' || now.playerB !== null) continue; // 关房等其它原因不算被踢
    notice.value = `你已被房主 ${host} 请出房间「${roomTitle(now)}」`;
    if (joining.value?.id === roomId) joining.value = null;
    if (confirming.value?.id === roomId) confirming.value = null;
  }
  myJoins.clear();
  for (const [roomId, host] of next) myJoins.set(roomId, host);
}

onMounted(() => {
  store.refreshAll();
  // 从 BattleView（"回到战斗"失败/对局已结束）退回来时的提示：展示一次即清
  notice.value = battleStore.lobbyNotice;
  battleStore.clearLobbyNotice();
  refresh();
  // 大厅长连：battle:activated 由服务端在第二次押注确认后按用户房间推送
  lobbySocket = new LobbySocket();
  lobbySocket.connect();
  pollTimer = setInterval(refresh, 5000);
});

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
  lobbySocket?.disconnect();
  lobbySocket = null;
});

watch(
  () => battleStore.activation,
  (a) => {
    if (a?.battleId) {
      message.value = '押注已链上锁定，正在进入战斗…';
      enterBattle(a.battleId);
    }
  },
);

function wagerSummary(w: WagerBundle | null | undefined): string {
  if (!w) return '无押注';
  const parts: string[] = [];
  if (w.pokemonIds?.length) parts.push(`宝可梦×${w.pokemonIds.length}`);
  const refs = w.items ?? [];
  if (refs.length) {
    // qty=0 是旧格式 itemIds 归一出的整堆标记（升级前创建的房间），按堆叠数计
    const qty = refs.reduce((sum, r) => sum + (r.qty || 0), 0) || refs.length;
    parts.push(`道具×${qty}`);
  }
  if (w.points) parts.push(`${w.points}P`);
  return parts.join(' + ') || '无押注';
}

/** 押注清单明细：道具 id → 自己的背包查 typeId（对方道具查不到则只显示数量） */
function wagerItemsOf(w: WagerBundle | null | undefined) {
  return (w?.items ?? []).map((ref) => {
    const typeId = store.items.find((x) => x.id === ref.id)?.typeId ?? '';
    return { id: ref.id, qty: ref.qty, typeId };
  });
}

/** 押注宝可梦名（interpolate 到当前语言；查不到回退链上 id） */
function wagerMonNames(w: WagerBundle | null | undefined): string {
  return (w?.pokemonIds ?? [])
    .map((id) => {
      const p = store.myPokemon.find((x) => x.id === id);
      return p ? monName(p.speciesId, p.name) : id;
    })
    .join('、');
}

async function submitCreate() {
  try {
    const room = await createRoom({
      mode: '1v1',
      name: createForm.value.name.trim() || undefined,
      note: createForm.value.note.trim() || undefined,
      wager: createForm.value.wager,
      teamPokemonIds: createForm.value.teamPokemonIds,
    });
    message.value = `房间「${roomTitle(room)}」已创建`;
    showCreate.value = false;
    createForm.value = { name: '', note: '', wager: emptyWager(), teamPokemonIds: [] };
    await refresh();
  } catch (e: unknown) {
    message.value = errorText(e, '创建失败');
  }
}

async function submitJoin() {
  const room = joining.value;
  if (!room) return;
  try {
    const joined = await joinRoom(room.id, {
      wager: joinForm.value.wager,
      teamPokemonIds: joinForm.value.teamPokemonIds,
      message: joinForm.value.message.trim() || undefined,
    });
    joining.value = null;
    joinForm.value = { message: '', wager: emptyWager(), teamPokemonIds: [] };
    confirming.value = joined;
    wagerLocked.value = false;
    await refresh();
  } catch (e: unknown) {
    message.value = errorText(e, '加入失败');
  }
}

async function doConfirmWager(room: BattleRoom) {
  if (wagerLocked.value) return;
  try {
    // 路径参数是房间 id；双方都确认后房间转为 ACTIVE 并携带 battleId
    const updated = await confirmWager(room.id);
    wagerLocked.value = true;
    confirming.value = updated;
    if (updated.status === 'ACTIVE' && updated.battleId) {
      message.value = '双方押注已链上锁定，战斗开始！';
      // 双保险：本响应已含 battleId；先确认方则靠 battle:activated 推送跳转
      const battleId = updated.battleId;
      setTimeout(() => enterBattle(battleId), 800);
    } else {
      message.value = '押注清单已确认并锁定，等待对方确认…（对方确认后会自动进入战斗）';
    }
    await refresh();
  } catch (e: unknown) {
    message.value = errorText(e, '确认失败');
  }
}

/** 房主请离加入者（押注双确认前）：房间回 WAITING，被请离者由轮询/WS 收到提示 */
async function doKick() {
  const room = kicking.value;
  if (!room?.playerB) return;
  try {
    await kickPlayer(room.id, room.playerB);
    message.value = `已请离 ${room.playerB}，房间回到"等待加入"`;
    kicking.value = null;
    if (confirming.value?.id === room.id) confirming.value = null;
    await refresh();
  } catch (e: unknown) {
    kicking.value = null;
    message.value = errorText(e, '请离失败');
  }
}

/** 房主删除房间（仅 WAITING：有人加入要先"请离"；二次确认对话框里执行） */
async function doDelete() {
  const room = deleting.value;
  if (!room) return;
  try {
    await deleteRoom(room.id);
    message.value = `房间「${roomTitle(room)}」已删除`;
    deleting.value = null;
    if (inspecting.value?.id === room.id) inspecting.value = null;
    if (inspectingTeam.value?.id === room.id) inspectingTeam.value = null;
    await refresh();
  } catch (e: unknown) {
    deleting.value = null;
    message.value = errorText(e, '删除失败');
  }
}

/** 屏蔽对手（默认 30 分钟）：对方不能加入我创建的房间 */
async function doBlock() {
  const room = blocking.value;
  if (!room?.playerB) return;
  try {
    const entry = await blockPlayer(room.playerB);
    message.value = `已屏蔽 ${entry.playerId}（30 分钟内无法加入你创建的房间）`;
    blocking.value = null;
  } catch (e: unknown) {
    blocking.value = null;
    message.value = errorText(e, '屏蔽失败');
  }
}

function openEdit(room: BattleRoom) {
  editForm.value = { name: room.name ?? '', note: room.note ?? '' };
  editing.value = room;
}

async function submitEdit() {
  const room = editing.value;
  if (!room) return;
  try {
    await updateRoom(room.id, { name: editForm.value.name.trim(), note: editForm.value.note.trim() });
    message.value = '房名 / 备注已更新';
    editing.value = null;
    await refresh();
  } catch (e: unknown) {
    editing.value = null;
    message.value = errorText(e, '更新失败');
  }
}
</script>

<template>
  <div class="page">
    <div class="px-panel mb-16 row" style="justify-content: space-between">
      <h2 style="margin: 0">对战大厅</h2>
      <div class="row">
        <PixelButton variant="blue" @click="showCreate = true">+ 创建房间</PixelButton>
        <PixelButton @click="showBlocked = true">屏蔽名单</PixelButton>
        <PixelButton @click="refresh">刷新</PixelButton>
      </div>
    </div>
    <p v-if="notice" class="mb-8" style="font-size: var(--px-fs-sm); color: var(--gba-red)">{{ notice }}</p>
    <p v-if="message" class="mb-8" style="font-size: var(--px-fs-sm); color: var(--gba-blue)">{{ message }}</p>

    <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(300px, 1fr))">
      <div v-for="r in rooms" :key="r.id" class="px-panel">
        <div class="row" style="justify-content: space-between">
          <strong style="font-size: var(--px-fs-sm)">{{ roomTitle(r) }}</strong>
          <span
            class="badge"
            :class="
              r.status === 'WAITING'
                ? 'badge--green'
                : r.status === 'JOINED'
                  ? 'badge--yellow'
                  : 'badge--blue'
            "
          >
            {{ STATUS_LABEL[r.status] }}
          </span>
        </div>
        <p class="mt-8" style="font-size: var(--px-fs-sm)">
          房主：{{ r.playerA }}　模式：{{ r.mode }}　房主押注：{{ wagerSummary(r.wagerA) }}
        </p>
        <p v-if="r.note" style="font-size: var(--px-fs-sm)">备注：{{ r.note }}</p>
        <p v-if="r.playerB" style="font-size: var(--px-fs-sm)">
          挑战者：{{ r.playerB }}　押注：{{ wagerSummary(r.wagerB) }}
        </p>
        <p v-if="r.joinMessage" style="font-size: var(--px-fs-sm); color: var(--gba-blue)">留言：{{ r.joinMessage }}</p>
        <p class="mono text-dim">{{ r.id }}</p>
        <div class="row mt-8">
          <PixelButton v-if="r.status === 'WAITING' && !isParty(r)" variant="primary" @click="joining = r">
            加入
          </PixelButton>
          <PixelButton
            v-if="r.status === 'JOINED' && isParty(r) && !myConfirmed(r)"
            @click="confirming = r"
          >
            确认押注
          </PixelButton>
          <span v-else-if="r.status === 'JOINED' && isParty(r)" class="text-dim" style="font-size: var(--px-fs-sm)">
            已确认，等待对方…
          </span>
          <PixelButton
            v-if="r.status === 'ACTIVE' && isParty(r) && r.battleId"
            variant="blue"
            @click="enterBattle(r.battleId)"
          >
            回到战斗
          </PixelButton>
          <span v-else-if="r.status === 'ACTIVE' && isParty(r)" class="text-dim" style="font-size: var(--px-fs-sm)">
            对局进行中
          </span>
          <PixelButton @click="inspecting = r">查看押注</PixelButton>
          <PixelButton @click="inspectingTeam = r">查看队伍</PixelButton>
        </div>
        <!-- 房主专属操作：改房名/备注；押注双确认前可请离 / 屏蔽挑战者；空房间可直接删除 -->
        <div v-if="isHost(r) && r.status !== 'ACTIVE' && r.status !== 'FINISHED'" class="row mt-8">
          <PixelButton @click="openEdit(r)">改房名</PixelButton>
          <PixelButton v-if="r.status === 'WAITING'" variant="danger" @click="deleting = r">删除房间</PixelButton>
          <template v-if="r.playerB">
            <PixelButton variant="danger" @click="kicking = r">请离 {{ r.playerB }}</PixelButton>
            <PixelButton variant="danger" @click="blocking = r">屏蔽 {{ r.playerB }}</PixelButton>
          </template>
        </div>
      </div>
      <p v-if="rooms.length === 0" class="px-panel text-dim" style="font-size: var(--px-fs-sm)">
        暂无房间，创建一个吧！
      </p>
    </div>

    <!-- 创建房间 -->
    <PixelDialog
      v-if="showCreate"
      title="创建对战房间"
      confirm-text="创建"
      @confirm="submitCreate"
      @cancel="showCreate = false"
    >
      <div class="px-field">
        <label>房名（≤30 字，可空）</label>
        <input v-model="createForm.name" class="px-input" maxlength="30" placeholder="例如：周末球战" />
      </div>
      <div class="px-field">
        <label>备注（≤100 字：赌什么 / 规则）</label>
        <input
          v-model="createForm.note"
          class="px-input"
          maxlength="100"
          placeholder="例如：只押道具，3v3，禁传说"
        />
      </div>
      <WagerPicker v-model:wager="createForm.wager" v-model:team="createForm.teamPokemonIds" />
    </PixelDialog>

    <!-- 加入房间 -->
    <PixelDialog
      v-if="joining"
      :title="`加入「${roomTitle(joining)}」`"
      confirm-text="加入"
      @confirm="submitJoin"
      @cancel="joining = null"
    >
      <p class="mb-8" style="font-size: var(--px-fs-sm)">对方押注：{{ wagerSummary(joining.wagerA) }}</p>
      <p v-if="joining.note" class="mb-8" style="font-size: var(--px-fs-sm)">房主备注：{{ joining.note }}</p>
      <div class="row mb-8">
        <PixelButton variant="blue" @click="inspecting = joining">查看押注</PixelButton>
        <PixelButton @click="inspectingTeam = joining">查看队伍</PixelButton>
      </div>
      <div class="px-field">
        <label>留言（≤100 字，房主可见）</label>
        <input v-model="joinForm.message" class="px-input" maxlength="100" placeholder="例如：轻点打" />
      </div>
      <WagerPicker v-model:wager="joinForm.wager" v-model:team="joinForm.teamPokemonIds" />
    </PixelDialog>

    <!-- 押注清单双确认 -->
    <PixelDialog
      v-if="confirming"
      title="确认押注清单"
      :confirm-text="wagerLocked ? '已锁定' : '确认并锁定'"
      :show-cancel="!wagerLocked"
      @confirm="doConfirmWager(confirming)"
      @cancel="confirming = null"
    >
      <p style="font-size: var(--px-fs-sm); color: var(--gba-red)">
        确认后押注资产将链上锁定（escrow），战斗结束自动结算，无法修改！
      </p>
      <p v-if="confirming.name" class="mt-8" style="font-size: var(--px-fs-sm)">房名：{{ confirming.name }}</p>
      <p v-if="confirming.note" class="mt-8" style="font-size: var(--px-fs-sm)">房主备注：{{ confirming.note }}</p>
      <p v-if="confirming.joinMessage" class="mt-8" style="font-size: var(--px-fs-sm); color: var(--gba-blue)">
        对手留言：{{ confirming.joinMessage }}
      </p>
      <div class="row mt-8">
        <PixelButton variant="blue" @click="inspecting = confirming">查看押注</PixelButton>
        <PixelButton @click="inspectingTeam = confirming">查看队伍</PixelButton>
      </div>
      <p class="mt-8" style="font-size: var(--px-fs-sm)">对方押注：{{ wagerSummary(opponentWager(confirming)) }}</p>
      <p class="mt-8" style="font-size: var(--px-fs-sm)">我的押注：{{ wagerSummary(myWager(confirming)) }}</p>
      <div class="mt-8" style="font-size: var(--px-fs-sm)">
        <p v-if="wagerMonNames(myWager(confirming))">押注宝可梦：{{ wagerMonNames(myWager(confirming)) }}</p>
        <p
          v-for="row in wagerItemsOf(myWager(confirming))"
          :key="row.id"
          style="display: flex; align-items: center; gap: 4px"
        >
          <ItemIcon v-if="row.typeId" :type-id="row.typeId" :size="24" />
          {{ row.typeId ? itemName(row.typeId) : '道具' }} ×{{ row.qty }}
        </p>
        <p v-if="wagerItemsOf(myWager(confirming)).length === 0" class="text-dim">未押注道具</p>
      </div>
      <p v-if="wagerLocked" class="mt-8" style="font-size: var(--px-fs-sm)">
        <span class="check-pop">✔</span> 已锁定{{
          confirming.status === 'ACTIVE' ? '，即将进入战斗…' : '，等待对方确认后自动进入战斗…'
        }}
      </p>
    </PixelDialog>

    <!-- 查看押注（双方各一栏，资产富化明细） -->
    <WagerInspectDialog
      v-if="inspecting"
      :room-id="inspecting.id"
      :title="`查看押注：${roomTitle(inspecting)}`"
      @close="inspecting = null"
    />

    <!-- 查看队伍（双方出战阵容，旁观者也能看） -->
    <TeamInspectDialog
      v-if="inspectingTeam"
      :room-id="inspectingTeam.id"
      :title="`查看队伍：${roomTitle(inspectingTeam)}`"
      @close="inspectingTeam = null"
    />

    <!-- 房主删除房间（二次确认；仅空房间可删） -->
    <PixelDialog
      v-if="deleting"
      title="删除房间"
      confirm-text="确认删除"
      danger
      @confirm="doDelete"
      @cancel="deleting = null"
    >
      <p style="font-size: var(--px-fs-sm)">
        删除房间「{{ roomTitle(deleting) }}」？房间会从大厅消失，已经提交的押注清单作废。
      </p>
      <p v-if="deleting.playerB" class="mt-8" style="font-size: var(--px-fs-sm); color: var(--gba-red)">
        房间里还有挑战者 {{ deleting.playerB }}：请先用"请离"把他移出，再删除房间。
      </p>
    </PixelDialog>

    <!-- 房主请离 -->
    <PixelDialog
      v-if="kicking"
      title="请离玩家"
      confirm-text="请离"
      danger
      @confirm="doKick"
      @cancel="kicking = null"
    >
      <p style="font-size: var(--px-fs-sm)">
        把 {{ kicking.playerB }} 请出房间「{{ roomTitle(kicking) }}」？房间会回到"等待加入"，
        对方的押注清单作废，双方都需要重新确认押注。
      </p>
    </PixelDialog>

    <!-- 屏蔽对手 -->
    <PixelDialog
      v-if="blocking"
      title="屏蔽玩家"
      confirm-text="屏蔽 30 分钟"
      danger
      @confirm="doBlock"
      @cancel="blocking = null"
    >
      <p style="font-size: var(--px-fs-sm)">
        屏蔽后 {{ blocking.playerB }} 在 30 分钟内不能加入你创建的任何房间（对已在房间里的玩家不生效，
        需要他离开请用"请离"）。
      </p>
    </PixelDialog>

    <!-- 房主改房名 / 备注 -->
    <PixelDialog
      v-if="editing"
      title="修改房名 / 备注"
      confirm-text="保存"
      @confirm="submitEdit"
      @cancel="editing = null"
    >
      <div class="px-field">
        <label>房名（≤30 字）</label>
        <input v-model="editForm.name" class="px-input" maxlength="30" />
      </div>
      <div class="px-field">
        <label>备注（≤100 字）</label>
        <input v-model="editForm.note" class="px-input" maxlength="100" />
      </div>
    </PixelDialog>

    <!-- 屏蔽名单管理 -->
    <BlockedPlayersPanel v-if="showBlocked" @close="showBlocked = false" />
  </div>
</template>
