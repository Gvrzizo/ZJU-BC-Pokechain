import Phaser from 'phaser';
import { drawCharacter } from './character-art';
import { MON_SIZE } from './mon-assets';
import { RUNNING_SPEED_MULTIPLIER } from './running';

/** 走路动画帧率（8 帧/秒）；跑步 = ×`RUNNING_SPEED_MULTIPLIER`，与移动速度同步 */
const WALK_FRAME_RATE = 8;

/**
 * 运行时占位像素贴图生成。
 * 仓库不内置版权素材；若用户在 public/assets/vendor/ 放了同名资源，
 * BootScene 会加载并通过 sha256 校验后直接使用，否则回落到这里生成的占位图。
 * 宝可梦占位图为 MON_SIZE（96×96）；真实素材为第三世代 64×64，渲染时整数倍放大。
 */

export {
  CRY_SPECIES_IDS,
  MON_BATTLE_FOE_SIZE,
  MON_BATTLE_MY_SIZE,
  MON_NATIVE,
  MON_SIZE,
  cryKey,
  cryUrl,
  integerMonScale,
  pokemonBackSpriteUrl,
  pokemonBackTextureKey,
  pokemonSpriteUrl,
  pokemonTextureKey,
} from './mon-assets';

export const TILE = 32;

/** 与 Vue SpriteIcon 共用的宝可梦占位底色（按 speciesId 稳定取色） */
const MON_PALETTE = [
  '#d84040', '#3878c8', '#58a860', '#f8c848', '#a868d8',
  '#f08840', '#48c8c8', '#d85898', '#8898a8', '#c8a048',
];

export function speciesColor(speciesId: number): string {
  return MON_PALETTE[Math.abs(speciesId) % MON_PALETTE.length];
}

function darken(hex: string, f = 0.65): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.floor(((n >> 16) & 0xff) * f);
  const g = Math.floor(((n >> 8) & 0xff) * f);
  const b = Math.floor((n & 0xff) * f);
  return `rgb(${r},${g},${b})`;
}

function noSmooth(ctx: CanvasRenderingContext2D) {
  ctx.imageSmoothingEnabled = false;
}

function drawBorder(ctx: CanvasRenderingContext2D, w: number, h: number, color: string, t = 4) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, t);
  ctx.fillRect(0, h - t, w, t);
  ctx.fillRect(0, 0, t, h);
  ctx.fillRect(w - t, 0, t, h);
}

/** 伪随机（确定性，避免每次生成贴图抖动） */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** 宝可梦占位 sprite：96x96，底色 + 眼睛 + 编号文字 */
export function makePokemonPlaceholder(scene: Phaser.Scene, key: string, speciesId: number): void {
  if (scene.textures.exists(key)) return;
  const tex = scene.textures.createCanvas(key, MON_SIZE, MON_SIZE);
  if (!tex) return;
  const ctx = tex.getContext();
  noSmooth(ctx);
  const base = speciesColor(speciesId);
  const rand = lcg(speciesId * 7919);

  ctx.fillStyle = base;
  ctx.fillRect(0, 0, MON_SIZE, MON_SIZE);
  // 肚皮色块
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(28, 48, 40, 36);
  // 噪点像素
  ctx.fillStyle = darken(base, 0.8);
  for (let i = 0; i < 40; i++) {
    ctx.fillRect(Math.floor(rand() * 22) * 4, Math.floor(rand() * 22) * 4, 4, 4);
  }
  // 眼睛
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(24, 24, 16, 16);
  ctx.fillRect(56, 24, 16, 16);
  ctx.fillStyle = '#282828';
  ctx.fillRect(28, 28, 8, 8);
  ctx.fillRect(60, 28, 8, 8);
  // 编号
  ctx.font = 'bold 14px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#282828';
  ctx.fillText(`#${String(speciesId).padStart(3, '0')}`, MON_SIZE / 2 + 1, MON_SIZE - 9);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`#${String(speciesId).padStart(3, '0')}`, MON_SIZE / 2, MON_SIZE - 10);
  drawBorder(ctx, MON_SIZE, MON_SIZE, '#282828');
  tex.refresh();
}

/** 单个 32x32 瓦片图案（2px 为一个“逻辑像素”，贴近 GBA 16×16 瓦片观感） */
function paintTile(ctx: CanvasRenderingContext2D, ox: number, kind: number) {
  const rand = lcg(kind * 331 + 7);
  const px = (x: number, y: number, w: number, h: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(ox + x, y, w, h);
  };
  const speckle = (count: number, color: string, size = 2) => {
    for (let i = 0; i < count; i++) {
      px(Math.floor(rand() * 16) * 2, Math.floor(rand() * 16) * 2, size, size, color);
    }
  };

  if (kind === 0) {
    // 草地：底色 + 明暗斑点 + 几簇草叶
    px(0, 0, TILE, TILE, '#78c060');
    speckle(34, '#68ac54');
    speckle(12, '#8ccf70');
    for (const [gx, gy] of [[3, 9], [20, 3], [13, 21]] as const) {
      px(gx * 2, gy * 2, 2, 6, '#5c9c4c');
      px(gx * 2 + 2, gy * 2 + 2, 2, 4, '#5c9c4c');
      px(gx * 2, gy * 2, 2, 2, '#8ccf70');
    }
  } else if (kind === 1) {
    // 小路：砂石底色 + 细碎石子 + 边缘阴影
    px(0, 0, TILE, TILE, '#e0c890');
    speckle(26, '#cfb47c');
    speckle(14, '#f0dcae');
    px(0, 0, TILE, 2, '#c8ac74');
    px(0, TILE - 2, TILE, 2, '#c8ac74');
    px(6, 8, 4, 4, '#b8a070');
    px(22, 18, 4, 4, '#b8a070');
    px(16, 6, 2, 2, '#f4e4bc');
    px(26, 24, 2, 2, '#f4e4bc');
  } else if (kind === 2) {
    // 树（不可通行）：草地底 + 树干 + 三层树冠
    px(0, 0, TILE, TILE, '#78c060');
    speckle(16, '#68ac54');
    px(13, 22, 6, 9, '#8a5a30');
    px(15, 22, 2, 9, '#a97543');
    px(12, 29, 8, 2, '#6b4522');
    // 树冠轮廓
    px(8, 3, 16, 2, '#1f5c2c');
    px(4, 5, 24, 4, '#1f5c2c');
    px(2, 9, 28, 8, '#1f5c2c');
    px(6, 17, 20, 4, '#1f5c2c');
    px(10, 21, 12, 2, '#1f5c2c');
    // 树冠主体
    px(9, 5, 14, 4, '#2f8440');
    px(5, 9, 22, 8, '#2f8440');
    px(7, 17, 18, 3, '#2f8440');
    // 受光面与高光
    px(7, 7, 12, 4, '#48a854');
    px(6, 10, 8, 5, '#48a854');
    px(8, 8, 6, 3, '#63c46a');
    px(18, 12, 5, 4, '#63c46a');
    px(10, 6, 4, 2, '#7ed47f');
  } else if (kind === 3) {
    // 水（不可通行）：深底色 + 波纹 + 浪花高光
    px(0, 0, TILE, TILE, '#3f7fd0');
    px(0, 0, TILE, 12, '#4a8ada');
    px(0, 20, TILE, 12, '#356fbe');
    for (const [wy, wx] of [[4, 2], [4, 18], [12, 10], [12, 26], [20, 0], [20, 16], [28, 6], [28, 22]] as const) {
      px(wx, wy, 10, 2, '#7fb8f0');
      px(wx + 2, wy + 2, 8, 2, '#5f9ce4');
    }
    px(8, 8, 2, 2, '#cfe8ff');
    px(22, 16, 2, 2, '#cfe8ff');
    px(14, 26, 2, 2, '#cfe8ff');
  } else {
    // 深草（可遇敌）：暗底 + 参差草叶 + 顶端高光
    px(0, 0, TILE, TILE, '#3f8c48');
    speckle(18, '#357a3e');
    for (let x = 0; x < TILE; x += 4) {
      const top = 4 + Math.floor(rand() * 4) * 2;
      px(x, top, 2, TILE - top - 2, '#2f6f38');
      px(x + 2, top + 4, 2, TILE - top - 6, '#4fa458');
      px(x + 2, top + 4, 2, 2, '#6fc070');
    }
    px(0, TILE - 2, TILE, 2, '#2a5f32');
  }
}

/** 瓦片集贴图：5 个 32x32 横向拼接（0草 1路 2树 3水 4深草） */
export function makeTilesTexture(scene: Phaser.Scene, key = 'tiles'): void {
  if (scene.textures.exists(key)) return;
  const tex = scene.textures.createCanvas(key, TILE * 5, TILE);
  if (!tex) return;
  const ctx = tex.getContext();
  noSmooth(ctx);
  for (let i = 0; i < 5; i++) paintTile(ctx, i * TILE, i);
  tex.refresh();
}

/** 自绘主角：四方向三帧，32×40/帧。vendor 的 32×32 帧仍由 BootScene 接受。 */
export function makeHeroSpritesheet(scene: Phaser.Scene, key = 'hero'): void {
  if (scene.textures.exists(key)) return;
  const tex = scene.textures.createCanvas(key, 96, 160);
  if (!tex) return;
  const ctx = tex.getContext();
  noSmooth(ctx);
  const look = { hair: '#424b50', skin: '#f2c697', cap: '#db6060', shirt: '#477e9c', pants: '#4b596b', accent: '#e9e5cb' };
  const directions = ['down', 'up', 'left', 'right'] as const;
  directions.forEach((facing, row) => {
    for (let col = 0; col < 3; col++) {
      drawCharacter(ctx, col * 32, row * 40, look, facing, col, 'hero');
      tex.add(row * 3 + col, 0, col * 32, row * 40, 32, 40);
    }
  });
  tex.refresh();
}

export type Direction = 'down' | 'up' | 'left' | 'right';
export const DIR_ROW: Record<Direction, number> = { down: 0, up: 1, left: 2, right: 3 };

/** 注册主角行走动画（幂等）：走路 8 帧/秒，跑步 `hero-walk-<dir>-run` 帧率 ×2（与移动速度同步） */
export function makeHeroAnims(scene: Phaser.Scene): void {
  for (const dir of ['down', 'up', 'left', 'right'] as Direction[]) {
    const base = DIR_ROW[dir] * 3;
    const frames = [
      { key: 'hero', frame: base },
      { key: 'hero', frame: base + 1 },
      { key: 'hero', frame: base },
      { key: 'hero', frame: base + 2 },
    ];
    const animations: Array<[string, number]> = [
      [`hero-walk-${dir}`, WALK_FRAME_RATE],
      [`hero-walk-${dir}-run`, WALK_FRAME_RATE * RUNNING_SPEED_MULTIPLIER],
    ];
    for (const [key, frameRate] of animations) {
      if (scene.anims.exists(key)) continue;
      scene.anims.create({ key, frames, frameRate, repeat: -1 });
    }
  }
}
