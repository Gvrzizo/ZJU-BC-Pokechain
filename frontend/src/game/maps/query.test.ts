import { describe, expect, it } from 'vitest';
import { T } from './tiles';
import type { MapDef, MapId, WarpDef } from './types';
import {
  DELTA,
  doorAt,
  facingTarget,
  frontOf,
  inBounds,
  isEncounterTile,
  isWalkable,
  npcAt,
  reachable,
  signAt,
  tileIdAt,
  warpAt,
  warpDestination,
  walkableTiles,
} from './query';

/** 传送 / 行走判定（纯逻辑）用小图构造，不依赖真实世界数据 */
function makeMap(partial: Partial<MapDef> & { id: MapId; grid: number[][] }): MapDef {
  return {
    name: partial.id,
    biome: 'grass',
    zoneId: 'route-grass',
    width: partial.grid[0].length,
    height: partial.grid.length,
    warps: [] as WarpDef[],
    objects: [],
    spawn: { x: 0, y: 0 },
    ...partial,
  };
}

const MAPS: Record<MapId, MapDef> = {
  town: makeMap({
    id: 'town',
    grid: [
      [T.path, T.path, T.path],
      [T.path, T.tallGrass, T.tree],
      [T.path, T.path, T.path],
    ],
    spawn: { x: 0, y: 0 },
    warps: [{ x: 2, y: 0, to: { mapId: 'route-grass', x: 1, y: 1 }, kind: 'edge' }],
    objects: [
      { kind: 'npc', x: 1, y: 1, sprite: 'elder', name: '老人', lines: ['你好'] },
      { kind: 'sign', x: 0, y: 2, lines: ['路牌'] },
      { kind: 'door', x: 2, y: 2, building: 'house', label: '民居', action: 'info' },
    ],
    encounter: { tiles: ['tallGrass'], rate: 0.5 },
  }),
  'route-grass': makeMap({
    id: 'route-grass',
    grid: [
      [T.path, T.path, T.path],
      [T.path, T.tree, T.path],
      [T.path, T.path, T.path],
    ],
    spawn: { x: 1, y: 1 },
  }),
} as Record<MapId, MapDef>;

describe('地图查询', () => {
  const town = MAPS.town;

  it('边界与瓦片读取', () => {
    expect(inBounds(town, -1, 0)).toBe(false);
    expect(inBounds(town, 3, 0)).toBe(false);
    expect(inBounds(town, 2, 2)).toBe(true);
    expect(tileIdAt(town, 1, 1)).toBe('tallGrass');
    expect(tileIdAt(town, 9, 9)).toBeUndefined();
  });

  it('人 / 路牌 / 门 / 传送点按坐标各取所需', () => {
    expect(npcAt(town, 1, 1)?.name).toBe('老人');
    expect(npcAt(town, 0, 0)).toBeUndefined();
    expect(signAt(town, 0, 2)?.lines).toEqual(['路牌']);
    expect(doorAt(town, 2, 2)?.label).toBe('民居');
    expect(warpAt(town, 2, 0)?.to.mapId).toBe('route-grass');
    expect(warpAt(town, 0, 0)).toBeUndefined();
  });

  it('可通行判定：阻挡瓦片 / NPC / 越界都不可走', () => {
    expect(isWalkable(town, 1, 0)).toBe(true);
    expect(isWalkable(town, 2, 1)).toBe(false); // 树
    expect(isWalkable(town, 1, 1)).toBe(false); // NPC 占位
    expect(isWalkable(town, -1, 0)).toBe(false);
    expect(walkableTiles(town).size).toBe(7);
    expect(walkableTiles(town, false).size).toBe(8); // 忽略 NPC 时多出 NPC 占的那格
  });

  it('面向的格子：优先 NPC，其次路牌，都没有则 nothing', () => {
    expect(facingTarget(town, { x: 1, y: 2 }, 'up').kind).toBe('npc');
    expect(facingTarget(town, { x: 1, y: 2 }, 'up')).toMatchObject({ npc: { name: '老人' } });
    expect(facingTarget(town, { x: 1, y: 2 }, 'left')).toMatchObject({ sign: { lines: ['路牌'] } });
    expect(facingTarget(town, { x: 0, y: 0 }, 'right').kind).toBe('none');
    expect(frontOf({ x: 1, y: 1 }, 'down')).toEqual({ x: 1, y: 2 });
    expect(DELTA.up).toEqual({ x: 0, y: -1 });
  });

  it('遇敌地形只认配置里列出的瓦片', () => {
    expect(isEncounterTile(town, 1, 1)).toBe(true);
    expect(isEncounterTile(town, 0, 0)).toBe(false);
    expect(isEncounterTile(MAPS['route-grass'], 0, 0)).toBe(false); // 没配 encounter
  });

  it('可达性：NPC 会挡住走廊（忽略 NPC 时又能通）', () => {
    const corridor = makeMap({
      id: 'coast',
      grid: [
        [T.path, T.path, T.path],
        [T.tree, T.tree, T.path],
        [T.path, T.path, T.path],
      ],
      objects: [{ kind: 'npc', x: 2, y: 1, sprite: 'elder', name: '挡路的人', lines: ['…'] }],
      spawn: { x: 0, y: 0 },
    });
    expect(reachable(corridor, corridor.spawn).has('0,2')).toBe(false);
    expect(reachable(corridor, corridor.spawn, false).has('0,2')).toBe(true);
  });
});

describe('传送落点', () => {
  it('正常传送：落到目标图指定格', () => {
    const warp = MAPS.town.warps[0];
    expect(warpDestination(MAPS.town, warp, MAPS)).toEqual({ mapId: 'route-grass', x: 1, y: 1 });
  });

  it('目标格不可站立 / 被 NPC 占住：回退到目标图出生点', () => {
    const blocked = makeMap({
      id: 'volcano',
      grid: [
        [T.tree, T.tree],
        [T.tree, T.tree],
      ],
      spawn: { x: 0, y: 0 },
    });
    const maps = { ...MAPS, volcano: blocked } as Record<MapId, MapDef>;
    const warp: WarpDef = { x: 0, y: 0, to: { mapId: 'volcano', x: 1, y: 1 }, kind: 'door' };
    expect(warpDestination(MAPS.town, warp, maps)).toEqual({ mapId: 'volcano', x: 0, y: 0 });

    const npcBlocked = makeMap({
      id: 'cave',
      grid: [
        [T.floor, T.floor],
        [T.floor, T.floor],
      ],
      spawn: { x: 1, y: 0 },
      objects: [{ kind: 'npc', x: 0, y: 1, sprite: 'elder', name: '守卫', lines: ['站住'] }],
    });
    const maps2 = { ...MAPS, cave: npcBlocked } as Record<MapId, MapDef>;
    const warp2: WarpDef = { x: 0, y: 0, to: { mapId: 'cave', x: 0, y: 1 }, kind: 'door' };
    expect(warpDestination(MAPS.town, warp2, maps2)).toEqual({ mapId: 'cave', x: 1, y: 0 });
  });

  it('目标图不存在时原地不动（坏数据不会把玩家传丢）', () => {
    const warp: WarpDef = { x: 1, y: 0, to: { mapId: 'nowhere' as MapId, x: 0, y: 0 }, kind: 'door' };
    expect(warpDestination(MAPS.town, warp, MAPS)).toEqual({ mapId: 'town', x: 1, y: 0 });
  });
});
