import { T } from './tiles';
import type { MapDef, MapId, TreePlacement } from './types';

type Points = readonly (readonly [number, number])[];
interface TreeLayout { border?: boolean; large: Points; small: Points }

/** 大树围林、少量小树点缀空地；不再把随机树格的残片填成小树阵。 */
const LAYOUTS: Partial<Record<MapId, TreeLayout>> = {
  town: { border: true, large: [[3,4], [26,4], [26,10]], small: [[5,5], [28,5], [28,11]] },
  'route-grass': { border: true,
    large: [[3,8], [4,10], [19,15], [27,15], [29,16]],
    small: [[22,2], [12,5], [27,21]] },
  forest: { border: true,
    large: [[2,3], [4,5], [2,7], [3,10], [2,13], [3,18], [2,20], [12,2], [14,4],
      [20,2], [22,4], [26,5], [28,7], [20,9], [22,12], [27,15], [29,17], [26,19], [20,18], [13,20], [23,20]],
    small: [[6,11], [5,16], [15,6], [21,7], [28,12], [20,15], [12,18]] },
  coast: { large: [[3,4], [5,6], [27,3], [29,5], [32,8]], small: [[3,8], [27,7], [34,9]] },
  'southern-island': { large: [], small: [[7,7], [12,6]] },
};

/** Preserve paths, encounters, buildings and interaction space while replacing provisional tree masks. */
export function arrangeTrees(map: MapDef): void {
  const layout = LAYOUTS[map.id];
  if (!layout) return;
  for (const row of map.grid) for (let x = 0; x < row.length; x++) {
    if (row[x] === T.tree) row[x] = T.grass;
  }
  const reserved = new Set([map.spawn, ...map.warps, ...map.objects].map(p => `${p.x},${p.y}`));
  const trees: TreePlacement[] = [];
  const plant = (x: number, y: number, size: TreePlacement['size']) => {
    const width = size === 'large' ? 2 : 1;
    const cells = Array.from({ length: width * 2 }, (_, i) => [x + i % width, y + Math.floor(i / width)]);
    if (cells.some(([xx, yy]) => map.grid[yy]?.[xx] !== T.grass || reserved.has(`${xx},${yy}`))) return;
    for (const [xx, yy] of cells) map.grid[yy][xx] = T.tree;
    trees.push({ x, y, size });
  };
  if (layout.border) {
    // Complete crowns along all four edges. Exit margins stay open when a whole tree will not fit.
    for (let x = 0; x + 1 < map.width; x += 2) {
      plant(x, 0, 'large'); plant(x, map.height - 2, 'large');
    }
    for (let y = 2; y + 1 < map.height - 2; y += 2) {
      plant(0, y, 'large'); plant(map.width - 2, y, 'large');
    }
  }
  for (const [x, y] of layout.large) plant(x, y, 'large');
  for (const [x, y] of layout.small) plant(x, y, 'small');
  map.trees = trees;
}
