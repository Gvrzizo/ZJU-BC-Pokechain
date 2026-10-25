import { Context, Contract, Returns, Transaction } from 'fabric-contract-api';
import { assertISO, fail, requireNonEmpty, safeInt } from '../common/assert';
import { getMspId, requireRole, ROLES } from '../common/cid';
import { withIdempotency } from '../common/idempotency';
import { INITIAL_POINTS, Player, RATING_DEFAULT, RATING_MAX, TRANSFER_LOCK_MS } from '../common/model';
import {
  assertCallerIsPlayer,
  assertTransferUnlocked,
  creditPoints,
  debitPoints,
  emit,
  exists,
  loadPlayer,
  savePlayer,
} from '../common/state';

export class PlayerContract extends Contract {
  constructor() {
    super('PlayerContract');
  }

  @Transaction()
  public async RegisterPlayer(
    ctx: Context,
    playerId: string,
    nickname: string,
    nowISO: string,
    idemKey: string,
  ): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      // 仅 admin/system 代注册：防止任意玩家抢注他人 username（docs/chaincode-api.md §2.1）
      requireRole(ctx, 'admin', 'system');
      requireNonEmpty(playerId, 'playerId');
      requireNonEmpty(nickname, 'nickname');
      assertISO(nowISO, 'nowISO');
      if (await exists(ctx, 'player', playerId)) {
        fail('PLAYER_EXISTS', `player ${playerId} already registered`);
      }
      const player: Player = {
        docType: 'player',
        playerId,
        mspId: getMspId(ctx),
        nickname,
        role: 'player',
        points: INITIAL_POINTS,
        wins: 0,
        losses: 0,
        rating: RATING_DEFAULT,
        createdAt: nowISO,
        transferLockUntil: new Date(Date.parse(nowISO) + TRANSFER_LOCK_MS).toISOString(),
      };
      await savePlayer(ctx, player);
      emit(ctx, 'PlayerRegistered', { playerId, mspId: player.mspId, nickname });
      return JSON.stringify(player);
    });
  }

  @Transaction()
  public async GrantRole(
    ctx: Context,
    playerId: string,
    role: string,
    nowISO: string,
    idemKey: string,
  ): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireRole(ctx, 'admin');
      requireNonEmpty(playerId, 'playerId');
      if (!ROLES.includes(role as never)) {
        fail('INVALID_PARAM', `role must be one of ${ROLES.join('|')}, got "${role}"`);
      }
      assertISO(nowISO, 'nowISO');
      const player = await loadPlayer(ctx, playerId);
      player.role = role;
      await savePlayer(ctx, player);
      emit(ctx, 'RoleGranted', { playerId, role });
      return JSON.stringify(player);
    });
  }

  @Transaction(false)
  @Returns('string')
  public async GetPlayer(ctx: Context, playerId: string): Promise<string> {
    return JSON.stringify(await loadPlayer(ctx, playerId));
  }

  @Transaction()
  public async AddPoints(
    ctx: Context,
    playerId: string,
    delta: string,
    reason: string,
    nowISO: string,
    idemKey: string,
  ): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireRole(ctx, 'admin', 'system');
      requireNonEmpty(playerId, 'playerId');
      requireNonEmpty(reason, 'reason');
      assertISO(nowISO, 'nowISO');
      const d = safeInt(delta, 'delta', { min: Number.MIN_SAFE_INTEGER });
      const player = await loadPlayer(ctx, playerId);
      if (d >= 0) {
        creditPoints(player, d);
      } else {
        debitPoints(player, -d);
      }
      await savePlayer(ctx, player);
      emit(ctx, 'PointsChanged', { playerId, delta: d, balance: player.points, reason });
      return JSON.stringify(player);
    });
  }

  @Transaction()
  public async TransferPoints(
    ctx: Context,
    fromId: string,
    toId: string,
    amount: string,
    nowISO: string,
    idemKey: string,
  ): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireNonEmpty(fromId, 'fromId');
      requireNonEmpty(toId, 'toId');
      assertISO(nowISO, 'nowISO');
      const value = safeInt(amount, 'amount', { min: 1 });
      const from = await loadPlayer(ctx, fromId);
      assertCallerIsPlayer(ctx, from);
      assertTransferUnlocked(from, nowISO);
      const to = await loadPlayer(ctx, toId);
      debitPoints(from, value);
      creditPoints(to, value);
      await savePlayer(ctx, from);
      await savePlayer(ctx, to);
      emit(ctx, 'PointsChanged', { fromId, toId, amount: value, reason: 'transfer' });
      return JSON.stringify({ fromId, toId, amount: value, fromBalance: from.points, toBalance: to.points });
    });
  }

  /**
   * 解除 72h 转账锁（H10）：admin/system 专用。seed 用它解锁演示账号；
   * 正常注册用户不接受此入口的公开调用（后端不暴露 HTTP API）。
   */
  @Transaction()
  public async ClearTransferLock(
    ctx: Context,
    playerId: string,
    nowISO: string,
    idemKey: string,
  ): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireRole(ctx, 'admin', 'system');
      requireNonEmpty(playerId, 'playerId');
      assertISO(nowISO, 'nowISO');
      const player = await loadPlayer(ctx, playerId);
      player.transferLockUntil = '';
      await savePlayer(ctx, player);
      emit(ctx, 'TransferLockCleared', { playerId });
      return JSON.stringify(player);
    });
  }

  /** 排位分（docs/chaincode-api.md §2.1）：仅 system，0-99999，事件 RatingChanged。 */
  @Transaction()
  public async UpdateRating(
    ctx: Context,
    playerId: string,
    newRating: string,
    reason: string,
    nowISO: string,
    idemKey: string,
  ): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireRole(ctx, 'system');
      requireNonEmpty(playerId, 'playerId');
      requireNonEmpty(reason, 'reason');
      assertISO(nowISO, 'nowISO');
      const rating = safeInt(newRating, 'newRating', { min: 0, max: RATING_MAX });
      const player = await loadPlayer(ctx, playerId);
      const previous = player.rating;
      player.rating = rating;
      await savePlayer(ctx, player);
      emit(ctx, 'RatingChanged', { playerId, rating, previous, reason });
      return JSON.stringify(player);
    });
  }
}
