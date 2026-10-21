import Phaser from 'phaser';
import { drawCharacter } from './character-art';
import type { Facing } from './maps/types';
import { BIOMES, type BiomeId } from './maps';
import { NPC_SPRITES, type NpcPalette } from './maps/npcs';
import { TILE_SEMANTICS, type TileId } from './maps/tiles';
import { worldTilesetKey, type WorldTilesetSpec } from './world-assets';

/**
 * 程序化 world 素材：按**生物群系**生成瓦片集（`world-tiles:<biome>`）与 NPC 小人贴图。
 * 仓库不内置版权素材——`public/assets/vendor/world/` 里放了素材时（见 `world-assets.ts` 的契约），
 * BootScene 会把 vendor 瓦片**叠加**到程序化瓦片集对应格子上（缺失的语义保持程序化），
 * 这样任何情况下瓦片索引（语义顺序）都一致，不会因为素材缺失而画错。
 */

const TILE = 32;

// ─────────────────────────────────────────────── 配色

export interface BiomeColors {
  grass: string;
  grassDark: string;
  grassLight: string;
  tall: string;
  tallDark: string;
  tallLight: string;
  flower: string;
  path: string;
  pathDark: string;
  pathLight: string;
  sand: string;
  sandDark: string;
  ash: string;
  ashDark: string;
  gravel: string;
  gravelDark: string;
  tree: string;
  treeDark: string;
  treeLight: string;
  trunk: string;
  rock: string;
  rockDark: string;
  rockLight: string;
  water: string;
  waterDeep: string;
  waterLight: string;
  plank: string;
  plankDark: string;
  wall: string;
  wallDark: string;
  wallLight: string;
  roof: string;
  roofDark: string;
  roofLight: string;
  floor: string;
  floorDark: string;
  floorLight: string;
  carpet: string;
  carpetDark: string;
  counter: string;
  counterDark: string;
  door: string;
  doorDark: string;
  lava: string;
  lavaDark: string;
  lavaHot: string;
  altar: string;
  altarDark: string;
  altarGlow: string;
  pillar: string;
  pillarDark: string;
  pillarLight: string;
}

const BASE: BiomeColors = {
  grass: '#78c060',
  grassDark: '#68ac54',
  grassLight: '#8ccf70',
  tall: '#3f8c48',
  tallDark: '#357a3e',
  tallLight: '#6fc070',
  flower: '#f8e0f0',
  path: '#e0c890',
  pathDark: '#c8ac74',
  pathLight: '#f4e4bc',
  sand: '#e8d8a0',
  sandDark: '#cdb87c',
  ash: '#8a8078',
  ashDark: '#6e665f',
  gravel: '#a89c90',
  gravelDark: '#8b8075',
  tree: '#2f8440',
  treeDark: '#1f5c2c',
  treeLight: '#63c46a',
  trunk: '#8a5a30',
  rock: '#9a8f86',
  rockDark: '#6f665f',
  rockLight: '#c0b6ab',
  water: '#3f7fd0',
  waterDeep: '#2a5c9e',
  waterLight: '#7fb8f0',
  plank: '#c8a06a',
  plankDark: '#9a7443',
  wall: '#c8b49a',
  wallDark: '#9c8a72',
  wallLight: '#e6d8c2',
  roof: '#d84040',
  roofDark: '#a42c2c',
  roofLight: '#f07070',
  floor: '#e8dcc0',
  floorDark: '#c8b898',
  floorLight: '#f6eeda',
  carpet: '#b0487c',
  carpetDark: '#8a3460',
  counter: '#b98a4e',
  counterDark: '#8d6733',
  door: '#7a4a24',
  doorDark: '#4e2d14',
  lava: '#e8501c',
  lavaDark: '#a02c0c',
  lavaHot: '#ffd050',
  altar: '#b8b0c8',
  altarDark: '#847c9c',
  altarGlow: '#f8f0ff',
  pillar: '#cfc6b8',
  pillarDark: '#9a9084',
  pillarLight: '#f0e8dc',
};

function palette(overrides: Partial<BiomeColors>): BiomeColors {
  return { ...BASE, ...overrides };
}

/** 每个生物群系一套配色（荒野/森林/岩地/洞窟/海岸/高原/火山/塔内/海底/岩浆/遗迹/孤岛/诞生岛） */
export const BIOME_COLORS: Record<BiomeId, BiomeColors> = {
  town: palette({ roof: '#e04848', roofDark: '#a83030' }),
  grass: palette({ flower: '#f8d8b0', path: '#dfc78c' }),
  forest: palette({
    grass: '#4f9c52',
    grassDark: '#3f7f42',
    grassLight: '#63b45f',
    tall: '#2f6b38',
    tallDark: '#255630',
    tallLight: '#4f9a50',
    tree: '#246b34',
    treeDark: '#123f22',
    treeLight: '#4aa456',
    trunk: '#6b4522',
  }),
  mid: palette({
    grass: '#b0a86c',
    grassDark: '#958d56',
    grassLight: '#c8c084',
    tall: '#7f8a4c',
    tallDark: '#66703c',
    rock: '#a08b6c',
    rockDark: '#6f5e46',
    rockLight: '#c6b494',
    path: '#cbb27e',
    water: '#4a86bc',
  }),
  cave: palette({
    floor: '#6a6480',
    floorDark: '#4c4760',
    floorLight: '#867f9c',
    gravel: '#585270',
    gravelDark: '#403a56',
    rock: '#4a4560',
    rockDark: '#2e2a40',
    rockLight: '#665f80',
    wall: '#3a3550',
    wallDark: '#241f36',
    wallLight: '#544d70',
    water: '#2f5f9c',
    waterDeep: '#1f3f70',
    pillar: '#5e5878',
    pillarDark: '#3a3452',
    pillarLight: '#7c7498',
    path: '#6f6888',
  }),
  coast: palette({
    grass: '#8ac46a',
    sand: '#f0dfa8',
    sandDark: '#d4bf84',
    water: '#3a86d8',
    waterDeep: '#245fa8',
    waterLight: '#8ccaf8',
    plank: '#cba267',
    rock: '#a89a86',
  }),
  north: palette({
    grass: '#7fb08c',
    grassDark: '#688f72',
    grassLight: '#9ec9a6',
    tall: '#4f7f62',
    tallDark: '#3f6a50',
    tallLight: '#74a882',
    rock: '#93a0a8',
    rockDark: '#6a767e',
    rockLight: '#bcc6cc',
    path: '#c6c0a8',
    water: '#4f92c0',
  }),
  volcano: palette({
    grass: '#8a6a52',
    grassDark: '#6f5340',
    grassLight: '#a58064',
    tall: '#7a5a48',
    tallDark: '#5c4034',
    ash: '#6e6058',
    ashDark: '#544842',
    gravel: '#8a6a56',
    rock: '#6b4038',
    rockDark: '#472722',
    rockLight: '#96584c',
    wall: '#5a332c',
    path: '#8a6a52',
    lava: '#f05018',
    lavaDark: '#a8280a',
    lavaHot: '#ffd860',
    tree: '#4a6b3a',
  }),
  tower: palette({
    floor: '#8f88a8',
    floorDark: '#6c6584',
    floorLight: '#ada6c4',
    wall: '#5c5478',
    wallDark: '#3b3554',
    wallLight: '#7c7398',
    pillar: '#b6aed0',
    pillarDark: '#877ea4',
    pillarLight: '#ded7ee',
    carpet: '#a04c8a',
    carpetDark: '#7a3466',
    altar: '#cfc4e8',
    altarDark: '#9c8fc0',
    altarGlow: '#ffffff',
    door: '#8a6a3c',
  }),
  seafloor: palette({
    floor: '#3f6a86',
    floorDark: '#2c4c64',
    floorLight: '#54849e',
    gravel: '#356078',
    gravelDark: '#244a5e',
    wall: '#24435c',
    wallDark: '#152c40',
    wallLight: '#3a6480',
    water: '#2c6ea8',
    waterDeep: '#1a4a78',
    waterLight: '#6cb2e0',
    altar: '#78c8d8',
    altarDark: '#4a94a8',
    altarGlow: '#e0fbff',
  }),
  magma: palette({
    floor: '#5c3a30',
    floorDark: '#40251f',
    floorLight: '#7a4f40',
    ash: '#5e4a42',
    ashDark: '#42322c',
    wall: '#472723',
    wallDark: '#2a1412',
    wallLight: '#6b3a30',
    lava: '#ff5a1c',
    lavaDark: '#b02e08',
    lavaHot: '#ffe070',
    altar: '#e8a05a',
    altarDark: '#a86a2c',
    altarGlow: '#fff0c0',
  }),
  ruins: palette({
    sand: '#e4d2a4',
    sandDark: '#c1ad7e',
    floor: '#cfc0a0',
    floorDark: '#a89878',
    floorLight: '#e8dcc0',
    wall: '#a89474',
    wallDark: '#7a6a50',
    wallLight: '#c8b494',
    pillar: '#c6b494',
    pillarDark: '#948268',
    altar: '#b4a8d0',
    altarDark: '#867ca4',
    altarGlow: '#f4f0ff',
  }),
  island: palette({
    sand: '#f4e2ac',
    sandDark: '#d8c184',
    grass: '#86c86c',
    water: '#38a0d0',
    waterDeep: '#1f7aa8',
    waterLight: '#8adcf4',
    tree: '#2f8a44',
    altar: '#c8b4e0',
    altarDark: '#94789c',
    altarGlow: '#f8f0ff',
  }),
  birth: palette({
    floor: '#6e5a94',
    floorDark: '#4e3e70',
    floorLight: '#8f78b4',
    gravel: '#5a4a80',
    gravelDark: '#40325f',
    water: '#3f5fd0',
    waterDeep: '#2a3fa0',
    waterLight: '#8fa8ff',
    pillar: '#b0a0d8',
    pillarDark: '#8474ac',
    pillarLight: '#e0d6f8',
    altar: '#d8b0f0',
    altarDark: '#a070c0',
    altarGlow: '#fff0ff',
  }),
};

// ─────────────────────────────────────────────── 瓦片绘制

type Ctx = CanvasRenderingContext2D;

function rngFor(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makePainter(ox: number, ctx: Ctx) {
  const px = (x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(ox + x, y, w, h);
  };
  return {
    px,
    base: (color: string) => px(0, 0, TILE, TILE, color),
    speckle: (rnd: () => number, count: number, color: string, size = 2) => {
      for (let i = 0; i < count; i++) {
        px(Math.floor(rnd() * (TILE / size)) * size, Math.floor(rnd() * (TILE / size)) * size, size, size, color);
      }
    },
  };
}

const PAINTERS: Record<TileId, (ctx: Ctx, ox: number, c: BiomeColors, rnd: () => number) => void> = {
  grass: (ctx, ox, c, rnd) => {
    const p = makePainter(ox, ctx);
    p.base(c.grass);
    p.speckle(rnd, 30, c.grassDark);
    p.speckle(rnd, 12, c.grassLight);
    for (const [gx, gy] of [
      [3, 9],
      [20, 3],
      [13, 21],
    ] as const) {
      p.px(gx * 2, gy * 2, 2, 6, c.grassDark);
      p.px(gx * 2 + 2, gy * 2 + 2, 2, 4, c.grassDark);
      p.px(gx * 2, gy * 2, 2, 2, c.grassLight);
    }
  },
  tallGrass: (ctx, ox, c, rnd) => {
    const p = makePainter(ox, ctx);
    p.base(c.tall);
    p.speckle(rnd, 16, c.tallDark);
    for (let x = 0; x < TILE; x += 4) {
      const top = 4 + Math.floor(rnd() * 4) * 2;
      p.px(x, top, 2, TILE - top - 2, c.tallDark);
      p.px(x + 2, top + 4, 2, TILE - top - 6, c.tallLight);
      p.px(x + 2, top + 4, 2, 2, c.tallLight);
    }
    p.px(0, TILE - 2, TILE, 2, c.tallDark);
  },
  flower: (ctx, ox, c, rnd) => {
    const p = makePainter(ox, ctx);
    p.base(c.grass);
    p.speckle(rnd, 20, c.grassDark);
    for (const [fx, fy] of [
      [6, 8],
      [20, 14],
      [12, 24],
    ] as const) {
      p.px(fx, fy, 4, 4, c.flower);
      p.px(fx + 1, fy + 1, 2, 2, '#f8f8d0');
    }
  },
  path: (ctx, ox, c, rnd) => {
    const p = makePainter(ox, ctx);
    p.base(c.path);
    p.speckle(rnd, 24, c.pathDark);
    p.speckle(rnd, 12, c.pathLight);
    p.px(0, 0, TILE, 2, c.pathDark);
    p.px(0, TILE - 2, TILE, 2, c.pathDark);
  },
  sand: (ctx, ox, c, rnd) => {
    const p = makePainter(ox, ctx);
    p.base(c.sand);
    p.speckle(rnd, 26, c.sandDark);
    p.speckle(rnd, 10, c.waterLight);
    p.px(4, 22, 6, 2, c.sandDark);
    p.px(20, 8, 6, 2, c.sandDark);
  },
  ash: (ctx, ox, c, rnd) => {
    const p = makePainter(ox, ctx);
    p.base(c.ash);
    p.speckle(rnd, 30, c.ashDark);
    p.speckle(rnd, 8, c.lavaHot);
  },
  gravel: (ctx, ox, c, rnd) => {
    const p = makePainter(ox, ctx);
    p.base(c.gravel);
    p.speckle(rnd, 28, c.gravelDark);
    p.speckle(rnd, 14, c.rockLight);
  },
  tree: (ctx, ox, c) => {
    const p = makePainter(ox, ctx);
    p.base(c.grass);
    p.px(13, 22, 6, 9, c.trunk);
    p.px(15, 22, 2, 9, c.treeLight);
    p.px(8, 3, 16, 2, c.treeDark);
    p.px(4, 5, 24, 4, c.treeDark);
    p.px(2, 9, 28, 8, c.treeDark);
    p.px(6, 17, 20, 4, c.treeDark);
    p.px(9, 5, 14, 4, c.tree);
    p.px(5, 9, 22, 8, c.tree);
    p.px(7, 17, 18, 3, c.tree);
    p.px(7, 7, 12, 4, c.treeLight);
    p.px(6, 10, 8, 5, c.treeLight);
    p.px(18, 12, 5, 4, c.treeLight);
  },
  rock: (ctx, ox, c, rnd) => {
    const p = makePainter(ox, ctx);
    p.base(c.rock);
    p.px(0, 0, TILE, 4, c.rockLight);
    p.px(0, TILE - 6, TILE, 6, c.rockDark);
    p.speckle(rnd, 14, c.rockDark);
    p.px(4, 10, 10, 6, c.rockLight);
    p.px(18, 16, 12, 8, c.rockLight);
    p.px(20, 6, 8, 6, c.rockDark);
  },
  water: (ctx, ox, c) => {
    const p = makePainter(ox, ctx);
    p.base(c.water);
    p.px(0, 0, TILE, 12, c.waterLight);
    p.px(0, 20, TILE, 12, c.waterDeep);
    for (const [wy, wx] of [
      [4, 2],
      [4, 18],
      [12, 10],
      [12, 26],
      [20, 0],
      [20, 16],
      [28, 6],
      [28, 22],
    ] as const) {
      p.px(wx, wy, 10, 2, c.waterLight);
      p.px(wx + 2, wy + 2, 8, 2, c.water);
    }
  },
  deepWater: (ctx, ox, c) => {
    const p = makePainter(ox, ctx);
    p.base(c.waterDeep);
    p.px(0, 8, TILE, 2, c.water);
    p.px(6, 20, 12, 2, c.water);
    p.px(20, 26, 10, 2, c.waterDeep);
  },
  plank: (ctx, ox, c) => {
    const p = makePainter(ox, ctx);
    p.base(c.water);
    for (let y = 2; y < TILE; y += 8) p.px(0, y, TILE, 6, c.plank);
    p.px(0, 0, TILE, 2, c.plankDark);
    p.px(0, TILE - 2, TILE, 2, c.plankDark);
    p.px(2, 0, 2, TILE, c.plankDark);
    p.px(28, 0, 2, TILE, c.plankDark);
  },
  wall: (ctx, ox, c) => {
    const p = makePainter(ox, ctx);
    p.base(c.wall);
    p.px(0, 0, TILE, 2, c.wallLight);
    p.px(0, TILE - 4, TILE, 4, c.wallDark);
    for (let y = 0; y < TILE; y += 10) p.px(0, y, TILE, 2, c.wallDark);
    p.px(14, 12, 4, 10, c.wallLight);
  },
  roof: (ctx, ox, c) => {
    const p = makePainter(ox, ctx);
    p.base(c.roof);
    p.px(0, 0, TILE, 3, c.roofLight);
    p.px(0, TILE - 4, TILE, 4, c.roofDark);
    for (let y = 6; y < TILE; y += 8) p.px(0, y, TILE, 2, c.roofDark);
    for (let x = 0; x < TILE; x += 8) p.px(x, 0, 2, TILE, c.roofDark);
  },
  floor: (ctx, ox, c, rnd) => {
    const p = makePainter(ox, ctx);
    p.base(c.floor);
    p.px(0, 0, TILE, 2, c.floorLight);
    p.px(0, TILE - 2, TILE, 2, c.floorDark);
    p.speckle(rnd, 10, c.floorDark);
  },
  carpet: (ctx, ox, c) => {
    const p = makePainter(ox, ctx);
    p.base(c.carpet);
    p.px(2, 2, TILE - 4, TILE - 4, c.carpetDark);
    p.px(6, 6, TILE - 12, TILE - 12, c.carpet);
  },
  counter: (ctx, ox, c) => {
    const p = makePainter(ox, ctx);
    p.base(c.floor);
    p.px(0, 4, TILE, 20, c.counter);
    p.px(0, 4, TILE, 4, c.floorLight);
    p.px(0, 22, TILE, 4, c.counterDark);
  },
  door: (ctx, ox, c) => {
    const p = makePainter(ox, ctx);
    p.base(c.wall);
    p.px(4, 2, 24, 30, c.door);
    p.px(4, 2, 24, 3, c.doorDark);
    p.px(24, 16, 3, 3, c.altarGlow);
    p.px(7, 8, 18, 2, c.doorDark);
    p.px(7, 20, 18, 2, c.doorDark);
  },
  stairs: (ctx, ox, c) => {
    const p = makePainter(ox, ctx);
    p.base(c.floorDark);
    for (let i = 0; i < 4; i++) {
      p.px(0, i * 8, TILE, 4, c.floor);
      p.px(0, i * 8 + 4, TILE, 4, c.floorLight);
    }
  },
  sign: (ctx, ox, c) => {
    const p = makePainter(ox, ctx);
    p.base(c.grass);
    p.px(14, 18, 4, 12, c.trunk);
    p.px(2, 4, 28, 16, c.counter);
    p.px(2, 4, 28, 3, c.floorLight);
    p.px(2, 17, 28, 3, c.counterDark);
    p.px(6, 9, 20, 2, c.doorDark);
    p.px(6, 13, 12, 2, c.doorDark);
  },
  lava: (ctx, ox, c, rnd) => {
    const p = makePainter(ox, ctx);
    p.base(c.lava);
    p.speckle(rnd, 16, c.lavaDark);
    p.px(0, 6, TILE, 3, c.lavaHot);
    p.px(12, 16, TILE - 12, 3, c.lavaHot);
    p.px(4, 24, 14, 3, c.lavaHot);
  },
  altar: (ctx, ox, c) => {
    const p = makePainter(ox, ctx);
    p.base(c.altar);
    p.px(0, 0, TILE, 3, c.altarGlow);
    p.px(0, TILE - 4, TILE, 4, c.altarDark);
    p.px(6, 6, TILE - 12, TILE - 12, c.altarDark);
    p.px(10, 10, TILE - 20, TILE - 20, c.altarGlow);
  },
  pillar: (ctx, ox, c) => {
    const p = makePainter(ox, ctx);
    p.base(c.floor);
    p.px(4, 0, 24, TILE, c.pillar);
    p.px(4, 0, 4, TILE, c.pillarLight);
    p.px(24, 0, 4, TILE, c.pillarDark);
    p.px(2, 0, 28, 3, c.pillarLight);
    p.px(2, TILE - 4, 28, 4, c.pillarDark);
  },
};

/** 程序化瓦片集：`TILE_SEMANTICS` 顺序横向排布（列号 = 语义索引） */
export function makeWorldTilesTexture(scene: Phaser.Scene, key: string, biome: BiomeId): void {
  if (scene.textures.exists(key)) return;
  const tex = scene.textures.createCanvas(key, TILE * TILE_SEMANTICS.length, TILE);
  if (!tex) return;
  const ctx = tex.getContext();
  ctx.imageSmoothingEnabled = false;
  const colors = BIOME_COLORS[biome] ?? BASE;
  TILE_SEMANTICS.forEach((id, index) => {
    const rnd = rngFor(index * 7919 + 13);
    PAINTERS[id](ctx, index * TILE, colors, rnd);
  });
  tex.refresh();
}

/**
 * 把 vendor 瓦片集按语义映射叠加到程序化瓦片集上：命中的格子换成 vendor 图，
 * 未映射的语义保持程序化绘制（素材不全也不会画错瓦片）。
 */
export function compositeVendorTiles(
  scene: Phaser.Scene,
  targetKey: string,
  vendorKey: string,
  spec: WorldTilesetSpec,
  tileSize = TILE,
): number {
  if (!scene.textures.exists(targetKey) || !scene.textures.exists(vendorKey)) return 0;
  const target = scene.textures.get(targetKey);
  const vendorImage = scene.textures.get(vendorKey).getSourceImage() as CanvasImageSource & {
    width?: number;
    height?: number;
  };
  const width = Number(vendorImage.width ?? 0);
  const height = Number(vendorImage.height ?? 0);
  if (!width || !height) return 0;
  const columns = Math.max(1, Math.floor(width / tileSize));
  const rows = Math.max(1, Math.floor(height / tileSize));
  const ctx = (target as Phaser.Textures.CanvasTexture).getContext?.();
  if (!ctx) return 0;
  ctx.imageSmoothingEnabled = false;
  let applied = 0;
  for (const [semantic, index] of Object.entries(spec.tiles)) {
    const slot = TILE_SEMANTICS.indexOf(semantic as TileId);
    if (slot < 0 || index === undefined || index < 0 || index >= columns * rows) continue;
    const sx = (index % columns) * tileSize;
    const sy = Math.floor(index / columns) * tileSize;
    ctx.clearRect(slot * tileSize, 0, tileSize, tileSize);
    ctx.drawImage(vendorImage as CanvasImageSource, sx, sy, tileSize, tileSize, slot * tileSize, 0, tileSize, tileSize);
    applied += 1;
  }
  if (applied > 0) (target as Phaser.Textures.CanvasTexture).refresh();
  return applied;
}

// ─────────────────────────────────────────────── NPC 小人

export { NPC_SPRITES, NPC_SPRITE_NAMES, npcLook, type NpcPalette } from './maps/npcs';

/** 自绘 NPC 带四个朝向；脚底固定在逻辑格的下沿。 */
export function makeNpcTexture(scene: Phaser.Scene, key: string, look: NpcPalette, facing: Facing = 'down', role = ''): void {
  if (scene.textures.exists(key)) return;
  const tex = scene.textures.createCanvas(key, 32, 40);
  if (!tex) return;
  const ctx = tex.getContext();
  ctx.imageSmoothingEnabled = false;
  drawCharacter(ctx, 0, 0, look, facing, 0, role);
  tex.refresh();
}

/** 生成全部生物群系的程序化瓦片集与全部 NPC 四向自绘贴图（已存在的 key 跳过） */
export function makeWorldPlaceholders(scene: Phaser.Scene): void {
  for (const biome of BIOMES) makeWorldTilesTexture(scene, worldTilesetKey(biome), biome);
  for (const [name, look] of Object.entries(NPC_SPRITES)) {
    if (scene.textures.exists(`world-sprite:${name}`)) continue;
    makeNpcTexture(scene, `world-sprite:${name}`, look);
    for (const facing of ['down', 'up', 'left', 'right'] as const) {
      makeNpcTexture(scene, `world-sprite:${name}:${facing}`, look, facing, name);
    }
  }
}

/** NPC 贴图 key（vendor 优先，缺省用程序化同名占位） */
export function npcTextureKey(name: string): string {
  return `world-sprite:${name}`;
}
