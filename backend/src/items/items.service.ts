import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/utils/errors';
import { ContractService } from '../fabric/contract.service';
import { ChainIdentity, PokemonState, SYSTEM_IDENTITY } from '../fabric/chain.types';
import { EVOLUTIONS, SPECIES } from '../game-data/species.data';
import { getItemType, ITEM_TYPES } from '../game-data/items.data';
import { getMove } from '../game-data/moves.data';
import { StatKey, STAT_KEYS } from '../game-data/stats';
import { LEVEL_MAX, PokemonService } from '../pokemon/pokemon.service';

/** 单项 IV 上限（0-31，链码 ApplyGrowth 只能升不能降）。 */
const IV_MAX = 31;

/** 使用道具的入参（王冠要指定培养项，其余道具忽略 stat）。 */
export interface UseItemOptions {
  targetPokemonId?: string;
  forgetMoveId?: string;
  stat?: StatKey;
}

/** 特训类道具（kind='other'）的 typeId 白名单。 */
const TRAINING_ITEM_EFFECTS = ['bottle-cap', 'gold-bottle-cap', 'rare-candy'] as const;

export interface UseItemResult {
  used: string;
  /** 成长结果（王冠/糖果等经 ApplyGrowth 的道具） */
  pokemon?: PokemonState;
  /** 糖果升级的结算摘要 */
  levelsGained?: number;
  movesLearned?: string[];
  canEvolve?: boolean;
  /** 界面提示文案（中文，前端直接展示） */
  message?: string;
  [key: string]: unknown;
}

/** 伤药回血结果（链下 Redis 的当前 HP，docs/backend-api.md §2「伤势持久化」）。 */
export interface PotionHealResult {
  before: number;
  after: number;
  maxHp: number;
  healed: number;
}

@Injectable()
export class ItemsService {
  constructor(
    private readonly contract: ContractService,
    private readonly pokemon: PokemonService,
  ) {}

  listMine(username: string) {
    return this.contract.queryItemsByOwner(username);
  }

  catalog() {
    return Object.values(ITEM_TYPES);
  }

  /**
   * Use a potion / evolution stone / TM / training item. Off-chain effect validation first,
   * then ConsumeItem (+ ApplyGrowth for stones/TMs/crowns/candy).
   *
   * 药水（`potion`/`super-potion`）现在**必须给 `targetPokemonId`**：回血走链下 Redis 的
   * 当前 HP（+20 / +50，不超上限，满血抛 `HP_FULL`），链上只记一次消耗——见
   * docs/backend-api.md §2「伤势持久化」。
   */
  async use(as: ChainIdentity, id: string, options: UseItemOptions = {}): Promise<UseItemResult> {
    const { targetPokemonId, forgetMoveId } = options;
    const item = await this.contract.getItem(id).catch(() => null);
    if (!item || item.ownerId !== as.userId) {
      throw new AppException('NOT_OWNER', `item ${id} is not yours`, HttpStatus.FORBIDDEN);
    }
    const type = getItemType(item.typeId);
    if (!type) {
      throw new AppException('UNKNOWN_ITEM_TYPE', `${item.typeId} is not a known item type`, HttpStatus.BAD_REQUEST);
    }
    if (item.quantity <= 0) {
      throw new AppException('INSUFFICIENT_QUANTITY', `no ${item.typeId} left`, HttpStatus.BAD_REQUEST);
    }

    switch (type.kind) {
      case 'potion': {
        // 伤势持久化（docs/backend-api.md §2）：伤药在链下给指定宝可梦回血（不超上限），
        // 链上只记一次 ConsumeItem。已满血直接拒绝，不浪费道具。
        const pokemon = await this.mustOwnPokemon(as, targetPokemonId, 'potions');
        const maxHp = this.pokemon.hp.maxHpOf(pokemon);
        const before = await this.pokemon.hp.currentHp(pokemon);
        if (before >= maxHp) {
          throw new AppException('HP_FULL', `${pokemon.name} is already at full HP`, HttpStatus.CONFLICT);
        }
        const healAmount = type.healAmount ?? 0;
        await this.contract.consumeItem(as, id, 1, 'use-potion');
        const healed = await this.pokemon.hp.heal(pokemon, healAmount);
        return {
          used: item.typeId,
          effect: { healAmount },
          pokemon,
          hp: { before: healed.before, after: healed.after, maxHp: healed.maxHp, healed: healed.healed },
          message: `${type.nameZh}回复了 ${healed.healed} HP（${healed.before} → ${healed.after}/${healed.maxHp}）`,
        };
      }
      case 'stone': {
        const pokemon = await this.mustOwnPokemon(as, targetPokemonId, 'evolution stones');
        const rule = EVOLUTIONS.find((e) => e.from === pokemon.speciesId && e.stoneTypeId === item.typeId);
        if (!rule) {
          throw new AppException('NO_EVOLUTION', `${pokemon.name} cannot evolve with ${item.typeId}`, HttpStatus.BAD_REQUEST);
        }
        if (pokemon.level < rule.minLevel) {
          throw new AppException('LEVEL_TOO_LOW', `needs level ${rule.minLevel}, is ${pokemon.level}`, HttpStatus.BAD_REQUEST);
        }
        await this.contract.consumeItem(as, id, 1, 'evolve');
        const target = SPECIES[rule.to];
        const updated = await this.contract.applyGrowth(SYSTEM_IDENTITY, targetPokemonId!, {
          speciesId: rule.to,
          name: target?.name ?? pokemon.name,
        });
        return { used: item.typeId, evolved: updated };
      }
      case 'tm': {
        const moveId = type.teachesMove;
        if (!moveId || !getMove(moveId)) {
          throw new AppException('UNKNOWN_MOVE', 'TM teaches an unknown move', HttpStatus.BAD_REQUEST);
        }
        const pokemon = await this.mustOwnPokemon(as, targetPokemonId, 'TMs');
        if (pokemon.moves.includes(moveId)) {
          throw new AppException('MOVE_KNOWN', `already knows ${moveId}`, HttpStatus.CONFLICT);
        }
        let moves = [...pokemon.moves];
        if (moves.length >= 4) {
          if (!forgetMoveId || !moves.includes(forgetMoveId)) {
            throw new AppException('FORGET_REQUIRED', 'knows 4 moves; provide a valid forgetMoveId', HttpStatus.BAD_REQUEST);
          }
          moves = moves.filter((m) => m !== forgetMoveId);
        }
        moves.push(moveId);
        await this.contract.consumeItem(as, id, 1, 'use-tm');
        const updated = await this.contract.applyGrowth(as, targetPokemonId!, { moves });
        return { used: item.typeId, taught: moveId, pokemon: updated };
      }
      case 'other':
        return this.useTrainingItem(as, id, item.typeId, options);
      default:
        throw new AppException('NOT_USABLE', `${item.typeId} cannot be used directly`, HttpStatus.BAD_REQUEST);
    }
  }

  /**
   * 培养类道具（docs/backend-api.md §3）：积分只换努力值，个体值只走王冠、等级只走经验，
   * 所以这里集中实现「王冠加 IV / 神奇糖果 +1 级」两条链上成长路径。
   */
  private async useTrainingItem(
    as: ChainIdentity,
    itemId: string,
    typeId: string,
    options: UseItemOptions,
  ): Promise<UseItemResult> {
    if (!TRAINING_ITEM_EFFECTS.includes(typeId as (typeof TRAINING_ITEM_EFFECTS)[number])) {
      throw new AppException('NOT_USABLE', `${typeId} cannot be used directly`, HttpStatus.BAD_REQUEST);
    }
    const pokemon = await this.mustOwnPokemon(as, options.targetPokemonId, `${typeId}`);

    if (typeId === 'rare-candy') {
      if (pokemon.level >= LEVEL_MAX) {
        throw new AppException('LEVEL_MAXED', `already at level ${LEVEL_MAX}`, HttpStatus.CONFLICT);
      }
      // +1 级 = exp 补到 (level+1)^3（exp 曲线 level = floor(cbrt(exp))）
      const gain = Math.max(0, (pokemon.level + 1) ** 3 - (pokemon.exp ?? 0));
      await this.contract.consumeItem(as, itemId, 1, 'use-rare-candy');
      const outcome = await this.pokemon.applyExp(pokemon, gain);
      return {
        used: typeId,
        pokemon: outcome.pokemon,
        levelsGained: outcome.levelsGained,
        movesLearned: outcome.movesLearned,
        canEvolve: outcome.canEvolve,
        message: `等级提升到 Lv${outcome.pokemon.level}`,
      };
    }

    // 王冠：指定项或六项全部升满 31（链码 applyIvsPatch 只允许升、降会抛 IV_DECREASE）
    const ivs: Partial<Record<StatKey, number>> = {};
    if (typeId === 'bottle-cap') {
      const stat = options.stat;
      if (!stat || !STAT_KEYS.includes(stat)) {
        throw new AppException(
          'STAT_REQUIRED',
          `bottle-cap needs stat ∈ {${STAT_KEYS.join(', ')}}`,
          HttpStatus.BAD_REQUEST,
        );
      }
      if ((pokemon.ivs?.[stat] ?? 0) >= IV_MAX) {
        throw new AppException('IV_MAXED', `${stat} IV is already ${IV_MAX}`, HttpStatus.CONFLICT);
      }
      ivs[stat] = IV_MAX;
    } else {
      for (const key of STAT_KEYS) {
        if ((pokemon.ivs?.[key] ?? 0) < IV_MAX) ivs[key] = IV_MAX;
      }
      if (Object.keys(ivs).length === 0) {
        throw new AppException('IV_MAXED', `all IVs are already ${IV_MAX}`, HttpStatus.CONFLICT);
      }
    }
    await this.contract.consumeItem(as, itemId, 1, `use-${typeId}`);
    const updated = await this.contract.applyGrowth(SYSTEM_IDENTITY, pokemon.id, { ivs });
    return {
      used: typeId,
      pokemon: updated,
      message:
        typeId === 'gold-bottle-cap'
          ? '六项个体值全部提升到 31'
          : `个体值 ${options.stat} 提升到 ${IV_MAX}`,
    };
  }

  /** 道具效果的共同前置：目标宝可梦必填、本人所有。 */
  private async mustOwnPokemon(
    as: ChainIdentity,
    targetPokemonId: string | undefined,
    what: string,
  ): Promise<PokemonState> {
    if (!targetPokemonId) {
      throw new AppException('TARGET_REQUIRED', `${what} needs targetPokemonId`, HttpStatus.BAD_REQUEST);
    }
    const pokemon = await this.contract.getPokemon(targetPokemonId);
    if (pokemon.ownerId !== as.userId) {
      throw new AppException('NOT_OWNER', `pokemon ${targetPokemonId} is not yours`, HttpStatus.FORBIDDEN);
    }
    return pokemon;
  }
}
