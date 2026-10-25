import { TILE_SEMANTICS, type TileId } from './maps/tiles';
import type { BiomeId } from './maps/types';

/**
 * world 素材契约（`build-world-assets.py` 生成的 `public/assets/vendor/world/` 素材包）：
 *
 * ```jsonc
 * {
 *   "version": 2,
 *   "tileSize": 32,
 *   "tilesets": [
 *     {
 *       "biome": "forest",              // BIOMES 里的生物群系 id（也接受 biomes: [...]）
 *       "image": "tiles/forest.png",    // 相对 world/ 的路径（也接受 /assets/... 绝对路径）
 *       "sha256": "…",                  // 可选：与后端 manifest 条目对得上时前端会校验
 *       "columns": 8,                   // 可选：瓦片集列数（缺省按图宽推断）
 *       "tiles": { "grass": 0, "tallGrass": 1, "tree": 4, "path": 6 }   // 语义名 → 行优先瓦片索引
 *       // 也接受 "tileOrder": ["grass", "tallGrass", "tree", ...]（下标即瓦片索引）
 *     }
 *   ],
 *   "sprites": [
 *     { "name": "nurse", "image": "sprites/nurse.png", "frameWidth": 32, "frameHeight": 64 },
 *     { "name": "hero", "image": "sprites/hero.png", "frameWidth": 32, "frameHeight": 64 }
 *   ]
 * }
 * ```
 *
 * **缺失即回退**：manifest 不存在 / 解析失败 / 某个生物群系没有瓦片集时，BootScene 用
 * `world-textures.ts` 的程序化瓦片集（按生物群系配色）顶替；单个语义缺映射时也用程序化那一格。
 * 解析函数是纯函数（不碰 Phaser / fetch），方便单测覆盖容错路径。
 */

export const WORLD_ASSET_DIR = '/assets/vendor/world';
export const WORLD_MANIFEST_URL = `${WORLD_ASSET_DIR}/manifest.json`;
export const WORLD_TILE_SIZE = 32;
export const WORLD_MANIFEST_VERSION = 2;

export interface WorldTilesetSpec {
  biomes: BiomeId[];
  image: string;
  sha256?: string;
  columns?: number;
  /** 语义名 → 行优先瓦片索引 */
  tiles: Partial<Record<TileId, number>>;
  /** 原作 3×3 邻接过渡块（左上至右下），运行时按 8px 象限拼接 */
  autotiles?: Partial<Record<TileId, number[]>>;
  /** 岩壁的完整 3×3 方向块；不按道路的四象限方式裁切。 */
  wallTiles?: number[];
}

export interface WorldSpriteSpec {
  name: string;
  image: string;
  frameWidth: number;
  frameHeight: number;
  sha256?: string;
}

export interface WorldManifest {
  version: number;
  tileSize: number;
  tilesets: WorldTilesetSpec[];
  sprites: WorldSpriteSpec[];
}

const BIOME_SET = new Set<string>([
  'town',
  'grass',
  'forest',
  'mid',
  'cave',
  'coast',
  'north',
  'volcano',
  'tower',
  'seafloor',
  'magma',
  'ruins',
  'island',
  'birth',
]);

/** 语义名归一化：`tallGrass` / `tall_grass` / `tall-grass` 都等价 */
export function canonTileKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const SEMANTIC_BY_CANON = new Map<string, TileId>(
  TILE_SEMANTICS.map((id) => [canonTileKey(id), id]),
);

export function semanticOf(name: string): TileId | undefined {
  return SEMANTIC_BY_CANON.get(canonTileKey(name));
}

/** 瓦片集 key / sprite key（BootScene 与场景共用同一命名） */
export function worldTilesetKey(biome: BiomeId | string): string {
  return `world-tiles:${biome}`;
}

export function worldSpriteKey(name: string): string {
  return `world-sprite:${name}`;
}

/** 相对路径（`tiles/forest.png`）补成 `/assets/vendor/world/...`；绝对路径原样返回 */
export function worldImageUrl(image: string): string {
  if (/^(https?:)?\/\//.test(image) || image.startsWith('/')) return image;
  return `${WORLD_ASSET_DIR}/${image.replace(/^\.?\//, '')}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/** 解析单个瓦片集条目；没有任何有效语义映射时返回 null */
export function parseTilesetSpec(raw: unknown): WorldTilesetSpec | null {
  const entry = asRecord(raw);
  if (!entry) return null;
  const image = asString(entry.image) ?? asString(entry.file) ?? asString(entry.url);
  if (!image) return null;

  const biomesRaw = entry.biomes ?? entry.biome ?? entry.zones;
  const biomes = (Array.isArray(biomesRaw) ? biomesRaw : [biomesRaw])
    .map((b) => asString(b))
    .filter((b): b is string => !!b && BIOME_SET.has(b)) as BiomeId[];

  const tiles: Partial<Record<TileId, number>> = {};
  const tilesRaw = entry.tiles;
  if (Array.isArray(tilesRaw)) {
    // [{name:'grass', index:0}, ...] 或 ['grass','tallGrass', ...]（下标即瓦片索引）
    tilesRaw.forEach((item, index) => {
      const name = asString(item) ?? asString(asRecord(item)?.name);
      const explicit = asRecord(item)?.index ?? asRecord(item)?.col;
      const col = asNumber(explicit) ?? index;
      const semantic = name ? semanticOf(name) : undefined;
      if (semantic && col >= 0) tiles[semantic] = Math.floor(col);
    });
  } else {
    const map = asRecord(tilesRaw);
    if (map) {
      for (const [name, value] of Object.entries(map)) {
        const semantic = semanticOf(name);
        const col = asNumber(asRecord(value)?.index ?? asRecord(value)?.col ?? value);
        if (semantic && col !== undefined && col >= 0) tiles[semantic] = Math.floor(col);
      }
    }
  }
  const order = asArray(entry.tileOrder);
  order.forEach((name, index) => {
    const semantic = asString(name) ? semanticOf(name as string) : undefined;
    if (semantic && tiles[semantic] === undefined) tiles[semantic] = index;
  });

  if (Object.keys(tiles).length === 0) return null;
  const autotiles: Partial<Record<TileId, number[]>> = {};
  for (const [name, values] of Object.entries(asRecord(entry.autotiles) ?? {})) {
    const semantic = semanticOf(name);
    if (semantic && Array.isArray(values) && values.length === 9 &&
        values.every((v) => Number.isInteger(v) && v >= 0)) autotiles[semantic] = values;
  }
  return {
    autotiles,
    wallTiles: Array.isArray(entry.wallTiles) && entry.wallTiles.length === 9 &&
      entry.wallTiles.every((v) => Number.isInteger(v) && v >= 0) ? entry.wallTiles : undefined,
    biomes: biomes.length > 0 ? biomes : [],
    image,
    sha256: asString(entry.sha256),
    columns: asNumber(entry.columns),
    tiles,
  };
}

export function parseSpriteSpec(raw: unknown): WorldSpriteSpec | null {
  const entry = asRecord(raw);
  if (!entry) return null;
  const name = asString(entry.name) ?? asString(entry.id);
  const image = asString(entry.image) ?? asString(entry.file) ?? asString(entry.url);
  if (!name || !image) return null;
  return {
    name,
    image,
    frameWidth: Math.max(1, Math.floor(asNumber(entry.frameWidth) ?? WORLD_TILE_SIZE)),
    frameHeight: Math.max(1, Math.floor(asNumber(entry.frameHeight) ?? WORLD_TILE_SIZE)),
    sha256: asString(entry.sha256),
  };
}

/** 解析 world manifest（容错：非法结构返回 null，字段缺失按缺省处理） */
export function parseWorldManifest(raw: unknown): WorldManifest | null {
  const root = asRecord(raw);
  if (!root) return null;
  const tilesets = asArray(root.tilesets)
    .map(parseTilesetSpec)
    .filter((t): t is WorldTilesetSpec => t !== null);
  const sprites = asArray(root.sprites)
    .map(parseSpriteSpec)
    .filter((s): s is WorldSpriteSpec => s !== null);
  if (tilesets.length === 0 && sprites.length === 0) return null;
  return {
    version: Math.floor(asNumber(root.version) ?? WORLD_MANIFEST_VERSION),
    tileSize: Math.floor(asNumber(root.tileSize) ?? WORLD_TILE_SIZE),
    tilesets,
    sprites,
  };
}

/** 拉取 world manifest（404 / 解析失败 → null，调用方回退程序化瓦片） */
export async function fetchWorldManifest(
  url: string = WORLD_MANIFEST_URL,
): Promise<WorldManifest | null> {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    return parseWorldManifest(await res.json());
  } catch {
    return null;
  }
}

export function tilesetFor(manifest: WorldManifest | null, biome: BiomeId | string): WorldTilesetSpec | undefined {
  if (!manifest) return undefined;
  return manifest.tilesets.find((t) => t.biomes.includes(biome as BiomeId));
}

/** 语义瓦片在 vendor 瓦片集里的列号；没有对应 vendor 瓦片集 / 没映射该语义 → null（用程序化那一格） */
export function tileIndexFor(
  manifest: WorldManifest | null,
  biome: BiomeId | string,
  semantic: TileId,
): number | null {
  const spec = tilesetFor(manifest, biome);
  const index = spec?.tiles[semantic];
  return index === undefined ? null : index;
}
