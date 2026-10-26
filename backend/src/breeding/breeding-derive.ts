import { DeriveStream, sha256hex } from '../common/utils/crypto.util';
import type { PokemonIvs, PokemonState } from '../fabric/chain.types';
import {
  IV_BLOCK,
  IV_CHOICE_PARENT_A,
  IV_CHOICE_PARENT_B,
  IV_KEYS,
  NATURE_SLOT,
  SHINY_DENOMINATOR,
  SHINY_SLOT,
} from './breeding.constants';

// --- [FEAT:breeding] begin ---

export interface DerivedChild {
  ivs: PokemonIvs;
  nature: string;
  shiny: boolean;
}

/**
 * 从该繁殖事件的派生流生成子代属性。
 *
 * **必须与链码 `BreedingContract.deriveChild` 逐字一致**：链码会重算同一组值并与
 * 提交内容比对，任何偏差都会被 `HEREDITY_MISMATCH` 拒绝。槽位定义见
 * docs/feature-breeding.md §2。
 */
export function deriveChild(stream: DeriveStream, parentA: PokemonState, parentB: PokemonState): DerivedChild {
  const ivs = {} as PokemonIvs;
  IV_KEYS.forEach((key, index) => {
    const choice = stream.at(IV_BLOCK + index * 2);
    ivs[key] =
      choice < IV_CHOICE_PARENT_A
        ? parentA.ivs[key]
        : choice < IV_CHOICE_PARENT_B
          ? parentB.ivs[key]
          : Math.floor(stream.at(IV_BLOCK + index * 2 + 1) * 32);
  });
  return {
    ivs,
    nature: stream.at(NATURE_SLOT) < 0.5 ? parentA.nature : parentB.nature,
    shiny: stream.at(SHINY_SLOT) < 1 / SHINY_DENOMINATOR,
  };
}

/** 血统承诺（子代 dnaHash）：与链码公式一致，带版本前缀防止跨版本混淆。 */
export function lineageHash(parentA: PokemonState, parentB: PokemonState, eventId: string, childId: string): string {
  return sha256hex(
    ['pokechain-breed-v1', parentA.id, parentA.dnaHash, parentB.id, parentB.dnaHash, eventId, childId].join('|'),
  );
}

// --- [FEAT:breeding] end ---
