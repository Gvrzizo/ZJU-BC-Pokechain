import { Context, Contract, Transaction } from 'fabric-contract-api';
import { fail, parseBoolean, parseStringArray, requireNonEmpty, safeInt } from '../common/assert';
import { getRole } from '../common/cid';
import { canonicalJson, deriveRandom, sha256hex } from '../common/crypto';
import { withIdempotency } from '../common/idempotency';
import { BOND_DEFAULT, IV_KEYS, IV_MAX, Ivs, Pokemon, zeroEvs } from '../common/model';
import {
  assertCallerIsPlayer,
  consumeRandom,
  debitPoints,
  emit,
  exists,
  loadPlayer,
  loadPokemon,
  loadRand,
  savePlayer,
  savePokemon,
} from '../common/state';

/**
 * 血统繁殖（[FEAT:breeding]）。
 *
 * 设计要点（docs/feature-breeding.md）：
 * - 复用 purpose='mint' 的既有随机事件类型，不改 RandomContract；
 * - 链码**自己按派生流重算子代属性**再与传入值比对，后端无法伪造 IV/性格/闪光；
 * - 子代 dnaHash 即血统承诺（绑定双亲 id/dnaHash、事件、子代 id），链码重算；
 * - 不新增状态机、不加锁、不加索引：整笔交易内完成，并发靠积分写冲突与 Fabric 校验兜底。
 */

const MIN_BREED_LEVEL = 20;
const COST = 200;
const LINEAGE_VERSION = 'pokechain-breed-v1';
/** 派生流区段（与 backend/src/breeding/breeding-derive.ts 一致）。 */
const IV_BLOCK = 50000;
const NATURE_SLOT = 50012;
const SHINY_SLOT = 50013;
const SHINY_DENOMINATOR = 4096;

const IV_CHOICE_PARENT_A = 0.4;
const IV_CHOICE_PARENT_B = 0.8;

interface BreedInput {
  childId: string;
  parentAId: string;
  parentBId: string;
  speciesId: number;
  name: string;
  ivs: Record<string, number>;
  nature: string;
  ability: string;
  shiny: boolean;
  moves: string[];
  eventId: string;
}

function lineageHashOf(a: Pokemon, b: Pokemon, eventId: string, childId: string): string {
  return sha256hex(`${LINEAGE_VERSION}|${a.id}|${a.dnaHash}|${b.id}|${b.dnaHash}|${eventId}|${childId}`);
}

function deriveChild(
  serverSeed: string,
  clientSeed: string,
  eventId: string,
  a: Pokemon,
  b: Pokemon,
): { ivs: Ivs; nature: string; shiny: boolean } {
  const rand = (n: number) => deriveRandom(serverSeed, clientSeed, eventId, n);
  const ivs = {} as Ivs;
  IV_KEYS.forEach((key, index) => {
    const choice = rand(IV_BLOCK + index * 2);
    ivs[key] =
      choice < IV_CHOICE_PARENT_A
        ? a.ivs[key]
        : choice < IV_CHOICE_PARENT_B
          ? b.ivs[key]
          : Math.floor(rand(IV_BLOCK + index * 2 + 1) * (IV_MAX + 1));
  });
  return {
    ivs,
    nature: rand(NATURE_SLOT) < 0.5 ? a.nature : b.nature,
    shiny: rand(SHINY_SLOT) < 1 / SHINY_DENOMINATOR,
  };
}

function parseIvs(raw: string): Record<string, number> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('INVALID_PARAM', 'ivsJSON must be a JSON object');
  }
  const out: Record<string, number> = {};
  for (const key of IV_KEYS) {
    const value = parsed[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > IV_MAX) {
      fail('INVALID_PARAM', `ivs.${key} must be an integer 0-${IV_MAX}, got "${String(value)}"`);
    }
    out[key] = value;
  }
  return out;
}

export class BreedingContract extends Contract {
  constructor() {
    super('BreedingContract');
  }

  @Transaction()
  public async Breed(
    ctx: Context,
    childId: string,
    parentAId: string,
    parentBId: string,
    speciesId: string,
    name: string,
    ivsJSON: string,
    nature: string,
    ability: string,
    shiny: string,
    movesJSON: string,
    eventId: string,
    nowISO: string,
    idemKey: string,
  ): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      const input: BreedInput = {
        childId: requireNonEmpty(childId, 'childId'),
        parentAId: requireNonEmpty(parentAId, 'parentAId'),
        parentBId: requireNonEmpty(parentBId, 'parentBId'),
        speciesId: safeInt(speciesId, 'speciesId', { min: 1, max: 1000 }),
        name: requireNonEmpty(name, 'name'),
        ivs: parseIvs(ivsJSON),
        nature: requireNonEmpty(nature, 'nature'),
        ability: requireNonEmpty(ability, 'ability'),
        shiny: parseBoolean(shiny, 'shiny'),
        moves: parseStringArray(JSON.parse(movesJSON), 'movesJSON', 4),
        eventId: requireNonEmpty(eventId, 'eventId'),
      };

      if (input.parentAId === input.parentBId) {
        fail('INVALID_PARAM', 'parentAId and parentBId must differ');
      }

      const parentA = await loadPokemon(ctx, input.parentAId);
      const parentB = await loadPokemon(ctx, input.parentBId);
      if (parentA.ownerId !== parentB.ownerId) {
        fail('NOT_OWNER', `parents belong to different owners (${parentA.ownerId} / ${parentB.ownerId})`);
      }
      const owner = await loadPlayer(ctx, parentA.ownerId);
      // 玩家本人签名；system 允许（seed/补数据）
      if (getRole(ctx) !== 'system') {
        assertCallerIsPlayer(ctx, owner);
      }
      for (const parent of [parentA, parentB]) {
        if (parent.status !== 'IDLE') {
          fail('ASSET_LOCKED', `pokemon ${parent.id} is not IDLE (status=${parent.status})`);
        }
        if (parent.level < MIN_BREED_LEVEL) {
          fail('INVALID_PARAM', `pokemon ${parent.id} must be level >= ${MIN_BREED_LEVEL}, got ${parent.level}`);
        }
      }
      if (await exists(ctx, 'pokemon', input.childId)) {
        fail('POKEMON_EXISTS', `pokemon ${input.childId} already exists`);
      }

      // 随机事件：先取记录用于重算，再消费（同交易内失败会整体回滚）
      const rand = await loadRand(ctx, input.eventId);
      await consumeRandom(ctx, input.eventId, 'mint', owner.playerId);

      const expectedLineage = lineageHashOf(parentA, parentB, input.eventId, input.childId);
      const expected = deriveChild(rand.serverSeed, rand.clientSeed, input.eventId, parentA, parentB);
      if (canonicalJson(expected.ivs) !== canonicalJson(input.ivs) || expected.nature !== input.nature || expected.shiny !== input.shiny) {
        fail('HEREDITY_MISMATCH', `child attributes do not match the committed random stream of ${input.eventId}`);
      }

      debitPoints(owner, COST);
      await savePlayer(ctx, owner);

      const child: Pokemon = {
        docType: 'pokemon',
        id: input.childId,
        speciesId: input.speciesId,
        name: input.name,
        dnaHash: expectedLineage,
        ivs: expected.ivs,
        evs: zeroEvs(),
        nature: input.nature,
        ability: input.ability,
        shiny: input.shiny,
        level: 1,
        exp: 0,
        moves: input.moves,
        ownerId: owner.playerId,
        status: 'IDLE',
        lockRef: '',
        captureEventId: input.eventId,
        createdAt: nowISO,
        bond: BOND_DEFAULT,
        parents: [parentA.id, parentB.id],
        generation: Math.max(parentA.generation ?? 0, parentB.generation ?? 0) + 1,
      };
      await savePokemon(ctx, child);
      emit(ctx, 'PokemonBred', {
        id: child.id,
        parentAId: parentA.id,
        parentBId: parentB.id,
        ownerId: child.ownerId,
        generation: child.generation,
        cost: COST,
      });
      return JSON.stringify(child);
    });
  }

  @Transaction(false)
  public async GetLineage(ctx: Context, pokemonId: string): Promise<string> {
    const pokemon = await loadPokemon(ctx, requireNonEmpty(pokemonId, 'pokemonId'));
    const parents = pokemon.parents ?? [];
    const summaries = [];
    for (const id of parents) {
      const parent = await loadPokemon(ctx, id).catch(() => null);
      summaries.push(
        parent
          ? { id: parent.id, speciesId: parent.speciesId, name: parent.name, level: parent.level, ownerId: parent.ownerId }
          : { id, speciesId: 0, name: '', level: 0, ownerId: '' },
      );
    }
    return JSON.stringify({
      id: pokemon.id,
      speciesId: pokemon.speciesId,
      name: pokemon.name,
      generation: pokemon.generation ?? 0,
      dnaHash: pokemon.dnaHash,
      parents: summaries,
    });
  }

  @Transaction(false)
  public async GetBreedingConfig(ctx: Context): Promise<string> {
    return JSON.stringify({
      minLevel: MIN_BREED_LEVEL,
      cost: COST,
      layout: {
        version: LINEAGE_VERSION,
        ivBlock: IV_BLOCK,
        natureSlot: NATURE_SLOT,
        shinySlot: SHINY_SLOT,
        shinyDenominator: SHINY_DENOMINATOR,
        inherited: { parentA: IV_CHOICE_PARENT_A, parentB: 0.4, random: 0.2 },
      },
    });
  }
}
