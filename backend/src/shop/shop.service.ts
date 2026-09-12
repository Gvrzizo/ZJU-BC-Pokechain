import { randomUUID } from 'crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { sha256hex } from '../common/utils/crypto.util';
import { AppException } from '../common/utils/errors';
import { ContractService } from '../fabric/contract.service';
import { ChainIdentity, ItemState, SYSTEM_IDENTITY } from '../fabric/chain.types';
import { getItemType } from '../game-data/items.data';
import { SHOP_MAX_QTY, sellableItem, shopCatalog, shopPrice } from './shop.data';

/** 链上错误的对外 HTTP 语义（链上错误本身只有 code；未收录的原样抛出 → 500 + code）。 */
const CHAIN_ERROR_STATUS: Readonly<Record<string, HttpStatus>> = {
  INSUFFICIENT_POINTS: HttpStatus.BAD_REQUEST,
  INSUFFICIENT_QUANTITY: HttpStatus.CONFLICT,
  ASSET_LOCKED: HttpStatus.CONFLICT,
  NOT_OWNER: HttpStatus.FORBIDDEN,
  ITEM_NOT_FOUND: HttpStatus.NOT_FOUND,
};

/**
 * 道具商店（docs/backend-api.md §3「道具获取途径」）：积分 ↔ 道具的双向闭环。
 *
 * - 购买：`AddPoints(-total, 'shop:buy')` + `MintItem`（同 typeId 由链上自动合并堆叠）
 * - 卖出：`ConsumeItem(qty, 'shop:sell')` + `AddPoints(+refund, 'shop:sell')`（半价回收）
 *
 * 两笔链上交易共用同一个客户端幂等键派生的 idemKey：中途失败后客户端重放同一请求，
 * 已成功的那一笔直接返回首次结果，不会重复扣分/发货/销毁。因此余额/堆叠数量/锁定状态
 * 一律**以链上校验为准**（链上 idemKey 命中会先于一切校验返回首次结果），
 * 链下只做与幂等无关的静态校验（商品是否在售、道具归属与类型）。
 */
@Injectable()
export class ShopService {
  constructor(private readonly contract: ContractService) {}

  /** 链上错误 → 对外约定的 HTTP 状态；未收录的错误原样抛出。 */
  private chainError(err: unknown): Error {
    const code = (err as { code?: string })?.code ?? '';
    const status = CHAIN_ERROR_STATUS[code];
    if (status === undefined) return err as Error;
    return new AppException(code, (err as Error)?.message ?? String(err), status);
  }

  /** 商品表 + 我的积分（前端商店页一次拉全）。 */
  async catalog(playerId: string) {
    const player = await this.contract.getPlayer(playerId);
    return {
      points: player.points,
      maxQty: SHOP_MAX_QTY,
      items: shopCatalog(),
    };
  }

  async buy(as: ChainIdentity, typeId: string, qty: number, idemKey?: string) {
    const price = shopPrice(typeId);
    const type = getItemType(typeId);
    if (price === undefined || !type) {
      throw new AppException('NOT_FOR_SALE', `${typeId} is not sold in the shop`, HttpStatus.BAD_REQUEST);
    }
    const total = price * qty;
    const purchaseId = idemKey ?? randomUUID();
    try {
      await this.contract.addPoints(SYSTEM_IDENTITY, as.userId, -total, 'shop:buy', {
        idemKey: `shop-buy-${as.userId}-${purchaseId}`,
      });
    } catch (err) {
      throw this.chainError(err);
    }
    const item = await this.contract.mintItem(
      SYSTEM_IDENTITY,
      {
        id: `i_${randomUUID()}`,
        playerId: as.userId,
        typeId,
        quantity: qty,
        uri: type.uri,
        metadataHash: sha256hex(`${typeId}|shop-buy`),
      },
      { idemKey: `shop-buy-${as.userId}-${purchaseId}-item` },
    );
    const updated = await this.contract.getPlayer(as.userId);
    return {
      typeId,
      name: type.name,
      nameZh: type.nameZh,
      quantity: qty,
      unitPrice: price,
      total,
      points: updated.points,
      item,
    };
  }

  async sell(as: ChainIdentity, itemId: string, qty: number, idemKey?: string) {
    const item = await this.contract.getItem(itemId).catch(() => null);
    if (!item) {
      throw new AppException('ITEM_NOT_FOUND', `item ${itemId} does not exist`, HttpStatus.NOT_FOUND);
    }
    if (item.ownerId !== as.userId) {
      throw new AppException('NOT_OWNER', `item ${itemId} is not yours`, HttpStatus.FORBIDDEN);
    }
    const type = sellableItem(item.typeId);
    if (!type) {
      throw new AppException('NOT_SELLABLE', `${item.typeId} is not bought back by the shop`, HttpStatus.BAD_REQUEST);
    }

    const refund = type.unitPrice * qty;
    const saleId = idemKey ?? randomUUID();
    let consumed: ItemState;
    try {
      // 锁定状态与堆叠数量由链上校验（幂等键命中时直接返回首次结果，不会被"已减量"误判）
      consumed = await this.contract.consumeItem(as, itemId, qty, 'shop:sell', {
        idemKey: `shop-sell-${as.userId}-${saleId}`,
      });
    } catch (err) {
      throw this.chainError(err);
    }
    await this.contract.addPoints(SYSTEM_IDENTITY, as.userId, refund, 'shop:sell', {
      idemKey: `shop-sell-${as.userId}-${saleId}-points`,
    });
    const updated = await this.contract.getPlayer(as.userId);
    return {
      itemId,
      typeId: item.typeId,
      name: type.name,
      nameZh: type.nameZh,
      quantity: qty,
      unitPrice: type.unitPrice,
      refund,
      points: updated.points,
      item: consumed,
    };
  }
}
