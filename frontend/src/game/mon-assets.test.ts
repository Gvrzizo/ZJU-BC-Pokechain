import { describe, expect, it } from 'vitest';
import {
  CRY_SPECIES_IDS,
  MON_BATTLE_FOE_SIZE,
  MON_BATTLE_MY_SIZE,
  MON_NATIVE,
  cryUrl,
  integerMonScale,
  pokemonBackSpriteUrl,
  pokemonBackTextureKey,
  pokemonSpriteUrl,
  pokemonTextureKey,
} from './mon-assets';

describe('mon-assets 素材命名约定', () => {
  it('URL 与纹理 key 与 public/assets/vendor/ 约定一致', () => {
    expect(pokemonSpriteUrl(25)).toBe('/assets/vendor/pokemon/025.png');
    expect(pokemonBackSpriteUrl(151)).toBe('/assets/vendor/pokemon/back/151.png');
    expect(cryUrl(3)).toBe('/assets/vendor/cries/003.ogg');
    expect(pokemonTextureKey(25)).toBe('mon-25');
    expect(pokemonBackTextureKey(25)).toBe('mon-back-25');
  });

  it('按原生尺寸取整数倍放大（64 原生 → 3×/2×，96 占位 → 2×/1×）', () => {
    expect(integerMonScale(MON_BATTLE_MY_SIZE, MON_NATIVE)).toBe(3);
    expect(integerMonScale(MON_BATTLE_FOE_SIZE, MON_NATIVE)).toBe(2);
    expect(integerMonScale(MON_BATTLE_MY_SIZE, 96)).toBe(2);
    expect(integerMonScale(MON_BATTLE_FOE_SIZE, 96)).toBe(1);
    expect(integerMonScale(MON_NATIVE, 0)).toBe(1); // 原生尺寸缺失时按 MON_NATIVE 兜底
  });

  it('叫声清单覆盖全部可野生遭遇种族（#1–386 中 inWild 的 361 个）', () => {
    expect(CRY_SPECIES_IDS).toHaveLength(361);
    expect(new Set(CRY_SPECIES_IDS).size).toBe(CRY_SPECIES_IDS.length);
    expect(CRY_SPECIES_IDS.every((id) => id >= 1 && id <= 386)).toBe(true);
    expect(CRY_SPECIES_IDS).toContain(252); // 第三世代野生池
    expect(CRY_SPECIES_IDS).toContain(376);
    expect(CRY_SPECIES_IDS).not.toContain(377); // 传说/幻之不出场
    expect(CRY_SPECIES_IDS).not.toContain(386);
    expect(CRY_SPECIES_IDS).not.toContain(26); // 手调进化型不出场
    expect([...CRY_SPECIES_IDS].sort((a, b) => a - b)).toEqual([...CRY_SPECIES_IDS]);
  });
});
