import { Context, Contract, Returns, Transaction } from 'fabric-contract-api';
import { assertIdle, assertISO, fail, requireHex64, requireNonEmpty, safeInt } from '../common/assert';
import { getRole, requireRole } from '../common/cid';
import { withIdempotency } from '../common/idempotency';
import { Item } from '../common/model';
import { collectQuery, selectorQuery } from '../common/query';
import { assertCallerIsPlayer, emit, exists, loadItem, loadPlayer, saveItem } from '../common/state';
import { mergeIdleStacks } from '../common/stacks';

export class ItemContract extends Contract {
  constructor() {
    super('ItemContract');
  }

  @Transaction()
  public async MintItem(
    ctx: Context,
    id: string,
    playerId: string,
    typeId: string,
    quantity: string,
    uri: string,
    metadataHash: string,
    nowISO: string,
    idemKey: string,
  ): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireRole(ctx, 'admin', 'system');
      requireNonEmpty(id, 'id');
      requireNonEmpty(typeId, 'typeId');
      requireNonEmpty(uri, 'uri');
      requireHex64(metadataHash, 'metadataHash');
      assertISO(nowISO, 'nowISO');
      const qty = safeInt(quantity, 'quantity', { min: 1 });
      await loadPlayer(ctx, playerId);
      if (await exists(ctx, 'item', id)) {
        fail('ITEM_EXISTS', `item ${id} already exists`);
      }
      const item: Item = {
        docType: 'item',
        id,
        typeId,
        ownerId: playerId,
        quantity: qty,
        uri,
        metadataHash: metadataHash.toLowerCase(),
        status: 'IDLE',
        lockRef: '',
        createdAt: nowISO,
      };
      await saveItem(ctx, item);
      emit(ctx, 'ItemMinted', { id, typeId, ownerId: playerId, quantity: qty });
      // 铸造后自动归一：同 owner+typeId 的 IDLE 堆叠合并到最早创建的那个（本交易新建的堆叠经 extraIds 补充）
      const stack = await mergeIdleStacks(ctx, playerId, typeId, [id]);
      return JSON.stringify(stack ?? item);
    });
  }

  /**
   * 显式合并同一 owner 名下同 typeId 的所有 IDLE 堆叠（数量累加到最早创建的堆叠）。
   * 仅 owner 本人或 system 可调用；无可合并堆叠时返回 null。
   */
  @Transaction()
  public async MergeStacks(ctx: Context, ownerId: string, typeId: string, nowISO: string, idemKey: string): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireNonEmpty(ownerId, 'ownerId');
      requireNonEmpty(typeId, 'typeId');
      assertISO(nowISO, 'nowISO');
      const owner = await loadPlayer(ctx, ownerId);
      if (getRole(ctx) !== 'system') {
        assertCallerIsPlayer(ctx, owner);
      }
      const stack = await mergeIdleStacks(ctx, ownerId, typeId);
      return JSON.stringify(stack);
    });
  }

  @Transaction()
  public async TransferItem(ctx: Context, id: string, toId: string, nowISO: string, idemKey: string): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireNonEmpty(id, 'id');
      requireNonEmpty(toId, 'toId');
      assertISO(nowISO, 'nowISO');
      const item = await loadItem(ctx, id);
      const owner = await loadPlayer(ctx, item.ownerId);
      assertCallerIsPlayer(ctx, owner);
      assertIdle(item.status, 'item', id);
      await loadPlayer(ctx, toId);
      item.ownerId = toId;
      await saveItem(ctx, item);
      emit(ctx, 'ItemTransferred', { id, fromId: owner.playerId, toId, quantity: item.quantity });
      return JSON.stringify(item);
    });
  }

  @Transaction()
  public async ConsumeItem(
    ctx: Context,
    id: string,
    quantity: string,
    reason: string,
    nowISO: string,
    idemKey: string,
  ): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireNonEmpty(id, 'id');
      requireNonEmpty(reason, 'reason');
      assertISO(nowISO, 'nowISO');
      const item = await loadItem(ctx, id);
      const owner = await loadPlayer(ctx, item.ownerId);
      if (getRole(ctx) !== 'system') {
        assertCallerIsPlayer(ctx, owner);
      }
      assertIdle(item.status, 'item', id);
      const qty = safeInt(quantity, 'quantity', { min: 1 });
      if (qty > item.quantity) {
        fail('INSUFFICIENT_QUANTITY', `item ${id} has ${item.quantity}, cannot consume ${qty}`);
      }
      item.quantity -= qty;
      await saveItem(ctx, item);
      emit(ctx, 'ItemConsumed', { id, ownerId: item.ownerId, consumed: qty, remaining: item.quantity, reason });
      return JSON.stringify(item);
    });
  }

  @Transaction(false)
  @Returns('string')
  public async GetItem(ctx: Context, id: string): Promise<string> {
    return JSON.stringify(await loadItem(ctx, id));
  }

  @Transaction(false)
  @Returns('string')
  public async QueryByOwner(ctx: Context, ownerId: string): Promise<string> {
    requireNonEmpty(ownerId, 'ownerId');
    const list = await collectQuery(ctx, selectorQuery({ docType: 'item', ownerId }));
    return JSON.stringify(list);
  }
}
