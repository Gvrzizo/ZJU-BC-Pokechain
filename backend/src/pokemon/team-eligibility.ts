import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/utils/errors';
import { ContractService } from '../fabric/contract.service';
import { PokemonHpService } from './pokemon-hp.service';

/** 出战队伍规模：1-6 只（房间创建/加入与排位入队同一口径，docs/backend-api.md §5/§11） */
export const TEAM_SIZE_MIN = 1;
export const TEAM_SIZE_MAX = 6;

/** 队伍校验依赖：只取链上宝可梦读取与链下当前 HP，便于两处服务复用与单测。 */
export interface TeamEligibilityDeps {
  contract: Pick<ContractService, 'getPokemon'>;
  hp: Pick<PokemonHpService, 'currentHp'>;
}

/** 濒死提示口径：房间/押注复核与排位入队各自沿用原本文案。 */
export type TeamCheckSurface = 'battle' | 'queue';

export interface TeamCheckOptions {
  surface?: TeamCheckSurface;
}

/** 队伍规模校验：违规 400 `INVALID_TEAM_SIZE`（链上/引擎按最多 6 只设计）。 */
export function assertTeamSize(pokemonIds: string[]): void {
  const size = Array.isArray(pokemonIds) ? pokemonIds.length : 0;
  if (size < TEAM_SIZE_MIN || size > TEAM_SIZE_MAX) {
    throw new AppException(
      'INVALID_TEAM_SIZE',
      `teamPokemonIds must contain ${TEAM_SIZE_MIN}-${TEAM_SIZE_MAX} pokemon, got ${size}`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * 出战队伍去重（H2 / docs/review-2026-10-25.md）：同一只宝可梦不能占多个槽位
 * （否则「最强一只 ×6」等于 6 条命，押注房可稳赢）。房间与排位共用。
 */
export function assertTeamUnique(pokemonIds: string[]): void {
  if (!Array.isArray(pokemonIds)) return;
  if (new Set(pokemonIds).size !== pokemonIds.length) {
    throw new AppException(
      'DUPLICATE_TEAM',
      'teamPokemonIds must not contain duplicates',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * 队伍可出战校验（房间与排位共用）：规模 1-6、不重复、每只属于本人且 IDLE、非濒死。
 * 错误码与文案保持拆分前口径：
 * `INVALID_TEAM_SIZE` / `DUPLICATE_TEAM` / `NOT_OWNER` / `ASSET_LOCKED` / `FAINTED`。
 */
export async function assertTeamOwnership(
  deps: TeamEligibilityDeps,
  playerId: string,
  pokemonIds: string[],
  options: TeamCheckOptions = {},
): Promise<void> {
  assertTeamSize(pokemonIds);
  assertTeamUnique(pokemonIds);
  for (const id of pokemonIds) {
    const pokemon = await deps.contract.getPokemon(id).catch(() => null);
    if (!pokemon || pokemon.ownerId !== playerId) {
      throw new AppException('NOT_OWNER', `pokemon ${id} is not owned by ${playerId}`, HttpStatus.FORBIDDEN);
    }
    if (pokemon.status !== 'IDLE') {
      throw new AppException('ASSET_LOCKED', `pokemon ${id} is ${pokemon.status}`, HttpStatus.CONFLICT);
    }
    // 伤势持久化（docs/backend-api.md §2）：濒死（0 HP）的宝可梦不能进队伍提交
    if ((await deps.hp.currentHp(pokemon)) <= 0) {
      const message =
        options.surface === 'queue'
          ? `pokemon ${id} (${pokemon.name}) has fainted; heal it at the pokemon center before queueing`
          : `pokemon ${id} has fainted; heal it before battling`;
      throw new AppException('FAINTED', message, HttpStatus.CONFLICT);
    }
  }
}
