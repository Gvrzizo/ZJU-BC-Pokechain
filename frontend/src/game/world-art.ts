import type Phaser from 'phaser';
import type { MapDef } from './maps';
import { TILE } from './textures';
import { worldSpriteKey, worldTilesetKey, type WorldTilesetSpec } from './world-assets';
import { mapBlits, paintMap } from './native-map';

/** Composite original pixels. Procedural art is used only when the corresponding asset is absent. */
export function makeMapArt(scene: Phaser.Scene, map: MapDef): string {
  const key = `world-map-art:${map.id}`;
  if (scene.textures.exists(key)) return key;
  const texture = scene.textures.createCanvas(key, map.width * TILE, map.height * TILE);
  if (!texture) return worldTilesetKey(map.biome);
  const original = scene.registry.get(`world-native:${map.biome}`) as { key: string; spec: WorldTilesetSpec } | undefined;
  const images: Record<string, CanvasImageSource> = {
    fallback: scene.textures.get(worldTilesetKey(map.biome)).getSourceImage() as CanvasImageSource,
  };
  if (original) images.native = scene.textures.get(original.key).getSourceImage() as CanvasImageSource;
  const buildings = new Set<string>();
  for (const name of ['center', 'shop', 'house']) {
    const sprite = worldSpriteKey(`building-${name}`);
    if (!scene.textures.exists(sprite)) continue;
    buildings.add(name);
    images[`building-${name}`] = scene.textures.get(sprite).getSourceImage() as CanvasImageSource;
  }
  paintMap(texture.getContext(), mapBlits(map, original?.spec, buildings), images);
  texture.refresh();
  return key;
}
