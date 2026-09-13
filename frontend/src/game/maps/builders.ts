import { T, type TileId } from './tiles';
import type { Grid, TilePoint } from './types';

/** 地图生成小工具：确定性伪随机 + 常用地块操作（地图文件里只写「哪块地放什么」） */

/** 确定性 LCG（同一 seed 每次生成同一张图，地图数据在单测里可复现） */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function createGrid(width: number, height: number, fill: number = T.grass): Grid {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => fill));
}

export function inBounds(grid: Grid, x: number, y: number): boolean {
  return y >= 0 && y < grid.length && x >= 0 && x < (grid[0]?.length ?? 0);
}

export function setTile(grid: Grid, x: number, y: number, tile: number): void {
  if (inBounds(grid, x, y)) grid[y][x] = tile;
}

export function fillRect(grid: Grid, x: number, y: number, w: number, h: number, tile: number): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) setTile(grid, x + dx, y + dy, tile);
  }
}

/** 描边一圈（外圈树/岩），厚度可调 */
export function border(grid: Grid, tile: number, thickness = 1): void {
  const h = grid.length;
  const w = grid[0]?.length ?? 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const edge =
        x < thickness || y < thickness || x >= w - thickness || y >= h - thickness;
      if (edge) grid[y][x] = tile;
    }
  }
}

export function hLine(grid: Grid, x0: number, x1: number, y: number, tile: number): void {
  const [from, to] = x0 <= x1 ? [x0, x1] : [x1, x0];
  for (let x = from; x <= to; x++) setTile(grid, x, y, tile);
}

export function vLine(grid: Grid, x: number, y0: number, y1: number, tile: number): void {
  const [from, to] = y0 <= y1 ? [y0, y1] : [y1, y0];
  for (let y = from; y <= to; y++) setTile(grid, x, y, tile);
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 在矩形区域内按密度撒点；`onlyOn` 限定只覆盖某些瓦片（默认只撒在草地上） */
export function scatter(
  grid: Grid,
  tile: number,
  area: Rect,
  density: number,
  rng: () => number,
  onlyOn: TileId = 'grass',
): void {
  const keep = T[onlyOn];
  for (let dy = 0; dy < area.h; dy++) {
    for (let dx = 0; dx < area.w; dx++) {
      const x = area.x + dx;
      const y = area.y + dy;
      if (!inBounds(grid, x, y)) continue;
      if (onlyOn && grid[y][x] !== keep) continue;
      if (rng() < density) grid[y][x] = tile;
    }
  }
}

/**
 * 带斑块的深草/灰地：在矩形内按覆盖率铺 `tile`，`onlyOn`（缺省草地）决定哪些格子可被覆盖
 * （边缘格子只盖一半，观感更像自然长出来的草丛）。整块铺满再抠点，比均匀撒点更像"草丛"。
 */
export function patch(
  grid: Grid,
  tile: number,
  area: Rect,
  coverage: number,
  rng: () => number,
  onlyOn: TileId | null = 'grass',
): void {
  const keep = onlyOn ? T[onlyOn] : null;
  for (let dy = 0; dy < area.h; dy++) {
    for (let dx = 0; dx < area.w; dx++) {
      const x = area.x + dx;
      const y = area.y + dy;
      if (!inBounds(grid, x, y)) continue;
      if (keep !== null && grid[y][x] !== keep) continue;
      const edge = dx === 0 || dy === 0 || dx === area.w - 1 || dy === area.h - 1;
      if (rng() < (edge ? coverage * 0.5 : coverage)) grid[y][x] = tile;
    }
  }
}

export interface BlobOptions {
  /** 边缘抖动幅度（0 = 规整椭圆，0.4 ≈ 自然的圆润草丛） */
  jitter?: number;
  /** 只覆盖这种地形（默认铺在任何格子上） */
  onlyOn?: TileId | null;
  /** 内部填充率（<1 时挖出零星空洞，用于碎石/灰烬地） */
  fill?: number;
}

/**
 * 有机斑块：椭圆掩膜 + 边界抖动。草丛/灰地/水潭用它铺出**圆润的簇**，
 * 而不是 `patch` 那种"矩形 + 毛边"的块状感（原作里草丛都是一小团一小团的）。
 */
export function blob(
  grid: Grid,
  tile: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rng: () => number,
  options: BlobOptions = {},
): void {
  const { jitter = 0.3, onlyOn = null, fill = 1 } = options;
  const keep = onlyOn ? T[onlyOn] : null;
  for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
    for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
      const wobble = 1 + (rng() - 0.5) * jitter * 2;
      if (!inBounds(grid, x, y)) continue;
      if (keep !== null && grid[y][x] !== keep) continue;
      if (fill < 1 && rng() > fill) continue;
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (Math.sqrt(dx * dx + dy * dy) > wobble) continue;
      grid[y][x] = tile;
    }
  }
}

/**
 * 水塘：闭合的圆润水域（可选一圈围边——沙滩/浅水），4×3 到 7×5 都好看。
 * 岸线由 `blob` 的椭圆掩膜保证闭合，不会出现直角或单格孤岛。
 */
export function pond(
  grid: Grid,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rng: () => number,
  rim?: { tile: TileId; grow?: number; onlyOn?: TileId | null },
): void {
  if (rim) {
    blob(grid, T[rim.tile], cx, cy, rx + (rim.grow ?? 1), ry + (rim.grow ?? 1), rng, {
      jitter: 0.22,
      onlyOn: rim.onlyOn ?? null,
    });
  }
  blob(grid, T.water, cx, cy, rx, ry, rng, { jitter: 0.18, onlyOn: rim ? rim.tile : null });
}

/** 折线道路：`pts` 是每段走廊的拐点（左上角），转角处自动叠满拐角方块 */
export function road(grid: Grid, pts: readonly TilePoint[], tile: number, width = 2): void {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a.y === b.y) {
      const x0 = Math.min(a.x, b.x) - (width - 1);
      const x1 = Math.max(a.x, b.x) + (width - 1);
      fillRect(grid, x0, a.y, x1 - x0 + 1, width, tile);
    } else if (a.x === b.x) {
      const y0 = Math.min(a.y, b.y) - (width - 1);
      const y1 = Math.max(a.y, b.y) + (width - 1);
      fillRect(grid, a.x, y0, width, y1 - y0 + 1, tile);
    }
  }
}

/** 花簇：2-4 格花挤在一起（原作的装饰花从不单开一朵），只长在 `onlyOn` 地形上 */
export function flowerCluster(
  grid: Grid,
  x: number,
  y: number,
  rng: () => number,
  count = 3,
  onlyOn: TileId = 'grass',
): void {
  const offsets: readonly (readonly [number, number])[] = [
    [0, 0], [1, 0], [0, 1], [1, 1], [-1, 0], [0, -1], [-1, 1], [1, -1],
  ];
  const keep = T[onlyOn];
  let placed = 0;
  for (const [dx, dy] of offsets) {
    if (placed >= count) break;
    if (rng() < 0.35) continue;
    const px = x + dx;
    const py = y + dy;
    if (!inBounds(grid, px, py) || grid[py][px] !== keep) continue;
    grid[py][px] = T.flower;
    placed += 1;
  }
}

/** 在地图边缘开口（宽 `width` 格），并返回开口中心坐标 */
export function openEdge(
  grid: Grid,
  side: 'north' | 'south' | 'east' | 'west',
  x: number,
  width = 1,
  tile: number = T.path,
): void {
  const h = grid.length;
  const w = grid[0]?.length ?? 0;
  const start = x - Math.floor((width - 1) / 2);
  for (let i = 0; i < width; i++) {
    const offset = start + i;
    if (side === 'north') setTile(grid, offset, 0, tile);
    else if (side === 'south') setTile(grid, offset, h - 1, tile);
    else if (side === 'west') setTile(grid, 0, offset, tile);
    else setTile(grid, w - 1, offset, tile);
  }
}

/**
 * 建筑：`roofRows` 行屋顶 + 一行墙体（居中开门）。
 * 返回门坐标；墙体阻挡通行，门可行走（踩上去触发 object/warp）。
 */
export function building(
  grid: Grid,
  x: number,
  y: number,
  width = 5,
  roof: TileId = 'roof',
  tileWall: TileId = 'wall',
  roofRows = 1,
): { x: number; y: number } {
  for (let i = 0; i < Math.max(1, roofRows); i++) hLine(grid, x, x + width - 1, y + i, T[roof]);
  const wallY = y + Math.max(1, roofRows);
  hLine(grid, x, x + width - 1, wallY, T[tileWall]);
  const doorX = x + Math.floor((width - 1) / 2);
  setTile(grid, doorX, wallY, T.door);
  return { x: doorX, y: wallY };
}
