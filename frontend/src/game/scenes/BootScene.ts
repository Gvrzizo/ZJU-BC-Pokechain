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
import { makeHeroAnims, makeHeroSpritesheet, makePokemonPlaceholder, makeTilesTexture } from '../textures';

/** 全国图鉴上限：第三世代 #1–386（正面/背面 sprite 与叫声按此范围预载） */
const DEX_COUNT = 386;

/**
 * BootScene：
 * 1. 拉取 /assets/manifest（后端不可用时静默降级为全占位）
 * 2. 尝试从 /assets/vendor/ 加载用户素材（宝可梦正/背面图、叫声、瓦片、主角），
 *    存在则用 Web Crypto 校验 sha256（manifest 中有对应条目时才校验，无条目视为本地覆盖直接使用）
 * 3. 缺失 / 校验失败的资源用程序化占位像素贴图顶替
 */
export class BootScene extends Phaser.Scene {
  private nextScene = 'OverworldScene';
  private statusText!: Phaser.GameObjects.Text;
  private manifestByPath = new Map<string, AssetManifestEntry>();

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

    // 占位生成（已存在 vendor 贴图的 key 会被跳过）
    this.statusText.setText('GENERATE PLACEHOLDERS...');
    makeTilesTexture(this, 'tiles');
    if (this.textures.exists('hero')) {
      // vendor hero.png 必须是 96x128（4 方向 x 3 帧，32x32/帧）才能当行走图
      const src = this.textures.get('hero').getSourceImage() as HTMLImageElement;
      if (src.width === 96 && src.height === 128) {
        const t = this.textures.get('hero');
        for (let i = 0; i < 12; i++) {
          t.add(i, 0, (i % 3) * 32, Math.floor(i / 3) * 32, 32, 32);
        }
      } else {
        console.warn('[assets] hero.png 尺寸非 96x128，使用占位行走图');
        this.textures.remove('hero');
        assets.markPlaceholder('hero');
      }
    }
    makeHeroSpritesheet(this, 'hero');
    makeHeroAnims(this);
    for (let id = 1; id <= DEX_COUNT; id++) {
      if (!this.textures.exists(pokemonTextureKey(id))) {
        makePokemonPlaceholder(this, pokemonTextureKey(id), id);
        assets.markPlaceholder(pokemonTextureKey(id));
      }
    }

    assets.setReady();
    this.scene.start(this.nextScene);
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
