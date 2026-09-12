export interface ItemTypeDef {
  typeId: string;
  name: string;
  nameZh: string;
  kind: 'ball' | 'potion' | 'stone' | 'tm' | 'other' | 'key';
  /** capture ball multiplier */
  ballBonus?: number;
  /** potion heal amount (off-chain battle convenience) */
  healAmount?: number;
  /** tm -> move id taught */
  teachesMove?: string;
  uri: string;
}

const I = (
  typeId: string,
  name: string,
  nameZh: string,
  kind: ItemTypeDef['kind'],
  extra: Partial<ItemTypeDef> = {},
): ItemTypeDef => ({ typeId, name, nameZh, kind, uri: `minio://assets/items/${typeId}.png`, ...extra });

export const ITEM_TYPES: Record<string, ItemTypeDef> = Object.fromEntries(
  [
    I('poke-ball', 'Poké Ball', '精灵球', 'ball', { ballBonus: 1 }),
    I('great-ball', 'Great Ball', '超级球', 'ball', { ballBonus: 1.5 }),
    I('ultra-ball', 'Ultra Ball', '高级球', 'ball', { ballBonus: 2 }),
    I('master-ball', 'Master Ball', '大师球', 'ball', { ballBonus: 255 }),
    I('potion', 'Potion', '伤药', 'potion', { healAmount: 20 }),
    I('super-potion', 'Super Potion', '好伤药', 'potion', { healAmount: 50 }),
    I('thunder-stone', 'Thunder Stone', '雷之石', 'stone'),
    I('water-stone', 'Water Stone', '水之石', 'stone'),
    I('fire-stone', 'Fire Stone', '火之石', 'stone'),
    I('tm-thunderbolt', 'TM Thunderbolt', '十万伏特技能机', 'tm', { teachesMove: 'thunderbolt' }),
    I('tm-flamethrower', 'TM Flamethrower', '喷射火焰技能机', 'tm', { teachesMove: 'flamethrower' }),
    I('tm-surf', 'TM Surf', '冲浪技能机', 'tm', { teachesMove: 'surf' }),
    // 培养类道具（商店有售/战斗掉落；使用效果由道具模块定义，这里只登记类型）
    I('bottle-cap', 'Bottle Cap', '银色王冠', 'other'),
    I('gold-bottle-cap', 'Gold Bottle Cap', '金色王冠', 'other'),
    I('rare-candy', 'Rare Candy', '神奇糖果', 'other'),
    // 传说区钥匙（kind='key'）：**非消耗品**，只用于通过 capture 的进入校验；
    // 不可使用（POST /items/:id/use → NOT_USABLE）、不可回收（shop 卖出 → NOT_SELLABLE，见 shop.data.ts）
    I('sky-key', 'Sky Key', '天空之钥', 'key'),
    I('ocean-key', 'Ocean Key', '海洋之钥', 'key'),
    I('magma-key', 'Magma Key', '熔岩之钥', 'key'),
    I('ruins-key', 'Ruins Key', '遗迹之钥', 'key'),
    I('island-key', 'Island Key', '岛之钥', 'key'),
    I('birth-key', 'Birth Island Ticket', '诞生岛船票', 'key'),
  ].map((i) => [i.typeId, i]),
);

export function getItemType(typeId: string): ItemTypeDef | undefined {
  return ITEM_TYPES[typeId];
}
