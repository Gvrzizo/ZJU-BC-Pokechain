import { Context, Contract, Returns, Transaction } from 'fabric-contract-api';
import {
  assertIdle,
  assertISO,
  fail,
  parseBoolean,
  parseJSON,
  parseStringArray,
  requireHex64,
  requireNonEmpty,
  safeInt,
} from '../common/assert';
import { getRole, requireRole } from '../common/cid';
import { withIdempotency } from '../common/idempotency';
import {
  applyIvsPatch,
  assertEvs,
  BOND_DEFAULT,
  BOND_MAX,
  BOND_MAX_DELTA,
  BOND_MIN_DELTA,
  BOND_RESET_ON_TRANSFER,
  BOND_UP_MAX_IDS,
  Evs,
  Ivs,
  IV_KEYS,
  IV_MAX,
  Pokemon,
  zeroEvs,
} from '../common/model';
import { collectQuery, selectorQuery } from '../common/query';
import {
  assertCallerIsPlayer,
  consumeRandom,
  emit,
  exists,
  loadPlayer,
  loadPokemon,
  savePokemon,
} from '../common/state';

function parseIvs(raw: string): Ivs {
  const obj = parseJSON<Record<string, unknown>>(raw, 'ivsJSON');
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    fail('INVALID_PARAM', 'ivsJSON must be a JSON object');
  }
  const ivs = {} as Record<(typeof IV_KEYS)[number], number>;
  for (const k of IV_KEYS) {
    ivs[k] = safeInt(obj[k] as string | number, `ivs.${k}`, { min: 0, max: IV_MAX });
  }
  return ivs as Ivs;
}

function parseMoves(raw: string): string[] {
  return parseStringArray(parseJSON(raw, 'movesJSON'), 'movesJSON', 4);
}

/** growth.evs：六项必备、单项 0-255、总和 ≤510。 */
function parseGrowthEvs(raw: unknown): Evs {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('INVALID_PARAM', 'growth.evs must be a JSON object');
  }
  return assertEvs(raw, 'growth.evs');
}

export class PokemonContract extends Contract {
  constructor() {
    super('PokemonContract');
  }

  @Transaction()
  public async MintFromCapture(
    ctx: Context,
    id: string,
    playerId: string,
    speciesId: string,
    name: string,
    ivsJSON: string,
    nature: string,
    ability: string,
    shiny: string,
    movesJSON: string,
    dnaHash: string,
    eventId: string,
    nowISO: string,
    idemKey: string,
  ): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireNonEmpty(id, 'id');
      requireNonEmpty(name, 'name');
      requireNonEmpty(nature, 'nature');
      requireNonEmpty(ability, 'ability');
      assertISO(nowISO, 'nowISO');
      const species = safeInt(speciesId, 'speciesId', { min: 0 });
      const isShiny = parseBoolean(shiny, 'shiny');
      const ivs = parseIvs(ivsJSON);
      const moves = parseMoves(movesJSON);
      requireHex64(dnaHash, 'dnaHash');
      await loadPlayer(ctx, playerId);
      if (await exists(ctx, 'pokemon', id)) {
        fail('POKEMON_EXISTS', `pokemon ${id} already exists`);
      }
      // 消费已验证随机事件（RandomContract 内部操作，共享键空间直接调用）
      await consumeRandom(ctx, eventId, 'capture', playerId);
      const pokemon: Pokemon = {
        docType: 'pokemon',
        id,
        speciesId: species,
        name,
        dnaHash: dnaHash.toLowerCase(),
        ivs,
        evs: zeroEvs(),
        nature,
        ability,
        shiny: isShiny,
        level: 5,
        exp: 0,
        moves,
        ownerId: playerId,
        status: 'IDLE',
        lockRef: '',
        captureEventId: eventId,
        createdAt: nowISO,
        bond: BOND_DEFAULT,
      };
      await savePokemon(ctx, pokemon);
      emit(ctx, 'PokemonMinted', { id, ownerId: playerId, speciesId: species, name, shiny: isShiny });
      return JSON.stringify(pokemon);
    });
  }

  @Transaction()
  public async Transfer(ctx: Context, id: string, toId: string, nowISO: string, idemKey: string): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireNonEmpty(id, 'id');
      requireNonEmpty(toId, 'toId');
      assertISO(nowISO, 'nowISO');
      const pokemon = await loadPokemon(ctx, id);
      const owner = await loadPlayer(ctx, pokemon.ownerId);
      assertCallerIsPlayer(ctx, owner);
      assertIdle(pokemon.status, 'pokemon', id);
      await loadPlayer(ctx, toId);
      // 易主即归零：bond 重置为 30（转给自己不算易主，docs/chaincode-api.md §1 Pokemon）
      if (pokemon.ownerId !== toId) {
        pokemon.bond = BOND_RESET_ON_TRANSFER;
      }
      pokemon.ownerId = toId;
      await savePokemon(ctx, pokemon);
      emit(ctx, 'PokemonTransferred', { id, fromId: owner.playerId, toId, bond: pokemon.bond });
      return JSON.stringify(pokemon);
    });
  }

  @Transaction()
  public async ApplyGrowth(ctx: Context, id: string, growthJSON: string, nowISO: string, idemKey: string): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireNonEmpty(id, 'id');
      assertISO(nowISO, 'nowISO');
      const pokemon = await loadPokemon(ctx, id);
      const owner = await loadPlayer(ctx, pokemon.ownerId);
      if (getRole(ctx) !== 'system') {
        assertCallerIsPlayer(ctx, owner);
      }
      assertIdle(pokemon.status, 'pokemon', id);
      const growth = parseJSON<Record<string, unknown>>(growthJSON, 'growthJSON');
      if (growth === null || typeof growth !== 'object' || Array.isArray(growth)) {
        fail('INVALID_PARAM', 'growthJSON must be a JSON object');
      }
      if (growth.level !== undefined) {
        const level = safeInt(growth.level as string | number, 'growth.level', { min: 1, max: 100 });
        if (level < pokemon.level) {
          fail('INVALID_PARAM', `level must be monotonically non-decreasing (${pokemon.level} -> ${level})`);
        }
        pokemon.level = level;
      }
      if (growth.exp !== undefined) {
        pokemon.exp = safeInt(growth.exp as string | number, 'growth.exp', { min: 0 });
      }
      if (growth.moves !== undefined) {
        pokemon.moves = parseStringArray(growth.moves, 'growth.moves', 4);
      }
      if (growth.evs !== undefined) {
        pokemon.evs = parseGrowthEvs(growth.evs);
      }
      if (growth.ivs !== undefined) {
        pokemon.ivs = applyIvsPatch(growth.ivs, pokemon.ivs, 'growth.ivs');
      }
      if (growth.speciesId !== undefined) {
        pokemon.speciesId = safeInt(growth.speciesId as string | number, 'growth.speciesId', { min: 0 });
      }
      if (growth.name !== undefined) {
        pokemon.name = requireNonEmpty(growth.name as string, 'growth.name');
      }
      await savePokemon(ctx, pokemon);
      emit(ctx, 'PokemonGrowth', { id, level: pokemon.level, exp: pokemon.exp, evs: pokemon.evs, ivs: pokemon.ivs });
      return JSON.stringify(pokemon);
    });
  }

  /**
   * 羁绊值提升（docs/chaincode-api.md §2.3）：仅 system；每只 +=delta（1-50），上限 255 截断；
   * 宝可梦须存在且非 RELEASED（锁定中的宝可梦也可提升）；事件 BondChanged。
   */
  @Transaction()
  public async BondUp(
    ctx: Context,
    pokemonIdsJSON: string,
    delta: string,
    reason: string,
    nowISO: string,
    idemKey: string,
  ): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireRole(ctx, 'system');
      requireNonEmpty(reason, 'reason');
      assertISO(nowISO, 'nowISO');
      const d = safeInt(delta, 'delta', { min: BOND_MIN_DELTA, max: BOND_MAX_DELTA });
      const ids = parseStringArray(parseJSON(pokemonIdsJSON, 'pokemonIdsJSON'), 'pokemonIdsJSON', BOND_UP_MAX_IDS);
      if (ids.length === 0) {
        fail('INVALID_PARAM', 'pokemonIdsJSON must contain at least one pokemon id');
      }
      if (new Set(ids).size !== ids.length) {
        fail('INVALID_PARAM', 'pokemonIdsJSON must not contain duplicate ids');
      }
      const updated: Pokemon[] = [];
      for (const id of ids) {
        const pokemon = await loadPokemon(ctx, id);
        if (pokemon.status === 'RELEASED') {
          fail('BAD_STATE', `pokemon ${id} is RELEASED`);
        }
        pokemon.bond = Math.min(BOND_MAX, pokemon.bond + d);
        await savePokemon(ctx, pokemon);
        emit(ctx, 'BondChanged', { id, ownerId: pokemon.ownerId, bond: pokemon.bond, delta: d, reason });
        updated.push(pokemon);
      }
      return JSON.stringify(updated);
    });
  }

  @Transaction()
  public async Release(ctx: Context, id: string, nowISO: string, idemKey: string): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireNonEmpty(id, 'id');
      assertISO(nowISO, 'nowISO');
      const pokemon = await loadPokemon(ctx, id);
      const owner = await loadPlayer(ctx, pokemon.ownerId);
      assertCallerIsPlayer(ctx, owner);
      assertIdle(pokemon.status, 'pokemon', id);
      pokemon.status = 'RELEASED';
      pokemon.ownerId = '';
      pokemon.lockRef = '';
      await savePokemon(ctx, pokemon);
      emit(ctx, 'PokemonReleased', { id, ownerId: owner.playerId });
      return JSON.stringify(pokemon);
    });
  }

  @Transaction(false)
  @Returns('string')
  public async GetPokemon(ctx: Context, id: string): Promise<string> {
    return JSON.stringify(await loadPokemon(ctx, id));
  }

  @Transaction(false)
  @Returns('string')
  public async QueryByOwner(ctx: Context, ownerId: string): Promise<string> {
    requireNonEmpty(ownerId, 'ownerId');
    const list = await collectQuery(ctx, selectorQuery({ docType: 'pokemon', ownerId }));
    return JSON.stringify(list);
  }

  @Transaction(false)
  @Returns('string')
  public async QueryPokedex(ctx: Context, queryJSON: string): Promise<string> {
    const query = parseJSON<Record<string, unknown>>(queryJSON, 'queryJSON');
    if (query === null || typeof query !== 'object' || Array.isArray(query)) {
      fail('INVALID_PARAM', 'queryJSON must be a JSON object');
    }
    const selector = (query.selector ?? query) as Record<string, unknown>;
    if (selector === null || typeof selector !== 'object' || selector.docType !== 'pokemon') {
      fail('INVALID_PARAM', 'queryJSON selector must include docType="pokemon"');
    }
    const list = await collectQuery(ctx, selectorQuery(selector));
    return JSON.stringify(list);
  }
}
