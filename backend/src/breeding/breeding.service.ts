import { HttpStatus, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
import { AppException } from '../common/utils/errors';
import { sha256hex, DeriveStream } from '../common/utils/crypto.util';
import { ContractService } from '../fabric/contract.service';
import { SYSTEM_IDENTITY, type ChainIdentity, type PokemonState } from '../fabric/chain.types';
import { SPECIES } from '../game-data/species.data';
import { BREED_MIN_LEVEL } from './breeding.constants';
import { deriveChild } from './breeding-derive';

// --- [FEAT:breeding] begin ---

/**
 * 血统繁殖编排：
 *   预校验 → Commit(purpose='mint') → Reveal(system) → 派生 → Breed(玩家签名，扣积分)
 *
 * 为什么先揭示再繁殖：`consumeRandom` 要求 REVEALED。链码在 Breed 里会用同一份
 * serverSeed 重算属性，所以后端不能伪造结果；但"提交前是否挑过种子"链码无法阻止，
 * 详见 docs/feature-breeding.md §4.1 与 docs/randomness.md §7。
 */
@Injectable()
export class BreedingService {
  constructor(private readonly contract: ContractService) {}

  getConfig() {
    return this.contract.getBreedingConfig();
  }

  getLineage(id: string) {
    return this.contract.getLineage(id);
  }

  async breed(as: ChainIdentity, parentAId: string, parentBId: string): Promise<PokemonState> {
    if (parentAId === parentBId) {
      throw new AppException('INVALID_PARAM', '两只亲代不能是同一只', HttpStatus.BAD_REQUEST);
    }
    const [parentA, parentB] = await Promise.all([
      this.contract.getPokemon(parentAId),
      this.contract.getPokemon(parentBId),
    ]);

    this.assertEligible(as, parentA, parentB);

    const eventId = `ev_breed_${randomUUID()}`;
    const serverSeed = randomBytes(32).toString('hex');
    const clientSeed = randomBytes(16).toString('hex');
    const childId = `p_${randomUUID()}`;

    await this.contract.commitRandom(
      as,
      {
        eventId,
        purpose: 'mint',
        playerId: as.userId,
        commitHash: sha256hex(serverSeed),
        clientSeed,
        meta: JSON.stringify({ kind: 'breed', parents: [parentA.id, parentB.id] }),
      },
      { idemKey: `breed-commit-${eventId}` },
    );
    await this.contract.revealAndVerify(SYSTEM_IDENTITY, eventId, serverSeed, {
      idemKey: `breed-reveal-${eventId}`,
    });

    const derived = deriveChild(new DeriveStream(serverSeed, clientSeed, eventId), parentA, parentB);
    const species = SPECIES[parentB.speciesId] ?? SPECIES[parentA.speciesId];
    if (!species) {
      throw new AppException('SPECIES_NOT_FOUND', `未知物种 ${parentB.speciesId}`, HttpStatus.BAD_REQUEST);
    }

    return this.contract.breed(
      as,
      {
        childId,
        parentAId: parentA.id,
        parentBId: parentB.id,
        speciesId: species.id,
        name: species.name,
        ivs: derived.ivs,
        nature: derived.nature,
        ability: species.ability,
        shiny: derived.shiny,
        moves: species.defaultMoves.slice(0, 4),
        eventId,
      },
      { idemKey: `breed-${eventId}` },
    );
  }

  /** 链码会再校验一次；这里提前失败，避免白跑一次上链往返。 */
  private assertEligible(as: ChainIdentity, parentA: PokemonState, parentB: PokemonState): void {
    if (parentA.ownerId !== parentB.ownerId) {
      throw new AppException('NOT_OWNER', '两只亲代不属于同一玩家', HttpStatus.BAD_REQUEST);
    }
    if (parentA.ownerId !== as.userId) {
      throw new AppException('NOT_OWNER', '只能繁殖自己的宝可梦', HttpStatus.FORBIDDEN);
    }
    for (const parent of [parentA, parentB]) {
      if (parent.status !== 'IDLE') {
        throw new AppException('ASSET_LOCKED', `宝可梦 ${parent.id} 正在交易或对战中`, HttpStatus.CONFLICT);
      }
      if (parent.level < BREED_MIN_LEVEL) {
        throw new AppException(
          'INVALID_PARAM',
          `宝可梦 ${parent.id} 等级不足 ${BREED_MIN_LEVEL}（当前 ${parent.level}）`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }
  }
}

// --- [FEAT:breeding] end ---
