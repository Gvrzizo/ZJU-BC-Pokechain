import { T, TILE_SEMANTICS } from './maps/tiles';
import type { MapDef } from './maps/types';
import type { WorldTilesetSpec } from './world-assets';

/** A render plan shared by Phaser and the offline map preview. All coordinates are integer pixels. */
export interface MapBlit {
  source: string;
  sx: number; sy: number; sw: number; sh: number;
  dx: number; dy: number; dw: number; dh: number;
}

const SIZE = 32;
const OUTDOOR = new Set(['town', 'grass', 'forest', 'mid', 'north', 'coast', 'island', 'birth']);

/** Build 8px-native transition quadrants from the original nine metatiles. */
export function transitionQuadrants(patch: number[], north: boolean, east: boolean, south: boolean, west: boolean): number[] {
  return [patch[(north ? 1 : 0) * 3 + (west ? 1 : 0)],
    patch[(north ? 1 : 0) * 3 + (east ? 1 : 2)],
    patch[(south ? 1 : 2) * 3 + (west ? 1 : 0)],
    patch[(south ? 1 : 2) * 3 + (east ? 1 : 2)]];
}

export function mapBlits(map: MapDef, spec?: WorldTilesetSpec, buildings: ReadonlySet<string> = new Set()): MapBlit[] {
  const commands: MapBlit[] = [];
  const at = (x: number, y: number) => map.grid[y]?.[x];
  const outdoor = OUTDOOR.has(map.biome);
  const native = !!spec;
  const columns = spec?.columns ?? 16;
  const blit = (index: number, x: number, y: number, source = 'native', q?: number) => {
    const col = source === 'fallback' ? TILE_SEMANTICS.length : columns;
    const size = q === undefined ? SIZE : SIZE / 2;
    const qx = q === undefined ? 0 : q % 2 * size;
    const qy = q === undefined ? 0 : Math.floor(q / 2) * size;
    commands.push({ source, sx: index % col * SIZE + qx, sy: Math.floor(index / col) * SIZE + qy,
      sw: size, sh: size, dx: x * SIZE + qx, dy: y * SIZE + qy, dw: size, dh: size });
  };
  const semantic = (tile: number, x: number, y: number) => {
    const index = spec?.tiles[TILE_SEMANTICS[tile]];
    blit(index ?? tile, x, y, index === undefined ? 'fallback' : 'native');
  };
  const wet = (v: number | undefined) => v === T.water || v === T.deepWater;
  const trees = new Set<string>();
  const coveredBuildings = new Set<string>();
  const buildingCommands: MapBlit[] = [];
  // Footprint is identical to town's collision grid; no scaling or hand-drawn replacement roofs.
  for (const door of map.objects) {
    if (door.kind !== 'door' || !buildings.has(door.building)) continue;
    const w = door.building === 'house' ? 5 : 4;
    const h = door.building === 'house' ? 5 : 4;
    const x = door.x - 1; const y = door.y - h + 1;
    for (let yy = y; yy <= door.y; yy++) for (let xx = x; xx < x + w; xx++) coveredBuildings.add(`${xx},${yy}`);
    buildingCommands.push({ source: `building-${door.building}`, sx: 0, sy: 0, sw: w * SIZE, sh: h * SIZE,
      dx: x * SIZE, dy: y * SIZE, dw: w * SIZE, dh: h * SIZE });
  }

  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
    const tile = at(x, y)!;
    const name = TILE_SEMANTICS[tile];
    if (coveredBuildings.has(`${x},${y}`)) { semantic(T.grass, x, y); continue; }
    if (native && ['coast', 'island', 'birth'].includes(map.biome) && wet(tile)) {
      blit(spec.tiles.deepWater ?? 368, x, y); continue;
    }
    const patch = spec?.autotiles?.[name];
    if (patch) {
      const connects = (dx: number, dy: number) => {
        const other = at(x + dx, y + dy);
        return other === undefined || (wet(tile) ? wet(other) || other === T.plank : other === tile || other === T.door);
      };
      transitionQuadrants(patch, connects(0, -1), connects(1, 0), connects(0, 1), connects(-1, 0))
        .forEach((index, q) => blit(index, x, y, 'native', q));
      continue;
    }
    if (native && outdoor && tile === T.tree) {
      if (trees.has(`${x},${y}`)) continue;
      // Original 2x2 trees, greedily fitted wholly inside blocked cells. Narrow remnants use the original bush.
      if ([at(x + 1, y), at(x, y + 1), at(x + 1, y + 1)].every((v) => v === T.tree) &&
          !trees.has(`${x + 1},${y}`) && !trees.has(`${x},${y + 1}`) && !trees.has(`${x + 1},${y + 1}`)) {
        [468, 469, 476, 477].forEach((index, q) => {
          const xx = x + q % 2; const yy = y + Math.floor(q / 2);
          trees.add(`${xx},${yy}`); blit(index, xx, yy);
        });
      } else blit(14, x, y);
      continue;
    }
    if (native && (tile === T.wall || tile === T.rock) && map.biome !== 'town') {
      const same = (dx: number, dy: number) => {
        const other = at(x + dx, y + dy);
        return other === undefined || other === tile;
      };
      const n = same(0, -1), e = same(1, 0), s = same(0, 1), w = same(-1, 0);
      // Isolated boulders use a full boulder, connected terrain uses the original cliff's edge pieces.
      if (tile === T.rock && !n && !e && !s && !w) { semantic(tile, x, y); continue; }
      const rockPatch = outdoor ? [104, 105, 106, 112, 113, 114, 120, 121, 122]
        : map.biome === 'tower' ? [568, 569, 570, 576, 577, 578, 585, 589, 586]
        : ['volcano', 'magma'].includes(map.biome) ? [795, 803, 802, 800, 811, 813, 808, 809, 810]
        : [513, 521, 520, 528, 529, 530, 536, 537, 538];
      transitionQuadrants(rockPatch, n, e, s, w).forEach((index, q) => blit(index, x, y, 'native', q));
      continue;
    }
    if (native && tile === T.plank) {
      blit(at(x - 1, y) !== T.plank ? 434 : at(x + 1, y) !== T.plank ? 436 : 435, x, y);
      continue;
    }
    semantic(tile, x, y);
  }
  if (native && !outdoor) {
    for (let y = 1; y < map.height; y++) for (let x = 0; x < map.width; x++) {
      if (at(x, y) !== T.pillar) continue;
      const top = spec.tiles.pillar;
      if (top !== undefined) { blit(top, x, y - 1); blit(top + 8, x, y); }
    }
  }
  // Signs live in map.objects, not necessarily in the semantic grid.
  for (const object of map.objects) {
    if (object.kind === 'sign') semantic(T.sign, object.x, object.y);
  }
  return commands.concat(buildingCommands);
}

export function paintMap(ctx: CanvasRenderingContext2D, commands: MapBlit[], images: Record<string, CanvasImageSource>): void {
  ctx.imageSmoothingEnabled = false;
  for (const b of commands) {
    const source = images[b.source];
    if (source) ctx.drawImage(source, b.sx, b.sy, b.sw, b.sh, b.dx, b.dy, b.dw, b.dh);
  }
}
