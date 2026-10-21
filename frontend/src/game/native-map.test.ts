import { describe, expect, it } from 'vitest';
import { MAPS, T, isBlockedIndex, type MapDef } from './maps';
import { mapBlits, transitionQuadrants } from './native-map';
import type { WorldTilesetSpec } from './world-assets';

const spec: WorldTilesetSpec = { biomes: ['town'], image: 'town.png', columns: 16,
  tiles: { grass: 1, path: 473, tree: 14, door: 97, sign: 27 } };
const small = (grid: number[][]): MapDef => ({ ...MAPS.town, width: grid[0].length, height: grid.length, grid, objects: [], warps: [] });

describe('原作地图渲染计划', () => {
  it('已映射的草地直接取原作图集，不再覆盖为自绘图形', () => {
    expect(mapBlits(small([[T.grass]]), spec)).toEqual([
      { source: 'native', sx: 32, sy: 0, sw: 32, sh: 32, dx: 0, dy: 0, dw: 32, dh: 32 },
    ]);
  });

  it('缺少整个素材包或单项映射时仍有对应的回退瓦片', () => {
    const map = small([[T.grass, T.floor]]);
    expect(mapBlits(map).map(b => b.source)).toEqual(['fallback', 'fallback']);
    expect(mapBlits(map, spec).map(b => b.source)).toEqual(['native', 'fallback']);
  });

  it('道路内部无重复边缘，孤立格四角均来自原作外角', () => {
    const patch = [464, 465, 466, 472, 473, 474, 480, 481, 482];
    expect(transitionQuadrants(patch, true, true, true, true)).toEqual([473, 473, 473, 473]);
    expect(transitionQuadrants(patch, false, false, false, false)).toEqual([464, 466, 480, 482]);
    expect(transitionQuadrants(patch, true, false, true, false)).toEqual([472, 474, 472, 474]);
  });

  it('整棵原作树只覆盖四个实际阻挡格，窄处使用完整灌木', () => {
    const map = small([[T.tree, T.tree, T.grass], [T.tree, T.tree, T.tree]]);
    const commands = mapBlits(map, spec);
    expect(commands.map(b => b.sy / 32 * 16 + b.sx / 32)).toEqual([468, 469, 476, 477, 1, 14]);
    expect(new Set(commands.map(b => `${b.dx},${b.dy}`)).size).toBe(6);
  });

  it('四栋建筑的原作占地全部有碰撞，门的位置与可行走格一致', () => {
    const map = MAPS.town;
    const commands = mapBlits(map, spec, new Set(['center', 'shop', 'house']));
    const buildings = commands.filter(b => b.source.startsWith('building-'));
    expect(buildings).toHaveLength(4);
    for (const b of buildings) {
      const doorX = b.dx / 32 + 1, doorY = (b.dy + b.dh) / 32 - 1;
      expect(map.objects.some(o => o.kind === 'door' && o.x === doorX && o.y === doorY)).toBe(true);
      for (let y = b.dy / 32; y < (b.dy + b.dh) / 32; y++) for (let x = b.dx / 32; x < (b.dx + b.dw) / 32; x++) {
        if (x === doorX && y === doorY) expect(map.grid[y][x]).toBe(T.door);
        else expect(isBlockedIndex(map.grid[y][x]), `${b.source} ${x},${y}`).toBe(true);
      }
      expect(b.sw).toBe(b.dw); expect(b.sh).toBe(b.dh);
    }
  });

  it('缺少整栋建筑图片时保留语义瓦片，全部地图始终使用整数像素坐标', () => {
    expect(mapBlits(MAPS.town, spec).some(b => b.source.startsWith('building-'))).toBe(false);
    for (const map of Object.values(MAPS)) {
      for (const b of mapBlits(map, spec)) {
        for (const value of [b.sx, b.sy, b.sw, b.sh, b.dx, b.dy, b.dw, b.dh]) expect(Number.isInteger(value)).toBe(true);
        expect(b.dx).toBeGreaterThanOrEqual(0); expect(b.dy).toBeGreaterThanOrEqual(0);
        expect(b.dx + b.dw).toBeLessThanOrEqual(map.width * 32);
        expect(b.dy + b.dh).toBeLessThanOrEqual(map.height * 32);
      }
    }
  });
});
