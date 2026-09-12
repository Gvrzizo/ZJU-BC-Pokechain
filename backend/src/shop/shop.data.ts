import { getItemType, ITEM_TYPES } from '../game-data/items.data';

/**
 * 商店价目表（docs/backend-api.md §3「道具获取途径」），单位：积分。
 *
 * 2026-09 重定价：积分 faucet 收紧后（收服 20 / 击倒 等级×1 / 放生 等级×1），
 * 休闲玩家日收入约 100–300P（野怪 + 排位），价目按「日收入 ≈ 1-2 只精灵球」对齐：
 *   - 高级球 400 = 2-3 天积累（稀有消耗品）
 *   - 王冠 3000 / 金色王冠 15000 = 月级目标（个体值是长期养成的终点）
 * 回收仍是半价向下取整（卖回只回血，不构成 faucet）。
 *
 * 不在此表里的道具（如 master-ball，仅作为奖励发放）既不出售、也不回收：
 * 购买抛 `NOT_FOR_SALE`，卖出抛 `NOT_SELLABLE`。
 */
export const SHOP_PRICES: Readonly<Record<string, number>> = {
  'poke-ball': 50,
  'great-ball': 150,
  'ultra-ball': 400,
  potion: 50,
  'super-potion': 120,
  'thunder-stone': 800,
  'water-stone': 800,
  'fire-stone': 800,
  'tm-thunderbolt': 1500,
  'tm-flamethrower': 1500,
  'tm-surf': 1500,
  'bottle-cap': 3000,
  'gold-bottle-cap': 15000,
  'rare-candy': 1000,
};

/** 单次买/卖的数量上限：积分才是真正的约束，这里只挡误操作与整数溢出。 */
export const SHOP_MAX_QTY = 99;

/** 购买价；非卖品返回 undefined。 */
export function shopPrice(typeId: string): number | undefined {
  return SHOP_PRICES[typeId];
}

/** 回收价 = 半价向下取整（不足 1 取 1）；非卖品返回 undefined。 */
export function shopSellPrice(typeId: string): number | undefined {
  const price = SHOP_PRICES[typeId];
  return price === undefined ? undefined : Math.max(1, Math.floor(price / 2));
}

export interface ShopEntry {
  typeId: string;
  name: string;
  nameZh: string;
  kind: string;
  uri: string;
  /** 购买价；非卖品为 null */
  price: number | null;
  /** 回收价（半价）；非卖品为 null */
  sellPrice: number | null;
  /** 库存标记：false = 非卖品（仅奖励发放，如 master-ball） */
  available: boolean;
}

/** 商品表：覆盖全部道具类型，非卖品同样列出并标记 available=false。 */
export function shopCatalog(): ShopEntry[] {
  return Object.values(ITEM_TYPES).map((type) => {
    const price = shopPrice(type.typeId);
    return {
      typeId: type.typeId,
      name: type.name,
      nameZh: type.nameZh,
      kind: type.kind,
      uri: type.uri,
      price: price ?? null,
      sellPrice: shopSellPrice(type.typeId) ?? null,
      available: price !== undefined,
    };
  });
}

/** 卖出的道具类型必须同时有价目与类型定义（未知 typeId 一律拒绝回收）。 */
export function sellableItem(typeId: string): { name: string; nameZh: string; unitPrice: number } | null {
  const type = getItemType(typeId);
  const unitPrice = shopSellPrice(typeId);
  if (!type || unitPrice === undefined) return null;
  return { name: type.name, nameZh: type.nameZh, unitPrice };
}
