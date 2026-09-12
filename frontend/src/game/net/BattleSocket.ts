import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from '@/stores/auth';
import { useBattleStore } from '@/stores/battle';
import type { BattleAction, BattleEnd, BattleErrorPush, BattleStatePush, BattleTurn } from '@/types';

/**
 * BattleSocket：Socket.IO namespace /battle，JWT 鉴权。
 * - 连接后 battle:join {battleId} 恢复 / 同步状态
 * - 断线自动重连，重连成功后重新 battle:join（60s 内不算判负）
 * - 所有服务端事件直接写入 battle store，供 Phaser BattleScene 与 Vue HUD 消费
 */
export class BattleSocket {
  private socket: Socket | null = null;
  private battleId = '';

  connect(battleId: string): void {
    this.battleId = battleId;
    const auth = useAuthStore();
    const store = useBattleStore();

    this.socket = io('/battle', {
      path: '/socket.io',
      auth: { token: auth.accessToken },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
      transports: ['websocket', 'polling'],
    });

    this.socket.on('connect', () => {
      store.setConnected(true);
      store.setReconnecting(false);
      this.join();
    });

    this.socket.io.on('reconnect_attempt', () => store.setReconnecting(true));
    this.socket.io.on('reconnect', () => {
      store.setReconnecting(false);
      // connect 事件里会再次 join
    });

    this.socket.on('disconnect', () => {
      store.setConnected(false);
    });

    // 服务端推送包：{ battleId, state, you? }（you 仅 join 应答时携带）
    this.socket.on('battle:state', (push: BattleStatePush) => {
      store.setState(push);
    });

    this.socket.on('battle:turn', (turn: BattleTurn) => {
      store.setTurn(turn);
    });

    // 入场宽限：双方都到齐前不发 battle:turn
    this.socket.on('battle:entry', (entry: Parameters<typeof store.setEntry>[0]) => {
      store.setEntry(entry);
    });

    this.socket.on('battle:end', (end: BattleEnd) => {
      store.setEnd(end);
    });

    this.socket.on('battle:error', (err: BattleErrorPush) => {
      // 视图按 code 给中文文案（如 BATTLE_NOT_LIVE -> 自动退回大厅）；
      // 原始 code/message 一并保留，方便在控制台定位服务端拒绝原因
      console.warn('[battle] server rejected action', err?.code, err?.message ?? '');
      store.setError(err?.code ?? 'BATTLE_ERROR', err?.message);
    });
  }

  join(): void {
    if (!this.socket || !this.battleId) return;
    this.socket.emit('battle:join', { battleId: this.battleId });
  }

  sendAction(action: BattleAction): void {
    if (!this.socket || !this.battleId) return;
    const store = useBattleStore();
    store.setError(''); // 新一次操作先清掉上一次的错误提示
    this.socket.emit('battle:action', {
      battleId: this.battleId,
      seq: store.nextSeq(),
      action,
    });
  }

  disconnect(): void {
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
  }
}

/**
 * LobbySocket：大厅长连（复用 /battle 命名空间，只监听不加入战斗房间）。
 * 押注双确认后服务端向双方用户房间推送 battle:activated，先确认的一方据此
 * 自动进入 /battle/:id（其 REST 响应里没有 battleId）。
 */
export class LobbySocket {
  private socket: Socket | null = null;

  connect(): void {
    const auth = useAuthStore();
    const store = useBattleStore();

    this.socket = io('/battle', {
      path: '/socket.io',
      auth: { token: auth.accessToken },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
      transports: ['websocket', 'polling'],
    });

    this.socket.on('connect', () => store.setLobbyConnected(true));
    this.socket.on('disconnect', () => store.setLobbyConnected(false));
    this.socket.on('battle:activated', (payload: { roomId: string; battleId: string }) => {
      if (payload?.battleId) store.setActivation({ roomId: payload.roomId, battleId: payload.battleId });
    });
  }

  disconnect(): void {
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
  }
}
