import { describe, expect, it } from 'vitest';
import {
  WORLD_ASSET_DIR,
  canonTileKey,
  parseSpriteSpec,
  parseTilesetSpec,
  parseWorldManifest,
  semanticOf,
  tileIndexFor,
  tilesetFor,
  worldImageUrl,
  worldSpriteKey,
  worldTilesetKey,
  type WorldManifest,
} from './world-assets';

/**
 * world 素材契约解析（构建脚本产出的 `public/assets/vendor/world/manifest.json`）：
 * 容错解析 + 缺失回退（解析不出来就全程序化瓦片，不会让游戏起不来）。
 */
describe('瓦片集清单解析', () => {
  it('标准写法：biome + tiles 语义映射（大小写/连字符写法都认）', () => {
    const spec = parseTilesetSpec({
      biome: 'forest',
      image: 'tiles/forest.png',
      sha256: 'abc',
      columns: 8,
      tiles: { grass: 0, 'tall-grass': 1, tallGrass: 2, tree: 4, water: 40 },
    });
    expect(spec).toMatchObject({ biomes: ['forest'], image: 'tiles/forest.png', sha256: 'abc', columns: 8 });
    expect(spec?.tiles).toEqual({ grass: 0, tallGrass: 2, tree: 4, water: 40 });
  });

  it('也接受 biomes 数组、tiles 数组（下标即列号）与 tileOrder', () => {
    const spec = parseTilesetSpec({
      biomes: ['cave', 'tower'],
      image: 'tiles/cave.png',
      tiles: ['grass', 'tallGrass', { name: 'tree', index: 7 }],
    });
    expect(spec?.biomes).toEqual(['cave', 'tower']);
    expect(spec?.tiles).toEqual({ grass: 0, tallGrass: 1, tree: 7 });

    const ordered = parseTilesetSpec({ biome: 'coast', image: 'coast.png', tileOrder: ['grass', 'sand'] });
    expect(ordered?.tiles).toEqual({ grass: 0, sand: 1 });
  });

  it('非法输入被丢弃：没有图、没有有效语义、未知生物群系', () => {
    expect(parseTilesetSpec(null)).toBeNull();
    expect(parseTilesetSpec({ image: 'a.png' })).toBeNull();
    expect(parseTilesetSpec({ biome: 'forest' })).toBeNull();
    expect(parseTilesetSpec({ biome: 'forest', image: 'a.png', tiles: { nope: 3 } })).toBeNull();
    expect(parseTilesetSpec({ biome: 'atlantis', image: 'a.png', tiles: { grass: 0 } })?.biomes).toEqual([]);
  });

  it('整包解析：tilesets + sprites，全空返回 null', () => {
    const manifest = parseWorldManifest({
      version: 1,
      tilesets: [{ biome: 'town', image: 'town.png', tiles: { grass: 0 } }],
      sprites: [{ name: 'nurse', image: 'sprites/nurse.png', frameWidth: 32, frameHeight: 32 }],
    });
    expect(manifest).toMatchObject({ version: 1, tileSize: 32 });
    expect(manifest?.tilesets).toHaveLength(1);
    expect(manifest?.sprites[0]).toMatchObject({ name: 'nurse', frameWidth: 32 });
    expect(parseWorldManifest({ tilesets: [], sprites: [] })).toBeNull();
    expect(parseWorldManifest('nope')).toBeNull();
    expect(parseWorldManifest({ tilesets: 'nope' })).toBeNull();
  });

  it('解析素材脚本真正产出的清单结构（frontend/tools/build-world-assets.py）', () => {
    // 该脚本按本文件的契约生成 manifest：多出来的元信息（rows/semantics/source/…）一律忽略
    const manifest = parseWorldManifest({
      version: 1,
      tileSize: 32,
      nativeTileSize: 16,
      scale: 2,
      generatedBy: 'frontend/tools/build-world-assets.py',
      tilesets: [
        {
          biomes: ['grass', 'forest', 'mid', 'north', 'coast', 'island', 'birth'],
          image: 'nature.png',
          columns: 29,
          rows: 1,
          tileSize: 32,
          tileCount: 29,
          imageSize: { width: 928, height: 32 },
          tiles: { grass: 0, tallGrass: 1, flower: 2, path: 3, sand: 5, tree: 8, rock: 12, water: 14 },
          semantics: { grass: [{ index: 0, x: 0, y: 0, source: { tileset: 'general', metatile: 1 } }] },
        },
        { biomes: ['town'], image: 'town.png', columns: 60, tiles: { roof: 9, wall: 15, door: 30, sign: 29 } },
      ],
      sprites: [
        { name: 'nurse', image: 'sprites/nurse.png', frameWidth: 32, frameHeight: 32, frameCount: 1 },
        { name: 'hero', image: 'sprites/hero.png', frameWidth: 32, frameHeight: 32 },
      ],
      npcSheets: { dir: 'npc', files: [] },
      proceduralFallback: { textureKeyPattern: 'world-tiles:<biome>' },
    });
    expect(manifest?.tilesets).toHaveLength(2);
    expect(tilesetFor(manifest, 'forest')?.image).toBe('nature.png');
    expect(tileIndexFor(manifest, 'forest', 'tallGrass')).toBe(1);
    expect(tileIndexFor(manifest, 'town', 'door')).toBe(30);
    expect(tileIndexFor(manifest, 'cave', 'grass')).toBeNull(); // 这个群系没有瓦片集 → 程序化
    expect(manifest?.sprites.map((s) => s.name)).toEqual(['nurse', 'hero']);
  });

  it('sprite 缺省帧尺寸用 32×32，缺名字/图则丢弃', () => {
    expect(parseSpriteSpec({ name: 'clerk', image: 'c.png' })).toMatchObject({ frameWidth: 32, frameHeight: 32 });
    expect(parseSpriteSpec({ image: 'c.png' })).toBeNull();
    expect(parseSpriteSpec({ name: 'clerk' })).toBeNull();
  });

  it('语义名归一化：tallGrass / tall_grass / tall-grass 等价', () => {
    expect(canonTileKey('tallGrass')).toBe(canonTileKey('tall_grass'));
    expect(canonTileKey('deep_water')).toBe(canonTileKey('deepWater'));
    expect(semanticOf('deep-water')).toBe('deepWater');
    expect(semanticOf('nope')).toBeUndefined();
  });
});

describe('key 与路径', () => {
  it('瓦片集 / sprite key 命名稳定', () => {
    expect(worldTilesetKey('forest')).toBe('world-tiles:forest');
    expect(worldSpriteKey('nurse')).toBe('world-sprite:nurse');
  });

  it('相对路径补全成 /assets/vendor/world/…，绝对路径与 URL 原样返回', () => {
    expect(worldImageUrl('tiles/forest.png')).toBe(`${WORLD_ASSET_DIR}/tiles/forest.png`);
    expect(worldImageUrl('./tiles/forest.png')).toBe(`${WORLD_ASSET_DIR}/tiles/forest.png`);
    expect(worldImageUrl('/assets/vendor/world/x.png')).toBe('/assets/vendor/world/x.png');
    expect(worldImageUrl('https://cdn.example.com/x.png')).toBe('https://cdn.example.com/x.png');
  });

  it('查询：某生物群系的瓦片集与语义列号（没有就回退程序化 → null）', () => {
    const manifest: WorldManifest = {
      version: 1,
      tileSize: 32,
      tilesets: [{ biomes: ['forest'], image: 'forest.png', tiles: { grass: 0, tree: 5 } }],
      sprites: [],
    };
    expect(tilesetFor(manifest, 'forest')?.image).toBe('forest.png');
    expect(tileIndexFor(manifest, 'forest', 'tree')).toBe(5);
    expect(tileIndexFor(manifest, 'forest', 'lava')).toBeNull();
    expect(tileIndexFor(manifest, 'town', 'grass')).toBeNull();
    expect(tileIndexFor(null, 'forest', 'grass')).toBeNull();
  });
});


describe('原作过渡块与人物几何', () => {
  it('只接受九格非负整数过渡块，64px 高的原作人物帧不被压缩', () => {
    const spec = parseTilesetSpec({ image: 'native.png', tiles: { grass: 1 },
      autotiles: { path: [0,1,2,3,4,5,6,7,8], water: [0,1], grass: [-1,0,1,2,3,4,5,6,7] } });
    expect(spec?.autotiles).toEqual({ path: [0,1,2,3,4,5,6,7,8] });
    expect(parseSpriteSpec({ name: 'hero', image: 'hero.png', frameWidth: 32, frameHeight: 64 })?.frameHeight).toBe(64);
  });
});
