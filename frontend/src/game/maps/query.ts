import { isBlockedIndex, tileIdOf, type TileId } from './tiles';
import type { Facing, MapDef, MapId, MapObject, NpcDef, SignDef, WarpDef } from './types';

/**
 * 地图查询与传送判定（纯函数，不依赖 Phaser）：引擎按这些结果决定能不能走、
 * 踩到门以后去哪儿、面向的格子能不能对话。地图数据校验单测也复用同一套口径。
 */

export function inBounds(map: MapDef, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

export function tileAt(map: MapDef, x: number, y: number): number | undefined {
  if (!inBounds(map, x, y)) return undefined;
  return map.grid[y][x];
}

export function tileIdAt(map: MapDef, x: number, y: number): TileId | undefined {
  const index = tileAt(map, x, y);
  return index === undefined ? undefined : tileIdOf(index);
}

export function npcAt(map: MapDef, x: number, y: number): NpcDef | undefined {
  return map.objects.find((o) => o.kind === 'npc' && o.x === x && o.y === y) as NpcDef | undefined;
}

export function signAt(map: MapDef, x: number, y: number): SignDef | undefined {
  return map.objects.find((o) => o.kind === 'sign' && o.x === x && o.y === y) as SignDef | undefined;
}

export function doorAt(map: MapDef, x: number, y: number): Extract<MapObject, { kind: 'door' }> | undefined {
  return map.objects.find((o) => o.kind === 'door' && o.x === x && o.y === y) as
    | Extract<MapObject, { kind: 'door' }>
    | undefined;
}

export function warpAt(map: MapDef, x: number, y: number): WarpDef | undefined {
  return map.warps.find((w) => w.x === x && w.y === y);
}

/** 可通行：在图内、瓦片不阻挡、且没有 NPC 站着 */
export function isWalkable(map: MapDef, x: number, y: number): boolean {
  const index = tileAt(map, x, y);
  if (index === undefined) return false;
  if (isBlockedIndex(index)) return false;
  return !npcAt(map, x, y);
}

export const DELTA: Record<Facing, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export function frontOf(pos: { x: number; y: number }, facing: Facing): { x: number; y: number } {
  const d = DELTA[facing];
  return { x: pos.x + d.x, y: pos.y + d.y };
}

/** 该格是否属于遇敌瓦片（镇内没有 encounter 配置 → 永远 false） */
export function isEncounterTile(map: MapDef, x: number, y: number): boolean {
  if (!map.encounter) return false;
  const id = tileIdAt(map, x, y);
  return id !== undefined && map.encounter.tiles.includes(id);
}

/** 面向的格子能做什么：NPC 对话 / 路牌 / 都没有 */
export type FacingTarget =
  | { kind: 'npc'; npc: NpcDef }
  | { kind: 'sign'; sign: SignDef }
  | { kind: 'none' };

export function facingTarget(map: MapDef, pos: { x: number; y: number }, facing: Facing): FacingTarget {
  const front = frontOf(pos, facing);
  const npc = npcAt(map, front.x, front.y);
  if (npc) return { kind: 'npc', npc };
  const sign = signAt(map, front.x, front.y);
  if (sign) return { kind: 'sign', sign };
  return { kind: 'none' };
}

/** 宽高为 1 个格子的图内坐标列表（校验用） */
export function allTiles(map: MapDef): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) out.push({ x, y });
  }
  return out;
}

/** 玩家可站立的瓦片（含 NPC 视为阻挡）→ 用于连通性检查 */
export function walkableTiles(map: MapDef, withNpcs = true): Set<string> {
  const set = new Set<string>();
  for (const p of allTiles(map)) {
    if (withNpcs ? isWalkable(map, p.x, p.y) : tileIsWalkable(map, p.x, p.y)) {
      set.add(`${p.x},${p.y}`);
    }
  }
  return set;
}

/** 只看瓦片本身（忽略 NPC），用于判断 NPC 是否把唯一通路堵死之前的可达性 */
export function tileIsWalkable(map: MapDef, x: number, y: number): boolean {
  const index = tileAt(map, x, y);
  return index !== undefined && !isBlockedIndex(index);
}

/** 广度优先可达集合（起点不可走时返回空集） */
export function reachable(
  map: MapDef,
  from: { x: number; y: number },
  withNpcs = true,
): Set<string> {
  const seen = new Set<string>();
  if (!(withNpcs ? isWalkable(map, from.x, from.y) : tileIsWalkable(map, from.x, from.y))) {
    return seen;
  }
  const queue: { x: number; y: number }[] = [from];
  seen.add(`${from.x},${from.y}`);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const dir of Object.keys(DELTA) as Facing[]) {
      const next = frontOf(cur, dir);
      const key = `${next.x},${next.y}`;
      if (seen.has(key)) continue;
      const ok = withNpcs ? isWalkable(map, next.x, next.y) : tileIsWalkable(map, next.x, next.y);
      if (!ok) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return seen;
}

/** 传送 / 楼梯的落点：目标地图传送到目标坐标；越界或不可站立则回退到目标地图的 spawn */
export function warpDestination(
  from: MapDef,
  warp: WarpDef,
  maps: Record<MapId, MapDef>,
): { mapId: MapId; x: number; y: number } {
  const target = maps[warp.to.mapId];
  if (!target) return { mapId: from.id, x: warp.x, y: warp.y };
  const spot = target.grid[warp.to.y]?.[warp.to.x];
  const usable = spot !== undefined && !isBlockedIndex(spot) && !npcAt(target, warp.to.x, warp.to.y);
  return usable
    ? { mapId: target.id, x: warp.to.x, y: warp.to.y }
    : { mapId: target.id, x: target.spawn.x, y: target.spawn.y };
}
