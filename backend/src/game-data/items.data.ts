export interface ItemTypeDef {
  typeId: string;
  name: string;
  nameZh: string;
  kind: 'ball' | 'potion' | 'stone' | 'tm' | 'other';
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
  ].map((i) => [i.typeId, i]),
);

export function getItemType(typeId: string): ItemTypeDef | undefined {
  return ITEM_TYPES[typeId];
}
