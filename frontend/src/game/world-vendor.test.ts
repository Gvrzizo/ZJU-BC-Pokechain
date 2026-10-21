import { createHash } from 'node:crypto';
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
  const raw = (available ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) : {}) as Record<string, unknown>;
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
      expect(height % 32).toBe(0);
      const columns = width / 32;
      expect(Number.isInteger(columns)).toBe(true);
      const indices = Object.values(tileset.tiles) as number[];
      expect(indices.length).toBeGreaterThan(0);
      expect(tileset.columns).toBe(columns);
      for (const index of [...indices, ...Object.values(tileset.autotiles ?? {}).flat()]) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(columns * height / 32);
      }
    }
  });

  it('语义名都是引擎认识的瓦片语义', () => {
    const known = new Set<string>(TILE_SEMANTICS);
    for (const tileset of manifest.tilesets) {
      for (const tileId of Object.keys(tileset.tiles)) expect(known.has(tileId)).toBe(true);
    }
  });

  it('每张原作图像都有匹配的内容摘要，避免旧缓存覆盖新素材', () => {
    for (const entry of [...manifest.tilesets, ...manifest.sprites]) {
      expect(createHash('sha256').update(readFileSync(`${ASSET_DIR}${entry.image}`)).digest('hex')).toBe(entry.sha256);
    }
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

  it('主角与四向 NPC 完整保留原作比例，建筑保留整栋占地', () => {
    const heroes = manifest.sprites.filter((s) => s.name.startsWith('hero'));
    expect(heroes.map((s) => s.name)).toContain('hero');
    for (const hero of heroes) {
      expect(pngSize(`${ASSET_DIR}${hero.image}`)).toEqual({ width: 96, height: 256 });
      expect([hero.frameWidth, hero.frameHeight]).toEqual([32, 64]);
    }

    const npcs = manifest.sprites.filter((s) => !s.name.startsWith('hero') && !s.name.startsWith('building-') && !s.name.startsWith('battle-'));
    expect(npcs.map(s => s.name)).toEqual(expect.arrayContaining(['mom:down', 'mom:up', 'mom:left', 'mom:right']));
    for (const name of ['center', 'shop', 'house']) {
      const sprite = manifest.sprites.find(s => s.name === `building-${name}`)!;
      const side = name === 'house' ? 160 : 128;
      expect(pngSize(`${ASSET_DIR}${sprite.image}`)).toEqual({ width: side, height: side });
    }
    for (const sprite of npcs) {
      expect(pngSize(`${ASSET_DIR}${sprite.image}`)).toEqual({ width: 32, height: 64 });
      expect([sprite.frameWidth, sprite.frameHeight]).toEqual([32, 64]);
    }
  });
});
