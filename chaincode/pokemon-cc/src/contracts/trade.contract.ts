import { Context, Contract, Returns, Transaction } from 'fabric-contract-api';
import { assertISO, fail, requireNonEmpty } from '../common/assert';
import { parseBundle, validateBundleAssets } from '../common/bundle';
import { canonicalJson, sha256hex } from '../common/crypto';
import { withIdempotency } from '../common/idempotency';
import { AssetBundle, BOND_RESET_ON_TRANSFER, Trade } from '../common/model';
import { collectQuery, selectorQuery } from '../common/query';
import {
  assertCallerIsPlayer,
  emit,
  exists,
  loadItem,
  loadPlayer,
  loadPokemon,
  loadTrade,
  saveItem,
  savePlayer,
  savePokemon,
  saveTrade,
} from '../common/state';

export function manifestHashOf(fromId: string, toId: string, offer: AssetBundle, request: AssetBundle): string {
  return sha256hex(canonicalJson({ fromId, toId, offer, request }));
}

async function unlockTradeAssets(ctx: Context, trade: Trade): Promise<void> {
  for (const pid of [...trade.offer.pokemonIds, ...trade.request.pokemonIds]) {
    const p = await loadPokemon(ctx, pid);
    if (p.status === 'LOCKED_TRADE' && p.lockRef === trade.id) {
      p.status = 'IDLE';
      p.lockRef = '';
      await savePokemon(ctx, p);
    }
  }
  for (const iid of [...trade.offer.itemIds, ...trade.request.itemIds]) {
    const i = await loadItem(ctx, iid);
    if (i.status === 'LOCKED_TRADE' && i.lockRef === trade.id) {
      i.status = 'IDLE';
      i.lockRef = '';
      await saveItem(ctx, i);
    }
  }
}

/**
 * 双方确认后的原子执行：交换宝可梦/道具 owner、划转积分
 * （from 收 request.points、付 offer.points）。任何校验失败整体抛错回滚。
 */
async function executeTrade(ctx: Context, trade: Trade): Promise<void> {
  const from = await loadPlayer(ctx, trade.fromId);
  const to = await loadPlayer(ctx, trade.toId);
  if (from.points < trade.offer.points) {
    fail('INSUFFICIENT_POINTS', `from ${trade.fromId} has ${from.points}, needs ${trade.offer.points}`);
  }
  if (to.points < trade.request.points) {
    fail('INSUFFICIENT_POINTS', `to ${trade.toId} has ${to.points}, needs ${trade.request.points}`);
  }
  for (const pid of trade.offer.pokemonIds) {
    const p = await loadPokemon(ctx, pid);
    if (p.status !== 'LOCKED_TRADE' || p.lockRef !== trade.id || p.ownerId !== trade.fromId) {
      fail('BAD_STATE', `pokemon ${pid} is not locked by trade ${trade.id}`);
    }
    if (p.ownerId !== trade.toId) {
      p.bond = BOND_RESET_ON_TRANSFER;
    }
    p.ownerId = trade.toId;
    p.status = 'IDLE';
    p.lockRef = '';
    await savePokemon(ctx, p);
  }
  for (const pid of trade.request.pokemonIds) {
    const p = await loadPokemon(ctx, pid);
    if (p.status !== 'LOCKED_TRADE' || p.lockRef !== trade.id || p.ownerId !== trade.toId) {
      fail('BAD_STATE', `pokemon ${pid} is not locked by trade ${trade.id}`);
    }
    if (p.ownerId !== trade.fromId) {
      p.bond = BOND_RESET_ON_TRANSFER;
    }
    p.ownerId = trade.fromId;
    p.status = 'IDLE';
    p.lockRef = '';
    await savePokemon(ctx, p);
  }
  for (const iid of trade.offer.itemIds) {
    const i = await loadItem(ctx, iid);
    if (i.status !== 'LOCKED_TRADE' || i.lockRef !== trade.id || i.ownerId !== trade.fromId) {
      fail('BAD_STATE', `item ${iid} is not locked by trade ${trade.id}`);
    }
    i.ownerId = trade.toId;
    i.status = 'IDLE';
    i.lockRef = '';
    await saveItem(ctx, i);
  }
  for (const iid of trade.request.itemIds) {
    const i = await loadItem(ctx, iid);
    if (i.status !== 'LOCKED_TRADE' || i.lockRef !== trade.id || i.ownerId !== trade.toId) {
      fail('BAD_STATE', `item ${iid} is not locked by trade ${trade.id}`);
    }
    i.ownerId = trade.fromId;
    i.status = 'IDLE';
    i.lockRef = '';
    await saveItem(ctx, i);
  }
  from.points -= trade.offer.points;
  to.points += trade.offer.points;
  to.points -= trade.request.points;
  from.points += trade.request.points;
  if (!Number.isSafeInteger(from.points) || !Number.isSafeInteger(to.points)) {
    fail('OVERFLOW', 'points overflow during trade execution');
  }
  await savePlayer(ctx, from);
  await savePlayer(ctx, to);
}

export class TradeContract extends Contract {
  constructor() {
    super('TradeContract');
  }

  @Transaction()
  public async CreateTrade(
    ctx: Context,
    id: string,
    fromId: string,
    toId: string,
    offerJSON: string,
    requestJSON: string,
    expiresAt: string,
    nowISO: string,
    idemKey: string,
  ): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireNonEmpty(id, 'id');
      assertISO(nowISO, 'nowISO');
      assertISO(expiresAt, 'expiresAt');
      if (nowISO >= expiresAt) {
        fail('TRADE_EXPIRED', 'expiresAt must be later than nowISO');
      }
      if (await exists(ctx, 'trade', id)) {
        fail('TRADE_EXISTS', `trade ${id} already exists`);
      }
      const from = await loadPlayer(ctx, fromId);
      const to = await loadPlayer(ctx, toId);
      assertCallerIsPlayer(ctx, from);
      const offer = parseBundle(offerJSON, 'offer');
      const request = parseBundle(requestJSON, 'request');
      const allPoke = [...offer.pokemonIds, ...request.pokemonIds];
      const allItems = [...offer.itemIds, ...request.itemIds];
      if (new Set(allPoke).size !== allPoke.length || new Set(allItems).size !== allItems.length) {
        fail('INVALID_PARAM', 'the same asset cannot appear on both sides of a trade');
      }
      const offerAssets = await validateBundleAssets(ctx, offer, fromId, 'offer');
      const requestAssets = await validateBundleAssets(ctx, request, toId, 'request');
      if (from.points < offer.points) {
        fail('INSUFFICIENT_POINTS', `from ${fromId} has ${from.points}, needs ${offer.points}`);
      }
      if (to.points < request.points) {
        fail('INSUFFICIENT_POINTS', `to ${toId} has ${to.points}, needs ${request.points}`);
      }
      // 锁定全部资产；积分不动，仅在执行时划转
      for (const p of [...offerAssets.pokemons, ...requestAssets.pokemons]) {
        p.status = 'LOCKED_TRADE';
        p.lockRef = id;
        await savePokemon(ctx, p);
      }
      for (const i of [...offerAssets.items, ...requestAssets.items]) {
        i.status = 'LOCKED_TRADE';
        i.lockRef = id;
        await saveItem(ctx, i);
      }
      const trade: Trade = {
        docType: 'trade',
        id,
        fromId,
        toId,
        offer,
        request,
        manifestHash: manifestHashOf(fromId, toId, offer, request),
        confirmations: { from: false, to: false },
        status: 'OPEN',
        createdAt: nowISO,
        expiresAt,
      };
      await saveTrade(ctx, trade);
      emit(ctx, 'TradeCreated', { id, fromId, toId, manifestHash: trade.manifestHash });
      return JSON.stringify(trade);
    });
  }

  @Transaction()
  public async ConfirmTrade(ctx: Context, id: string, playerId: string, nowISO: string, idemKey: string): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireNonEmpty(id, 'id');
      assertISO(nowISO, 'nowISO');
      const trade = await loadTrade(ctx, id);
      if (trade.status !== 'OPEN') {
        fail('TRADE_NOT_OPEN', `trade ${id} is ${trade.status}`);
      }
      if (playerId !== trade.fromId && playerId !== trade.toId) {
        fail('NOT_PARTY', `player ${playerId} is not a party of trade ${id}`);
      }
      const player = await loadPlayer(ctx, playerId);
      assertCallerIsPlayer(ctx, player);
      if (nowISO >= trade.expiresAt) {
        // 已过期：转入 EXPIRED 并解锁（不产生执行）
        await unlockTradeAssets(ctx, trade);
        trade.status = 'EXPIRED';
        await saveTrade(ctx, trade);
        emit(ctx, 'TradeExpired', { id });
        return JSON.stringify(trade);
      }
      const side = playerId === trade.fromId ? 'from' : 'to';
      trade.confirmations[side] = true;
      emit(ctx, 'TradeConfirmed', { id, side, playerId });
      if (trade.confirmations.from && trade.confirmations.to) {
        await executeTrade(ctx, trade);
        trade.status = 'EXECUTED';
        emit(ctx, 'TradeExecuted', { id, fromId: trade.fromId, toId: trade.toId });
      }
      await saveTrade(ctx, trade);
      return JSON.stringify(trade);
    });
  }

  @Transaction()
  public async CancelTrade(ctx: Context, id: string, playerId: string, nowISO: string, idemKey: string): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireNonEmpty(id, 'id');
      assertISO(nowISO, 'nowISO');
      const trade = await loadTrade(ctx, id);
      if (trade.status !== 'OPEN') {
        fail('TRADE_NOT_OPEN', `trade ${id} is ${trade.status}`);
      }
      if (playerId !== trade.fromId && playerId !== trade.toId) {
        fail('NOT_PARTY', `player ${playerId} is not a party of trade ${id}`);
      }
      const player = await loadPlayer(ctx, playerId);
      assertCallerIsPlayer(ctx, player);
      await unlockTradeAssets(ctx, trade);
      trade.status = 'CANCELLED';
      await saveTrade(ctx, trade);
      emit(ctx, 'TradeCancelled', { id, by: playerId });
      return JSON.stringify(trade);
    });
  }

  @Transaction()
  public async ExpireTrade(ctx: Context, id: string, nowISO: string, idemKey: string): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireNonEmpty(id, 'id');
      assertISO(nowISO, 'nowISO');
      const trade = await loadTrade(ctx, id);
      if (trade.status !== 'OPEN') {
        fail('TRADE_NOT_OPEN', `trade ${id} is ${trade.status}`);
      }
      if (nowISO < trade.expiresAt) {
        fail('TRADE_NOT_EXPIRED', `trade ${id} expires at ${trade.expiresAt}, now is ${nowISO}`);
      }
      await unlockTradeAssets(ctx, trade);
      trade.status = 'EXPIRED';
      await saveTrade(ctx, trade);
      emit(ctx, 'TradeExpired', { id });
      return JSON.stringify(trade);
    });
  }

  @Transaction(false)
  @Returns('string')
  public async GetTrade(ctx: Context, id: string): Promise<string> {
    return JSON.stringify(await loadTrade(ctx, id));
  }

  @Transaction(false)
  @Returns('string')
  public async QueryByPlayer(ctx: Context, playerId: string): Promise<string> {
    requireNonEmpty(playerId, 'playerId');
    const list = await collectQuery(
      ctx,
      selectorQuery({ docType: 'trade', $or: [{ fromId: playerId }, { toId: playerId }] }),
    );
    return JSON.stringify(list);
  }
}
