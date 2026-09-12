import { Context } from 'fabric-contract-api';
import { checkedAmount } from './assert';
import { keyOf } from './keys';
import { Item } from './model';
import { collectQuery, selectorQuery } from './query';
import { deleteItem, emit, saveItem } from './state';

/** 子堆叠 id 规则：`<parentId>#w<battleId>`（部分数量押注拆分，docs/chaincode-api.md §1 Item）。 */
export function childStackId(parentId: string, battleId: string): string {
  return `${parentId}#w${battleId}`;
}

/** 子堆叠 id → 原堆叠 id；非子堆叠返回 ''。 */
export function parentStackIdOf(childId: string): string {
  const idx = childId.lastIndexOf('#w');
  return idx > 0 ? childId.slice(0, idx) : '';
}

/** 堆叠归一排序键：createdAt 升序（缺失视为 ''，最旧），同刻按 id 字典序。 */
function oldestFirst(a: Item, b: Item): number {
  const at = a.createdAt ?? '';
  const bt = b.createdAt ?? '';
  if (at !== bt) return at < bt ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/**
 * 同一 owner 名下同 typeId 的 IDLE 堆叠归一：数量累加到最早创建的堆叠，其余删除（docs/chaincode-api.md §2.4）。
 * - 富查询只读已提交状态、不含本交易写入，因此本交易内新建/改写的堆叠需经 extraIds 显式补充；
 *   候选 id 随后一律用 getState 重读，让本交易的写入/删除覆盖查询快照。
 * - 锁定（LOCKED_TRADE/LOCKED_BATTLE）或其他 owner/typeId 的堆叠不参与。
 * 返回幸存堆叠；无任何 IDLE 堆叠时返回 null。发生合并时发 `ItemMerged` 事件。
 */
export async function mergeIdleStacks(ctx: Context, ownerId: string, typeId: string, extraIds: string[] = []): Promise<Item | null> {
  const ids = new Set<string>((await collectQuery<Item>(ctx, selectorQuery({ docType: 'item', ownerId, typeId, status: 'IDLE' }))).map((r) => r.id));
  for (const id of extraIds) ids.add(id);

  const live: Item[] = [];
  for (const id of ids) {
    if (!id) continue;
    const data = await ctx.stub.getState(keyOf('item', id));
    if (!data || data.length === 0) continue; // 本交易内已删除
    const item = JSON.parse(data.toString()) as Item;
    if (item.docType !== 'item' || item.ownerId !== ownerId || item.typeId !== typeId || item.status !== 'IDLE') continue;
    live.push(item);
  }
  if (live.length === 0) return null;

  live.sort(oldestFirst);
  const survivor = live[0];
  if (live.length === 1) return survivor;

  let total = survivor.quantity;
  const merged: Array<{ id: string; quantity: number }> = [];
  for (const item of live.slice(1)) {
    total = checkedAmount(total + item.quantity, `merged quantity of ${typeId}`);
    merged.push({ id: item.id, quantity: item.quantity });
    await deleteItem(ctx, item.id);
  }
  survivor.quantity = total;
  await saveItem(ctx, survivor);
  emit(ctx, 'ItemMerged', { ownerId, typeId, id: survivor.id, quantity: total, merged });
  return survivor;
}
