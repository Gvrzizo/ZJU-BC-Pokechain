import Phaser from 'phaser';
import type { AssetManifestEntry } from '@/types';
import { useAssetsStore } from '@/stores/assets';
import { fetchSha256 } from '@/utils/hash';
import {
  CRY_SPECIES_IDS,
  cryKey,
  cryUrl,
  pokemonBackSpriteUrl,
  pokemonBackTextureKey,
  pokemonSpriteUrl,
  pokemonTextureKey,
} from '../mon-assets';
import { BIOMES, type BiomeId } from '../maps';
import { makeHeroAnims, makeHeroSpritesheet, makePokemonPlaceholder, makeTilesTexture } from '../textures';
import {
  fetchWorldManifest,
  worldImageUrl,
  worldSpriteKey,
  worldTilesetKey,
  type WorldManifest,
} from '../world-assets';
import { compositeVendorTiles, makeWorldPlaceholders } from '../world-textures';

/** 全国图鉴上限：第三世代 #1–386（正面/背面 sprite 与叫声按此范围预载） */
const DEX_COUNT = 386;

/**
 * BootScene：
 * 1. 拉取 /assets/manifest（后端不可用时静默降级为全占位）
 * 2. 尝试从 /assets/vendor/ 加载用户素材（宝可梦正/背面图、叫声、瓦片、主角），
 *    存在则用 Web Crypto 校验 sha256（manifest 中有对应条目时才校验，无条目视为本地覆盖直接使用）
 * 3. 拉取 world 素材包 `public/assets/vendor/world/manifest.json`（见 `world-assets.ts` 契约）：
 *    vendor 瓦片集按语义映射**叠加**到程序化瓦片集上，缺什么就用程序化的那一格；
 *    怪物/NPC 贴图同理（vendor 优先，缺省占位）
 * 4. 缺失 / 校验失败的资源用程序化占位像素贴图顶替
 */
export class BootScene extends Phaser.Scene {
  private nextScene = 'OverworldScene';
  private statusText!: Phaser.GameObjects.Text;
  private manifestByPath = new Map<string, AssetManifestEntry>();
  /** 本轮载入的 world 素材包（缺失/解析失败为 null → 全程序化瓦片） */
  private vendorWorld: WorldManifest | null = null;

  constructor() {
    super('BootScene');
  }

  init(data: { next?: string }) {
    if (data?.next) this.nextScene = data.next;
  }

  preload() {
    this.statusText = this.add
      .text(480, 320, 'LOADING...', {
        fontFamily: '"Press Start 2P", monospace',
        fontSize: '16px',
        color: '#f8f0d8',
      })
      .setOrigin(0.5);

    // vendor 覆盖候选：与 public/assets/vendor/ 命名约定一一对应
    this.load.image('tiles', '/assets/vendor/tiles.png');
    this.load.image('hero', '/assets/vendor/hero.png');
    for (let id = 1; id <= DEX_COUNT; id++) {
      // 图鉴/敌方视角正面图 + 我方视角背面图（存在即覆盖，不存在静默回退占位/正面图）
      this.load.image(pokemonTextureKey(id), pokemonSpriteUrl(id));
      this.load.image(pokemonBackTextureKey(id), pokemonBackSpriteUrl(id));
    }
    // 叫声（仅出场种族，Phaser 以 Web Audio 解码，按 key 缓存）
    for (const id of CRY_SPECIES_IDS) {
      this.load.audio(cryKey(id), cryUrl(id));
    }
  }

  async create() {
    const assets = useAssetsStore();
    this.statusText.setText('FETCH MANIFEST...');
    await assets.fetchManifest();

    // manifest: [{uri, sha256, size}]，uri 形如 /assets/vendor/xxx.png 或 MinIO 签名 URL
    this.manifestByPath = new Map(
      assets.manifest
        .filter((m) => m.uri.includes('/assets/vendor/'))
        .map((m) => {
          const path = m.uri.slice(m.uri.indexOf('/assets/vendor/'));
          return [path, m];
        }),
    );

    this.statusText.setText('VERIFY VENDOR ASSETS...');
    const imageCandidates = [
      { key: 'tiles', url: '/assets/vendor/tiles.png' },
      { key: 'hero', url: '/assets/vendor/hero.png' },
      ...Array.from({ length: DEX_COUNT }, (_, i) => ({
        key: pokemonTextureKey(i + 1),
        url: pokemonSpriteUrl(i + 1),
      })),
      ...Array.from({ length: DEX_COUNT }, (_, i) => ({
        key: pokemonBackTextureKey(i + 1),
        url: pokemonBackSpriteUrl(i + 1),
      })),
    ];
    for (const { key, url } of imageCandidates) {
      if (!this.textures.exists(key)) continue; // 文件不存在 → 保持占位
      await this.acceptVendor(key, url);
    }
    for (const id of CRY_SPECIES_IDS) {
      const key = cryKey(id);
      if (!this.cache.audio.exists(key)) continue;
      await this.acceptVendor(key, cryUrl(id));
    }

    // world 素材包（多地图瓦片集 + NPC）：缺失即回退程序化
    this.statusText.setText('LOAD WORLD TILES...');
    await this.loadWorldAssets();

    // 占位生成（已存在 vendor 贴图的 key 会被跳过）
    this.statusText.setText('GENERATE PLACEHOLDERS...');
    makeTilesTexture(this, 'tiles');
    if (this.textures.exists('hero')) {
      // 原作人物保持 32×64/帧；兼容旧包 32×32 与占位 32×40。
      const texture = this.textures.get('hero');
      const src = texture.getSourceImage() as HTMLImageElement;
      const frameHeight = src.height / 4;
      if (src.width === 96 && [32, 40, 64].includes(frameHeight)) {
        // world manifest 里若已按 spritesheet 载入，帧已经切好了，不必再补
        if (texture.frameTotal <= 1) {
          for (let i = 0; i < 12; i++) {
            texture.add(i, 0, (i % 3) * 32, Math.floor(i / 3) * frameHeight, 32, frameHeight);
          }
        }
      } else {
        console.warn('[assets] hero.png 帧几何无效，使用占位行走图');
        this.textures.remove('hero');
        assets.markPlaceholder('hero');
      }
    }
    makeHeroSpritesheet(this, 'hero');
    makeHeroAnims(this);
    // world 瓦片集/NPC：先程序化，再用 vendor 瓦片叠加（缺失的语义保持程序化）
    makeWorldPlaceholders(this);
    this.composeWorldTiles();
    for (let id = 1; id <= DEX_COUNT; id++) {
      if (!this.textures.exists(pokemonTextureKey(id))) {
        makePokemonPlaceholder(this, pokemonTextureKey(id), id);
        assets.markPlaceholder(pokemonTextureKey(id));
      }
    }

    assets.setReady();
    this.scene.start(this.nextScene);
  }

  // ─────────────────────────────────────────── world 素材包

  /** 拉取 world manifest → 载入 vendor 瓦片集与 NPC 贴图 → 校验 sha256（manifest 里有条目才校验） */
  private async loadWorldAssets(): Promise<void> {
    const assets = useAssetsStore();
    const manifest: WorldManifest | null = await fetchWorldManifest();
    if (!manifest) {
      this.vendorWorld = null;
      return;
    }
    this.vendorWorld = manifest;

    const images: { key: string; url: string; sha256?: string }[] = [];
    for (const [index, tileset] of manifest.tilesets.entries()) {
      images.push({
        key: `world-vendor-tiles:${index}`,
        url: worldImageUrl(tileset.image) + (tileset.sha256 ? `?v=${tileset.sha256.slice(0, 12)}` : ''),
        sha256: tileset.sha256,
      });
    }
    for (const sprite of manifest.sprites) {
      images.push({
        key: worldSpriteKey(sprite.name),
        url: worldImageUrl(sprite.image) + (sprite.sha256 ? `?v=${sprite.sha256.slice(0, 12)}` : ''),
        sha256: sprite.sha256,
      });
    }
    await this.loadImages(images);

    for (const image of images) {
      if (!this.textures.exists(image.key)) continue;
      const ok = await this.verifyWorldImage(image);
      if (ok) assets.markVendor(image.key);
    }

    // world 素材包给了主角行走图：用它替换占位/旧图（3 列 4 行，按资源实际帧高切片）
    if (manifest.sprites.some((s) => s.name === 'hero') && this.textures.exists(worldSpriteKey('hero'))) {
      if (this.textures.exists('hero')) this.textures.remove('hero');
      this.textures.renameTexture(worldSpriteKey('hero'), 'hero');
      // 帧由 create() 按图片实际几何统一切割，不再硬编码 32px 高。
    }
  }

  /** 把 vendor 瓦片按语义叠加到程序化瓦片集上（每个生物群系一张合成图） */
  private composeWorldTiles(): void {
    const manifest = this.vendorWorld;
    if (!manifest) return;
    const assets = useAssetsStore();
    manifest.tilesets.forEach((tileset, index) => {
      const vendorKey = `world-vendor-tiles:${index}`;
      if (!this.textures.exists(vendorKey)) return;
      const biomes: BiomeId[] = tileset.biomes.length > 0 ? tileset.biomes : BIOMES.filter((b) => this.usesVendorTiles(b, tileset.image));
      for (const biome of biomes) {
        const applied = compositeVendorTiles(this, worldTilesetKey(biome), vendorKey, tileset);
        if (applied > 0) {
          assets.markVendor(worldTilesetKey(biome));
          if (manifest.version >= 2) this.registry.set(`world-native:${biome}`, { key: vendorKey, spec: tileset });
        }
        else assets.markPlaceholder(worldTilesetKey(biome));
      }
    });
  }

  /** 没写 biomes 的瓦片集：按文件名匹配生物群系（`tiles/forest.png` → forest） */
  private usesVendorTiles(biome: BiomeId, image: string): boolean {
    const file = image.split('/').pop() ?? image;
    return file.includes(biome);
  }

  /** 未登记的 sha256 视为本地覆盖直接使用；声明了就必须对得上 */
  private async verifyWorldImage(image: { key: string; url: string; sha256?: string }): Promise<boolean> {
    if (!image.sha256) return true;
    try {
      const { hash } = await fetchSha256(image.url);
      if (hash.toLowerCase() === image.sha256.toLowerCase()) return true;
      console.warn(`[assets] ${image.url} sha256 不匹配，改用程序化素材`);
    } catch {
      console.warn(`[assets] ${image.url} 读取失败，改用程序化素材`);
    }
    if (this.textures.exists(image.key)) this.textures.remove(image.key);
    return false;
  }

  /** 批量加载图片（Phaser loader 二次启动），单个失败不影响其它 */
  private loadImages(images: { key: string; url: string }[]): Promise<void> {
    const pending = images.filter((image) => !this.textures.exists(image.key));
    if (pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.load.off(Phaser.Loader.Events.COMPLETE, done);
        resolve();
      };
      this.load.on(Phaser.Loader.Events.COMPLETE, done);
      for (const image of pending) this.load.image(image.key, image.url);
      this.load.start();
    });
  }

  /** manifest 中有条目时重算 sha256；不一致或读取失败则丢弃该 vendor 资源并回退占位 */
  private async acceptVendor(key: string, url: string): Promise<boolean> {
    const assets = useAssetsStore();
    const entry = this.manifestByPath.get(url);
    if (entry) {
      this.statusText.setText(`VERIFY ${key}...`);
      try {
        const { hash } = await fetchSha256(url);
        if (hash.toLowerCase() !== entry.sha256.toLowerCase()) {
          console.warn(`[assets] ${url} sha256 不匹配，使用占位贴图`);
          this.removeAsset(key);
          assets.markPlaceholder(key);
          return false;
        }
      } catch {
        this.removeAsset(key);
        assets.markPlaceholder(key);
        return false;
      }
    }
    assets.markVendor(key);
    return true;
  }

  private removeAsset(key: string): void {
    if (this.textures.exists(key)) this.textures.remove(key);
    else if (this.cache.audio.exists(key)) this.cache.audio.remove(key);
  }
}
