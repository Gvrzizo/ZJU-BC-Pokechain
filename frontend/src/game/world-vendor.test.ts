import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BIOMES } from './maps';
import { TILE_SEMANTICS, type TileId } from './maps/tiles';
import { parseWorldManifest, tileIndexFor, type WorldManifest } from './world-assets';

/**
 * vendor world 素材包（`tools/build-world-assets.py` 生成，版权素材不入库）：
 * 交给地图引擎的清单必须与 `world-assets.ts` 的契约对得上，否则运行时会静默回退程序化瓦片。
 * 素材包不存在时（干净 clone / CI）整组跳过。
 */
const MANIFEST_PATH = fileURLToPath(
  new URL('../../public/assets/vendor/world/manifest.json', import.meta.url),
);
const ASSET_DIR = fileURLToPath(new URL('../../public/assets/vendor/world/', import.meta.url));
const available = existsSync(MANIFEST_PATH);

/** 不依赖图像库读 PNG 的 IHDR：宽度/高度在固定偏移上 */
function pngSize(path: string): { width: number; height: number } {
  const buf = readFileSync(path);
  expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe.skipIf(!available)('vendor world 素材包', () => {
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Record<string, unknown>;
  const manifest = parseWorldManifest(raw) as WorldManifest;

  it('清单能按契约解析，且瓦片尺寸是 32×32', () => {
    expect(manifest).not.toBeNull();
    expect(manifest.tileSize).toBe(32);
    expect(manifest.tilesets.length).toBeGreaterThan(0);
    expect(manifest.sprites.length).toBeGreaterThan(0);
  });

  it('14 个生物群系里除室内外都有对应瓦片集', () => {
    const covered = new Set(manifest.tilesets.flatMap((t) => t.biomes));
    for (const biome of BIOMES) expect(covered.has(biome)).toBe(true);
  });

  it('每张瓦片集的图都存在，格子数与 tiles 索引都在范围内', () => {
    for (const tileset of manifest.tilesets) {
      const { width, height } = pngSize(`${ASSET_DIR}${tileset.image}`);
      expect(height).toBe(32);
      const columns = width / 32;
      expect(Number.isInteger(columns)).toBe(true);
      const indices = Object.values(tileset.tiles) as number[];
      expect(indices.length).toBeGreaterThan(0);
      for (const index of indices) expect(index).toBeLessThan(columns);
    }
  });

  it('语义名都是引擎认识的瓦片语义', () => {
    const known = new Set<string>(TILE_SEMANTICS);
    for (const tileset of manifest.tilesets) {
      for (const tileId of Object.keys(tileset.tiles)) expect(known.has(tileId)).toBe(true);
    }
  });

  it('清单里的回退语义顺序与 maps/tiles.ts 的 TILE_SEMANTICS 一致', () => {
    const fallback = (raw as { proceduralFallback?: { semanticNames?: string[] } }).proceduralFallback;
    expect(fallback?.semanticNames).toEqual([...TILE_SEMANTICS]);
  });

  it('起点镇（town）与野外（grass）能拿到地面/建筑语义', () => {
    for (const tileId of ['grass', 'path', 'tree', 'sand', 'water'] as TileId[]) {
      expect(tileIndexFor(manifest, 'grass', tileId), `grass.${tileId}`).not.toBeNull();
    }
    // 野外地图也有洞口 / 路牌（走 `door` 与 `sign`）
    for (const tileId of ['grass', 'path', 'tree', 'roof', 'wall', 'door', 'sign'] as TileId[]) {
      expect(tileIndexFor(manifest, 'town', tileId), `town.${tileId}`).not.toBeNull();
    }
    for (const tileId of ['door', 'sign'] as TileId[]) {
      expect(tileIndexFor(manifest, 'grass', tileId), `grass.${tileId}`).not.toBeNull();
    }
  });

  it('主角行走图是 3 列 × 4 行 32×32，NPC 是单帧 32×32', () => {
    const heroes = manifest.sprites.filter((s) => s.name.startsWith('hero'));
    expect(heroes.map((s) => s.name)).toContain('hero');
    for (const hero of heroes) {
      expect(pngSize(`${ASSET_DIR}${hero.image}`)).toEqual({ width: 96, height: 128 });
      expect([hero.frameWidth, hero.frameHeight]).toEqual([32, 32]);
    }

    const npcs = manifest.sprites.filter((s) => !s.name.startsWith('hero'));
    expect(npcs.length).toBeGreaterThanOrEqual(8);
    for (const sprite of npcs) {
      expect(pngSize(`${ASSET_DIR}${sprite.image}`)).toEqual({ width: 32, height: 32 });
      expect([sprite.frameWidth, sprite.frameHeight]).toEqual([32, 32]);
    }
  });
});
