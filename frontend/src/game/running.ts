/**
 * 跑鞋（起始镇「妈妈」赠送的一次性道具）：按住 Shift 跑步（移动与行走动画帧率 ×2）。
 * 纯常量 + 纯函数，Phaser 场景、Vue 组件与单测共用同一份口径；
 * `hasRunningShoes` / `setRunningShoes` 让引擎在 Pinia 之外（单测、截图脚本）也能判断。
 */
import { usePokemonStore } from '@/stores/pokemon';

/** 链上 typeId（backend/src/game-data/items.data.ts，kind='key'：非消耗品） */
export const RUNNING_SHOES_TYPE_ID = 'running-shoes';

/** 按住 Shift 时的速度倍率（与后端 POST /users/me/running-shoes 的 speedMultiplier 一致） */
export const RUNNING_SPEED_MULTIPLIER = 2;

/** 背包里有没有跑鞋（数量 > 0 且未锁定；未知 typeId 的条目忽略） */
export function ownsRunningShoes(items: ReadonlyArray<{ typeId: string; quantity: number; status?: string }>): boolean {
  return items.some(
    (item) =>
      item.typeId === RUNNING_SHOES_TYPE_ID &&
      item.quantity > 0 &&
      (!item.status || item.status === 'IDLE'),
  );
}

/** 当前是否跑步：按住 Shift 且**已经拿到跑鞋**（没跑鞋时按 Shift 无效） */
export function isRunning(shiftDown: boolean, hasShoes: boolean): boolean {
  return shiftDown && hasShoes;
}

/** 跑步倍率 → 每格移动耗时（跑步时减半，动画帧率同步加快） */
export function stepDuration(baseMs: number, running: boolean): number {
  return running ? Math.round(baseMs / RUNNING_SPEED_MULTIPLIER) : baseMs;
}

/** 引擎兜底缓存：Pinia 不在（场景被单测/截图脚本直接创建）时仍能知道有没有跑鞋 */
let shoesCache = false;

/** 有没有跑鞋：优先读背包缓存（Pinia），读不到退回上次 `setRunningShoes` 的结果 */
export function hasRunningShoes(): boolean {
  try {
    if (usePokemonStore().hasRunningShoes) return true;
  } catch {
    /* Pinia 未安装（单测 / 场景独立运行） */
  }
  return shoesCache;
}

/** 领取到跑鞋后调用：让场景立刻能跑（不必等背包刷新的下一次渲染） */
export function setRunningShoes(owned: boolean): void {
  shoesCache = owned;
}
