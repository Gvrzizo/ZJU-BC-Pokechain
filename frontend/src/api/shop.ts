import { http } from './http';
import type { Item } from '@/types';

/** 商店商品项（GET /shop）：非卖品同样列出，available=false 且 price=null（如大师球） */
export interface ShopEntry {
  typeId: string;
  name: string;
  nameZh: string;
  kind: string;
  uri?: string;
  price: number | null;
  /** 回收价（购买价半价向下取整）；非卖品为 null */
  sellPrice: number | null;
  /** 库存标记：false = 非卖品（仅奖励获取） */
  available: boolean;
}

export interface ShopCatalog {
  /** 当前链上积分（与 GET /users/me 同源） */
  points: number;
  /** 单次买卖数量上限 */
  maxQty: number;
  items: ShopEntry[];
}

export interface BuyResult {
  typeId: string;
  name: string;
  nameZh: string;
  quantity: number;
  unitPrice: number;
  total: number;
  points: number;
  item: Item;
}

export interface SellResult {
  itemId: string;
  typeId: string;
  name: string;
  nameZh: string;
  quantity: number;
  unitPrice: number;
  refund: number;
  points: number;
  item: Item;
}

export async function getShop(): Promise<ShopCatalog> {
  const { data } = await http.get<ShopCatalog>('/shop');
  return data;
}

/** 购买：idemKey 由调用方固定时重试幂等（链上不会重复扣分/发货）。 */
export async function buyItem(
  typeId: string,
  qty: number,
  idemKey: string = crypto.randomUUID(),
): Promise<BuyResult> {
  const { data } = await http.post<BuyResult>('/shop/buy', { typeId, qty, idemKey });
  return data;
}

/** 卖出（半价回收）：idemKey 语义同上（ConsumeItem + AddPoints 成对幂等）。 */
export async function sellItem(
  itemId: string,
  qty: number,
  idemKey: string = crypto.randomUUID(),
): Promise<SellResult> {
  const { data } = await http.post<SellResult>('/shop/sell', { itemId, qty, idemKey });
  return data;
}
