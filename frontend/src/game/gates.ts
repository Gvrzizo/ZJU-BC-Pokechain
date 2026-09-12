import { itemName } from '@/composables/useI18n';
import { LEGENDARY_KEYS, type MapId } from './maps';

/**
 * 传说区门口的钥匙校验：
 * - 钥匙是**非消耗品**（商店 `typeId`：sky-key / ocean-key / magma-key / ruins-key / island-key / birth-key）；
 * - 未持有钥匙时弹对话拦住（告诉玩家钥匙名与购买地点）；
 * - **记忆通行**：成功进入过一次后本机记住（localStorage），之后即使背包查询失败也放行。
 *
 * 抽成纯模块（storage 可注入），便于单测覆盖「有钥匙 / 没钥匙 / 已记忆」三条路径。
 */

export const PASSAGE_STORAGE_PREFIX = 'pokechain.world.pass:';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

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

export function hasPassage(mapId: MapId, storage: KeyValueStorage | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(PASSAGE_STORAGE_PREFIX + mapId) === '1';
  } catch {
    return false;
  }
}

export function rememberPassage(mapId: MapId, storage: KeyValueStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(PASSAGE_STORAGE_PREFIX + mapId, '1');
  } catch {
    /* 存不进去不影响本次进入 */
  }
}

export function forgetPassages(storage: KeyValueStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    for (const mapId of Object.values(LEGENDARY_KEYS).flatMap((k) => k.maps)) {
      storage.setItem(PASSAGE_STORAGE_PREFIX + mapId, '0');
    }
  } catch {
    /* ignore */
  }
}

export type KeyGateStatus = 'pass' | 'granted' | 'locked';

/**
 * 判定能否进入 `targetMapId`：
 * - 不需要钥匙 → `pass`
 * - 本机已记忆通行 → `pass`
 * - 背包持有钥匙 → `granted`（调用方随后 `rememberPassage`）
 * - 否则 → `locked`（弹 `missingKeyLines` 的对话）
 */
export function keyGateStatus(
  targetMapId: MapId,
  ownedTypeIds: Iterable<string>,
  storage: KeyValueStorage | null = defaultStorage(),
): KeyGateStatus {
  const key = keyForMap(targetMapId);
  if (!key) return 'pass';
  if (hasPassage(targetMapId, storage)) return 'pass';
  for (const typeId of ownedTypeIds) {
    if (typeId === key.typeId) return 'granted';
  }
  return 'locked';
}

/** 被拦住时的对话（明确写出钥匙名与购买地点） */
export function missingKeyLines(keyName: string): string[] {
  return [
    `需要 ${keyName} 才能进入。`,
    `钥匙可以在未白镇的「道具店」购买（非消耗品，买一次就够，价格见货架）。`,
  ];
}
