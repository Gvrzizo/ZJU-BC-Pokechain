import type { Item, Pokemon, WagerBundle, WagerItemRef, WagerRequest } from '@/types';
import { isFainted } from '@/utils/pokemon-hp';

/**
 * 押注清单与当前背包的对齐（WagerPicker 载入模板 / 复用旧清单时用）：
 * 模板保存的是"当时的资产 id"，资产可能已经消耗、卖出或被押注锁定——
 * 载入时逐项过滤，数量夹到当前持有量，剩下的交给服务端权威校验。
 *
 * 伤势持久化（docs/backend-api.md §2）：**濒死的宝可梦不能出战**，同样按"不在背包"剔除
 * （队伍提交会被服务端 FAINTED 拒绝，这里提前过滤并计入 dropped）。
 */
export function clampWagerToInventory(
  wager: WagerBundle | WagerRequest | null | undefined,
  pokemon: Pick<Pokemon, 'id' | 'status' | 'currentHp' | 'fainted' | 'stats'>[],
  items: Pick<Item, 'id' | 'status' | 'quantity'>[],
): { wager: WagerRequest; dropped: number } {
  const idleMon = new Set(pokemon.filter((p) => p.status === 'IDLE' && !isFainted(p)).map((p) => p.id));
  const idleStacks = new Map(
    items.filter((i) => i.status === 'IDLE' && i.quantity > 0).map((i) => [i.id, i.quantity]),
  );

  const source = wager?.pokemonIds ?? [];
  const pokemonIds = source.filter((id) => idleMon.has(id));
  let dropped = source.length - pokemonIds.length;

  const refs: WagerItemRef[] = [];
  for (const ref of wager?.items ?? []) {
    const held = idleStacks.get(ref.id);
    if (held === undefined) {
      dropped += 1;
      continue;
    }
    // qty=0 是旧格式的整堆标记 → 押整堆
    const wanted = ref.qty > 0 ? ref.qty : held;
    refs.push({ id: ref.id, qty: Math.min(wanted, held) });
  }

  return {
    wager: { pokemonIds, items: refs, points: Math.max(0, wager?.points ?? 0) },
    dropped,
  };
}

/** 押注清单的一句话摘要（模板下拉、载入提示用） */
export function describeWager(wager: WagerBundle | WagerRequest | null | undefined): string {
  const parts: string[] = [];
  const mons = wager?.pokemonIds?.length ?? 0;
  if (mons) parts.push(`宝可梦×${mons}`);
  const refs = wager?.items ?? [];
  if (refs.length) parts.push(`道具×${refs.reduce((sum, r) => sum + (r.qty || 0), 0) || refs.length}`);
  if (wager?.points) parts.push(`${wager.points}P`);
  return parts.join(' + ') || '无押注';
}

/** 屏蔽剩余时长文案（不足 1 分钟按 1 分钟显示） */
export function blockRemainingText(remainingMs: number): string {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `还剩 ${minutes} 分钟`;
}
