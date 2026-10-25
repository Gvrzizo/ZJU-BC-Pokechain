import { itemName } from '@/composables/useI18n';
import { LEGENDARY_KEYS, type MapId } from './maps';

/**
 * 传说区门口的钥匙校验：
 * - 钥匙是**一次性消耗品**（商店 `typeId`：sky-key / ocean-key / magma-key / ruins-key / island-key / birth-key），
 *   进入时只校验持有；真正扣除发生在 `POST /capture/encounter` 创建传说区遇敌时（H11）。
 * - 未持有钥匙时弹对话拦住（告诉玩家钥匙名与购买地点）。
 * - **不记忆通行**：钥匙用掉后必须重新购买，门口每次进入都重新校验背包。
 */

export interface LegendaryKeyDef {
  typeId: string;
  name: string;
}

/** 某张传说区地图的入场钥匙（非传说区返回 undefined） */
export function keyForMap(mapId: MapId): LegendaryKeyDef | undefined {
  for (const [typeId, def] of Object.entries(LEGENDARY_KEYS)) {
    if (def.maps.includes(mapId)) return { typeId, name: def.name };
  }
  return undefined;
}

/** 道具 id → 钥匙显示名（非钥匙返回 undefined）；名称优先取 i18n 词条，缺词条时用内置兜底名 */
export function keyName(typeId: string): string | undefined {
  const def = LEGENDARY_KEYS[typeId];
  if (!def) return undefined;
  const localized = itemName(typeId);
  return localized === typeId ? def.name : localized;
}

export type KeyGateStatus = 'pass' | 'granted' | 'locked';

/**
 * 判定能否进入 `targetMapId`：
 * - 不需要钥匙 → `pass`
 * - 背包持有钥匙 → `granted`（进门只校验持有；钥匙在创建遇敌时消耗）
 * - 否则 → `locked`（弹 `missingKeyLines` 的对话）
 */
export function keyGateStatus(targetMapId: MapId, ownedTypeIds: Iterable<string>): KeyGateStatus {
  const key = keyForMap(targetMapId);
  if (!key) return 'pass';
  for (const typeId of ownedTypeIds) {
    if (typeId === key.typeId) return 'granted';
  }
  return 'locked';
}

/** 被拦住时的对话（明确写出钥匙名与购买地点） */
export function missingKeyLines(keyName: string): string[] {
  return [
    `需要 ${keyName} 才能进入。`,
    `钥匙可以在未白镇的「道具店」购买（一次性：创建一次传说区遇敌消耗 1 把）。`,
  ];
}
