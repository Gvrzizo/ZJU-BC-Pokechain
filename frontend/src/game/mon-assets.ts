/**
 * 宝可梦素材命名约定（public/assets/vendor/）与尺寸常量。
 * 纯字符串与尺寸计算，不依赖 Phaser，供 Phaser 场景与 Vue 组件共用。
 *
 * 素材来源：PokeAPI sprites / cries，仅课程演示用途，详见 frontend/README.md。
 */

/** 占位 sprite 与图鉴展示的逻辑尺寸（仓库约定 96×96） */
export const MON_SIZE = 96;

/** 第三世代（红/蓝宝石）原生 sprite 边长：64×64 */
export const MON_NATIVE = 64;

/** 战斗场景显示目标尺寸：整数倍放大（原生 64 → 3×/2×，96 占位 → 2×/1×） */
export const MON_BATTLE_MY_SIZE = MON_NATIVE * 3;
export const MON_BATTLE_FOE_SIZE = MON_NATIVE * 2;

/**
 * 会出场的种族（backend/src/game-data/species.data.ts 里 inWild=true 的全量清单，
 * 共 361 个：传说/幻之与手调的 4 个进化型不在其内），叫声按此清单预载。
 * 数据扩充时用 backend/tools 的生成脚本重跑（见 backend/README.md「图鉴数据」）。
 */
export const CRY_SPECIES_IDS: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
  25, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
  50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73,
  74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97,
  98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121,
  122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 137, 138, 139, 140, 141, 142, 143, 147, 148, 149, 152, 153,
  154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177,
  178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201,
  202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225,
  226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 246, 247, 248, 252, 253, 254, 255,
  256, 257, 258, 259, 260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275, 276, 277, 278, 279,
  280, 281, 282, 283, 284, 285, 286, 287, 288, 289, 290, 291, 292, 293, 294, 295, 296, 297, 298, 299, 300, 301, 302, 303,
  304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321, 322, 323, 324, 325, 326, 327,
  328, 329, 330, 331, 332, 333, 334, 335, 336, 337, 338, 339, 340, 341, 342, 343, 344, 345, 346, 347, 348, 349, 350, 351,
  352, 353, 354, 355, 356, 357, 358, 359, 360, 361, 362, 363, 364, 365, 366, 367, 368, 369, 370, 371, 372, 373, 374, 375,
  376,
];

const pad3 = (n: number): string => String(n).padStart(3, '0');

export function pokemonTextureKey(speciesId: number): string {
  return `mon-${speciesId}`;
}

/** 我方视角的背面图 key（战斗场景用） */
export function pokemonBackTextureKey(speciesId: number): string {
  return `mon-back-${speciesId}`;
}

export function pokemonSpriteUrl(speciesId: number): string {
  return `/assets/vendor/pokemon/${pad3(speciesId)}.png`;
}

export function pokemonBackSpriteUrl(speciesId: number): string {
  return `/assets/vendor/pokemon/back/${pad3(speciesId)}.png`;
}

export function cryKey(speciesId: number): string {
  return `cry-${speciesId}`;
}

export function cryUrl(speciesId: number): string {
  return `/assets/vendor/cries/${pad3(speciesId)}.ogg`;
}

/** 目标显示尺寸 → 整数缩放系数（nearest-neighbor 下的像素对齐） */
export function integerMonScale(targetDisplaySize: number, nativeWidth: number = MON_NATIVE): number {
  return Math.max(1, Math.round(targetDisplaySize / (nativeWidth || MON_NATIVE)));
}
