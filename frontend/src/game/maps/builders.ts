import { T, type TileId } from './tiles';
import type { Grid } from './types';

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
 * 建筑：屋顶一行 + 墙体一行（居中开门）。
 * 返回门坐标；墙体阻挡通行，门可行走（踩上去触发 object/warp）。
 */
export function building(
  grid: Grid,
  x: number,
  y: number,
  width = 5,
  roof: TileId = 'roof',
  tileWall: TileId = 'wall',
): { x: number; y: number } {
  hLine(grid, x, x + width - 1, y, T[roof]);
  hLine(grid, x, x + width - 1, y + 1, T[tileWall]);
  const doorX = x + Math.floor((width - 1) / 2);
  setTile(grid, doorX, y + 1, T.door);
  return { x: doorX, y: y + 1 };
}
