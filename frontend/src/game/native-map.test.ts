import { describe, expect, it } from 'vitest';
import { MAPS, T, isBlockedIndex, type MapDef } from './maps';
import { mapBlits, transitionQuadrants } from './native-map';
import type { WorldTilesetSpec } from './world-assets';

const spec: WorldTilesetSpec = { biomes: ['town'], image: 'town.png', columns: 16,
  tiles: { grass: 1, path: 473, tree: 14, rock: 1024, door: 97, sign: 27 },
  wallTiles: [104, 105, 106, 112, 113, 114, 120, 121, 122] };
const small = (grid: number[][]): MapDef => ({ ...MAPS.town, width: grid[0].length, height: grid.length, grid, trees: [], objects: [], warps: [] });

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

  it('完整大树为两行，底部使用收口树根，不把连接块再叠成第二层树冠', () => {
    const map = { ...small([[T.tree, T.tree], [T.tree, T.tree]]), trees: [{ x: 0, y: 0, size: 'large' as const }] };
    const commands = mapBlits(map, spec);
    expect(commands.slice(4).map(b => b.sy / 32 * 16 + b.sx / 32)).toEqual([468, 469, 484, 485]);
    expect(new Set(commands.map(b => `${b.dx},${b.dy}`)).size).toBe(4);
  });

  it('小树按明确位置绘制树冠和树干两格，不把半截树冠铺成矩阵', () => {
    const map = { ...small([[T.tree], [T.tree]]), trees: [{ x: 0, y: 0, size: 'small' as const }] };
    const commands = mapBlits(map, spec);
    expect(commands.slice(2).map(b => b.sy / 32 * 16 + b.sx / 32)).toEqual([14, 22]);
    expect(commands.slice(2).map(b => [b.dy, b.dh])).toEqual([[0,32], [32,32]]);
  });

  it('没有完整树木位置的残格还原草地，不自动补半截小树', () => {
    expect(mapBlits(small([[T.tree]]), spec)).toEqual(mapBlits(small([[T.grass]]), spec));
  });

  it('相邻陆地石块保留完整巨石，不会拼成岩壁或使用海底礁石', () => {
    const map = { ...small([[T.rock, T.rock], [T.rock, T.rock]]), biome: 'mid' as const };
    const commands = mapBlits(map, spec);
    expect(commands).toHaveLength(4);
    expect(commands.every(b => b.sw === 32 && b.sh === 32 && b.sy / 32 * 16 + b.sx / 32 === 1024)).toBe(true);
  });

  it('岩壁使用完整朝向块，顶部、侧面与正面不再裁成四角', () => {
    const map = { ...small([
      [T.grass, T.grass, T.grass, T.grass, T.grass],
      [T.grass, T.wall, T.wall, T.wall, T.grass],
      [T.grass, T.wall, T.wall, T.wall, T.grass],
      [T.grass, T.wall, T.wall, T.wall, T.grass],
      [T.grass, T.grass, T.grass, T.grass, T.grass],
    ]), biome: 'mid' as const };
    const commands = mapBlits(map, spec).filter(b => b.dx >= 32 && b.dx <= 96 && b.dy >= 32 && b.dy <= 96);
    expect(commands.map(b => b.sy / 32 * 16 + b.sx / 32)).toEqual(spec.wallTiles);
    expect(commands.every(b => b.sw === 32 && b.sh === 32)).toBe(true);
  });

  it('岩壁门洞保持两侧连续，单格凸起改用完整石块', () => {
    const map = { ...small([[T.wall, T.wall, T.wall], [T.wall, T.door, T.wall], [T.grass, T.grass, T.grass]]), biome: 'mid' as const };
    expect(mapBlits(map, spec).filter(b => b.dy === 32).map(b => b.sy / 32 * 16 + b.sx / 32)).toEqual([121, 97, 121]);
    const spur = { ...small([[T.grass, T.wall, T.grass]]), biome: 'mid' as const };
    expect(mapBlits(spur, spec)[1].sy / 32 * 16).toBe(1024);
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
