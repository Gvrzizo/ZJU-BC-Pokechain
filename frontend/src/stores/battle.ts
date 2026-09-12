import { defineStore } from 'pinia';
import type {
  BattleEnd,
  BattleMoveInfo,
  BattleSideState,
  BattleState,
  BattleStatePush,
  BattleTurn,
} from '@/types';

/** 入场宽限期推送（battle:entry）：双方都到齐前不计回合 30s */
export interface BattleEntry {
  battleId: string;
  awaitingPlayerIds: string[];
  arrivedPlayerIds?: string[];
  deadline: number; // epoch ms
  graceMs: number;
}

/** 大厅推送（battle:activated）：押注双确认后服务端按用户房间下发 */
export interface BattleActivation {
  roomId: string;
  battleId: string;
}

/**
 * battle:error 的 code -> 中文提示。原始 code（以及服务端 message）仍会写进
 * store.lastError / lastErrorMessage 并打到控制台，便于排查。
 */
export const BATTLE_ERROR_TEXT: Record<string, string> = {
  BATTLE_ERROR: '操作被服务端拒绝，请重试',
  BAD_REQUEST: '请求信息不完整，请刷新页面重试',
  BAD_ACTION: '无效的操作类型',
  UNKNOWN_MOVE: '该技能不属于当前出战宝可梦，请重新选择',
  INVALID_MOVE_INDEX: '该技能不可用，请重新选择',
  UNKNOWN_POKEMON: '换宠目标不在你的队伍中',
  INVALID_SWITCH_INDEX: '换宠目标无效',
  SWITCH_TO_ACTIVE: '该宝可梦已经在场上',
  SWITCH_TO_FAINTED: '该宝可梦已倒下，不能上场',
  MUST_SWITCH: '出战宝可梦已倒下，必须先换宠',
  ACTION_ALREADY_SUBMITTED: '本回合你已经出过招，等待对方行动…',
  ITEM_NOT_SUPPORTED: '对战回合中暂不支持使用道具',
  BATTLE_FINISHED: '本局已结束，即将返回大厅…',
  BATTLE_NOT_LIVE: '该对局已结束或已清理，即将返回大厅…',
  NOT_PARTY: '你不是本局对战的双方玩家，即将返回大厅…',
  UNAUTHORIZED: '登录状态已失效，请重新登录',
};

/** 服务端错误码 -> 用户可读文案（未收录的 code 回退通用文案，不丢原始 code） */
export function battleErrorText(code: string, detail?: string): string {
  const known = BATTLE_ERROR_TEXT[code];
  if (known) return known;
  return detail ? `操作失败（${code}）：${detail}` : `操作失败（${code}）`;
}

/** 技能按钮上的"威力/命中/属性"一行；元数据未加载时返回空串 */
export function moveStatsLine(info: BattleMoveInfo | null | undefined): string {
  if (!info) return '';
  return `威力${info.power} · 命中${info.accuracy} · ${info.type}`;
}

/** 技能悬停/选中说明：名称 + 威力/命中/属性/分类 + 效果描述（暂无效果文本时省略） */
export function moveDetailText(label: string, info: BattleMoveInfo | null | undefined): string {
  if (!info) return label;
  const category = info.category === 'physical' ? '物理' : '特殊';
  const lines = [`${label}（${info.name}）`, `威力 ${info.power} · 命中 ${info.accuracy} · ${info.type} · ${category}`];
  if (info.effectText) lines.push(info.effectText);
  return lines.join('\n');
}

// 战斗实时状态：由 BattleSocket 驱动，供 Phaser BattleScene 与 Vue HUD 共同消费
export const useBattleStore = defineStore('battle', {
  state: () => ({
    battleId: '',
    /** 当前用户所在侧（battle:join 应答下发，重连会刷新） */
    you: null as 'A' | 'B' | null,
    connected: false,
    reconnecting: false,
    /** 大厅长连状态（LobbySocket；与战斗连接分开） */
    lobbyConnected: false,
    state: null as BattleState | null,
    turn: null as BattleTurn | null,
    entry: null as BattleEntry | null,
    /** GET /battles/moves 的技能元数据（id -> 名称/威力/命中/属性/说明） */
    moveCatalog: {} as Record<string, BattleMoveInfo>,
    /** 收到 battle:activated 后置位，由大厅视图负责跳转 */
    activation: null as BattleActivation | null,
    end: null as BattleEnd | null,
    /** 最近一次 battle:error 的 code（视图按 code 决定是否退回大厅） */
    lastError: '',
    /** 最近一次 battle:error 的服务端原文（只用于展示/排查） */
    lastErrorMessage: '',
    /** 从 BattleView 退回大厅时留下的提示（房间已结束/已清理，由 LobbyView 展示） */
    lobbyNotice: '',
    seq: 0,
    now: Date.now(),
  }),
  getters: {
    mySide(s): BattleSideState | null {
      return s.state && s.you ? s.state[s.you] : null;
    },
    foeSide(s): BattleSideState | null {
      return s.state && s.you ? s.state[s.you === 'A' ? 'B' : 'A'] : null;
    },
    /** 技能 id -> 元数据（未加载/未收录返回 null） */
    moveInfo(s) {
      return (moveId: string): BattleMoveInfo | null => s.moveCatalog[moveId] ?? null;
    },
    timeLeftMs(s): number {
      if (!s.turn) return 0;
      return Math.max(0, s.turn.deadline - s.now);
    },
    entryLeftMs(s): number {
      if (!s.entry) return 0;
      return Math.max(0, s.entry.deadline - s.now);
    },
  },
  actions: {
    setConnected(v: boolean) {
      this.connected = v;
      if (v) this.reconnecting = false;
    },
    setReconnecting(v: boolean) {
      this.reconnecting = v;
    },
    setLobbyConnected(v: boolean) {
      this.lobbyConnected = v;
    },
    // 服务端 battle:state 推送包：{ battleId, state, you? }
    setState(push: BattleStatePush) {
      this.state = push.state;
      this.battleId = push.battleId;
      if (push.you) this.you = push.you;
    },
    /** 技能元数据（GET /battles/moves，一次拉取整局可用） */
    setMoveCatalog(moves: BattleMoveInfo[]) {
      const catalog: Record<string, BattleMoveInfo> = {};
      for (const move of moves ?? []) catalog[move.id] = move;
      this.moveCatalog = catalog;
    },
    setTurn(t: BattleTurn) {
      this.turn = t;
    },
    setEntry(e: BattleEntry) {
      // 双方到齐后 awaitingPlayerIds 为空 -> 收起入场提示
      this.entry = e.awaitingPlayerIds.length > 0 ? e : null;
    },
    setActivation(a: BattleActivation) {
      this.activation = a;
    },
    clearActivation() {
      this.activation = null;
    },
    setEnd(e: BattleEnd) {
      this.end = e;
    },
    setError(code: string, message?: string) {
      this.lastError = code;
      this.lastErrorMessage = message ?? '';
    },
    setLobbyNotice(text: string) {
      this.lobbyNotice = text;
    },
    clearLobbyNotice() {
      this.lobbyNotice = '';
    },
    nextSeq(): number {
      this.seq += 1;
      return this.seq;
    },
    tick() {
      this.now = Date.now();
    },
    reset() {
      this.battleId = '';
      this.you = null;
      this.connected = false;
      this.reconnecting = false;
      this.state = null;
      this.turn = null;
      this.entry = null;
      this.moveCatalog = {};
      this.activation = null;
      this.end = null;
      this.lastError = '';
      this.lastErrorMessage = '';
      this.seq = 0;
    },
  },
});
