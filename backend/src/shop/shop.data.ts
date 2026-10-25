import { getItemType, ITEM_TYPES } from '../game-data/items.data';

/**
 * 商店价目表（docs/backend-api.md §3「道具获取途径」），单位：积分。
 *
 * 2026-09 重定价 + 2026-10 P2 回调（H13）：
 *   - 高级球 400 = 1-2 天积累（稀有消耗品）
 *   - 银色王冠 1200 / 金色王冠 6000 = 周/月级目标（个体值是长期养成的终点，别让月级目标失去吸引力）
 *   - TM 800（原 1500：360 个野生种里约 88% 已有 ≥90 威力招式，高价 TM 缺乏决策价值）
 * 回收仍是半价向下取整（卖回只回血，不构成 faucet）。
 *
 * 不在此表里的道具（如 master-ball，仅作为奖励发放）既不出售、也不回收：
 * 购买抛 `NOT_FOR_SALE`，卖出抛 `NOT_SELLABLE`。
 *
 * 传说区钥匙（kind='key'，2026-09；2026-10 H11 改为一次性）：**上架但不回收**——每把 1500P
 * 换**一次**传说区遇敌机会（`POST /capture/encounter` 时消耗 1 把），定价按"数日积累"而非月级目标；
 * 回收价会凭空造出积分 faucet（钥匙已被消耗掉），回收排除见 `shopSellPrice`。
 *
 * 跑鞋（`running-shoes`）：**既不上架也不回收**——它只由起始镇「妈妈」赠送
 * （POST /users/me/running-shoes，一次性幂等），既不是 sink 也不该被回收换成积分。
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
  'tm-thunderbolt': 800,
  'tm-flamethrower': 800,
  'tm-surf': 800,
  'bottle-cap': 1200,
  'gold-bottle-cap': 6000,
  'rare-candy': 1000,
  // 传说区钥匙（天空之柱 / 海底洞窟 / 熔岩洞窟 / 古代遗迹 / 南方孤岛 / 诞生之岛）：
  // 一次性门票（H11），每把只够创建一次传说区遇敌
  'sky-key': 1500,
  'ocean-key': 1500,
  'magma-key': 1500,
  'ruins-key': 1500,
  'island-key': 1500,
  'birth-key': 1500,
};

/** 单次买/卖的数量上限：积分才是真正的约束，这里只挡误操作与整数溢出。 */
export const SHOP_MAX_QTY = 99;

/** 购买价；非卖品返回 undefined。 */
export function shopPrice(typeId: string): number | undefined {
  return SHOP_PRICES[typeId];
}

/**
 * 回收价 = 半价向下取整（不足 1 取 1）；非卖品返回 undefined。
 * **钥匙（kind='key'）一律不可回收**（返回 undefined → 卖出抛 `NOT_SELLABLE`）：
 * 钥匙已在创建传说区遇敌时被消耗，回收会让"买钥匙 → 卖回"变成免手续费往返。
 */
export function shopSellPrice(typeId: string): number | undefined {
  if (getItemType(typeId)?.kind === 'key') return undefined;
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
