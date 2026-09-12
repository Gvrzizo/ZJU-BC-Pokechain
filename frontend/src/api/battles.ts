import { http } from './http';
import type {
  BattleDetail,
  BattleDetailResponse,
  BattleRoom,
  BattleRoomDetail,
  BlockedPlayer,
  WagerRequest,
  WagerTemplate,
} from '@/types';

export async function listRooms(): Promise<BattleRoom[]> {
  const { data } = await http.get<BattleRoom[]>('/battles/rooms');
  return data;
}

/** 房间详情：双方押注的资产富化明细（"查看押注"弹窗用）。 */
export async function getRoomDetail(id: string): Promise<BattleRoomDetail> {
  const { data } = await http.get<BattleRoomDetail>(`/battles/rooms/${encodeURIComponent(id)}`);
  return data;
}

export async function createRoom(payload: {
  mode: '1v1';
  wager: WagerRequest;
  teamPokemonIds: string[];
  /** 房名（≤30 字） */
  name?: string;
  /** 备注：赌什么 / 规则（≤100 字） */
  note?: string;
}): Promise<BattleRoom> {
  const { data } = await http.post<BattleRoom>('/battles/rooms', payload);
  return data;
}

/** 房主改房名 / 备注（仅房主、对战激活前）。 */
export async function updateRoom(
  id: string,
  payload: { name?: string; note?: string },
): Promise<BattleRoom> {
  const { data } = await http.patch<BattleRoom>(`/battles/rooms/${encodeURIComponent(id)}`, payload);
  return data;
}

/** 房主删除房间（仅 WAITING；有人加入需先请离，激活/结束的房间 409）。 */
export async function deleteRoom(roomId: string): Promise<{ deleted: true; roomId: string }> {
  const { data } = await http.delete<{ deleted: true; roomId: string }>(
    `/battles/rooms/${encodeURIComponent(roomId)}`,
  );
  return data;
}

/** 房主请离加入者（仅在双方确认押注前）：房间回到 WAITING。 */
export async function kickPlayer(roomId: string, playerId: string): Promise<BattleRoom> {
  const { data } = await http.post<BattleRoom>(
    `/battles/rooms/${encodeURIComponent(roomId)}/kick`,
    { playerId },
  );
  return data;
}

export async function joinRoom(
  id: string,
  payload: { wager: WagerRequest; teamPokemonIds: string[]; message?: string },
): Promise<BattleRoom> {
  const { data } = await http.post<BattleRoom>(
    `/battles/rooms/${encodeURIComponent(id)}/join`,
    payload,
  );
  return data;
}

/** 屏蔽某玩家（默认 30 分钟）：对方加入我创建的房间会被 403 BLOCKED_BY_HOST 拒绝。 */
export async function blockPlayer(playerId: string): Promise<BlockedPlayer> {
  const { data } = await http.post<BlockedPlayer>('/battles/rooms/block', { playerId });
  return data;
}

export async function unblockPlayer(playerId: string): Promise<void> {
  await http.delete(`/battles/rooms/block/${encodeURIComponent(playerId)}`);
}

/** 我的屏蔽名单（含剩余有效期）。 */
export async function listBlockedPlayers(): Promise<BlockedPlayer[]> {
  const { data } = await http.get<BlockedPlayer[]>('/battles/rooms/blocks');
  return data;
}

/** 常用押注模板（每用户最多 10 个）。 */
export async function listWagerTemplates(): Promise<WagerTemplate[]> {
  const { data } = await http.get<{ templates: WagerTemplate[] }>('/battles/templates');
  return data?.templates ?? [];
}

export async function saveWagerTemplate(payload: {
  name: string;
  note?: string;
  wager: WagerRequest;
}): Promise<WagerTemplate> {
  const { data } = await http.post<WagerTemplate>('/battles/templates', payload);
  return data;
}

export async function deleteWagerTemplate(id: string): Promise<void> {
  await http.delete(`/battles/templates/${encodeURIComponent(id)}`);
}

/** 注意：路径参数是房间 id（room.id），不是 battleId。返回最新房间（含 confirmations/battleId）。 */
export async function confirmWager(roomId: string): Promise<BattleRoom> {
  const { data } = await http.post<BattleRoom>(
    `/battles/${encodeURIComponent(roomId)}/wager/confirm`,
  );
  return data;
}

export async function forfeitBattle(battleId: string): Promise<void> {
  await http.post(`/battles/${encodeURIComponent(battleId)}/forfeit`);
}

/**
 * 双方各确认一次结算结果；第二次确认时链上立即 SETTLED（押注资产交付），
 * 返回最新的链上 battle（含 result.confirmations / status）。
 */
export async function confirmBattleResult(battleId: string): Promise<BattleDetail> {
  const { data } = await http.post<BattleDetail>(
    `/battles/${encodeURIComponent(battleId)}/result/confirm`,
  );
  return data;
}

export async function disputeBattle(battleId: string, reason: string): Promise<void> {
  await http.post(`/battles/${encodeURIComponent(battleId)}/dispute`, { reason });
}

export async function arbitrateBattle(
  battleId: string,
  outcome: string,
  note: string,
): Promise<void> {
  await http.post(`/battles/${encodeURIComponent(battleId)}/arbitrate`, { outcome, note });
}

export async function getBattle(battleId: string): Promise<BattleDetailResponse> {
  const { data } = await http.get<BattleDetailResponse>(
    `/battles/${encodeURIComponent(battleId)}`,
  );
  return data;
}
