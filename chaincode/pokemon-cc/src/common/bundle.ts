import { Context } from 'fabric-contract-api';
import { fail, parseJSON, safeInt } from './assert';
import { AssetBundle, Item, ItemStackRef, Pokemon, WagerBundle, WagerInput } from './model';
import { requireOwnedIdleItem, requireOwnedIdlePokemon } from './state';

/** 解析 offer/request JSON（Trade，整堆语义）：{pokemonIds:[], itemIds:[], points:0}。 */
export function parseBundle(raw: string, name: string): AssetBundle {
  const obj = parseJSON<Record<string, unknown>>(raw, name);
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    fail('INVALID_PARAM', `${name} must be a JSON object {pokemonIds,itemIds,points}`);
  }
  const bundle: AssetBundle = {
    pokemonIds: parseIdList(obj.pokemonIds, `${name}.pokemonIds`),
    itemIds: parseIdList(obj.itemIds, `${name}.itemIds`),
    points: obj.points === undefined ? 0 : safeInt(obj.points as string | number, `${name}.points`, { min: 0 }),
  };
  return bundle;
}

function parseIdList(raw: unknown, name: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    fail('INVALID_PARAM', `${name} must be an array of ids`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || v.length === 0) {
      fail('INVALID_PARAM', `${name} entries must be non-empty strings`);
    }
    if (seen.has(v)) {
      fail('INVALID_PARAM', `${name} contains duplicate id ${v}`);
    }
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * 解析对战 wager JSON：`{pokemonIds:[], items:[{id,qty}], points:0}`。
 * 兼容旧格式 `{itemIds:[...]}`（解析层归一为整堆：qty=0）；`items` 与非空 `itemIds` 并存视为歧义拒绝。
 * 注意：wagerHash 覆盖的是归一后的对象，链下计算必须用同样的归一化（backend chain.adapter.normalizeWagerBundle）。
 */
export function parseWagerBundle(raw: string, name: string): WagerBundle {
  const obj = parseJSON<Record<string, unknown>>(raw, name);
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    fail('INVALID_PARAM', `${name} must be a JSON object {pokemonIds,items,points}`);
  }
  return normalizeWagerInput(obj as WagerInput, name);
}

/**
 * 对象级归一（parseWagerBundle 的复用体；链下计算 wagerHash 时须调用它）。
 * 两种道具字段都非空时视为歧义拒绝；`items` 与空 `itemIds: []` 并存按 `items` 处理（DTO 默认值常见形态）。
 */
export function normalizeWagerInput(input: WagerInput, name: string): WagerBundle {
  const usesItems = input.items !== undefined;
  if (usesItems && !Array.isArray(input.items)) {
    fail('INVALID_PARAM', `${name}.items must be an array of {id, qty}`);
  }
  const legacyIds = input.itemIds ?? [];
  if (usesItems && legacyIds.length > 0) {
    fail('INVALID_PARAM', `${name} must not mix items[] with the legacy itemIds[]`);
  }
  return {
    pokemonIds: parseIdList(input.pokemonIds, `${name}.pokemonIds`),
    items: usesItems ? parseItemStackList(input.items, undefined, `${name}.items`) : parseItemStackList(undefined, legacyIds, `${name}.items`),
    points: input.points === undefined ? 0 : safeInt(input.points as string | number, `${name}.points`, { min: 0 }),
  };
}

function parseItemStackList(raw: unknown, legacyRaw: unknown, name: string): ItemStackRef[] {
  const entries: ItemStackRef[] = [];
  const seen = new Set<string>();
  const push = (id: string, qty: number): void => {
    if (seen.has(id)) {
      fail('INVALID_PARAM', `${name} contains duplicate id ${id}`);
    }
    seen.add(id);
    entries.push({ id, qty });
  };
  if (raw !== undefined) {
    if (!Array.isArray(raw)) {
      fail('INVALID_PARAM', `${name} must be an array of {id, qty}`);
    }
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        fail('INVALID_PARAM', `${name} entries must be objects {id, qty}`);
      }
      const ref = entry as Record<string, unknown>;
      if (typeof ref.id !== 'string' || ref.id.length === 0) {
        fail('INVALID_PARAM', `${name} entries need a non-empty id`);
      }
      push(ref.id, safeInt(ref.qty as string | number, `${name}[].qty`, { min: 1 }));
    }
    return entries;
  }
  // 旧格式 itemIds：整堆（qty=0）
  for (const id of parseIdList(legacyRaw, name)) {
    push(id, 0);
  }
  return entries;
}

export interface LockedAssets {
  pokemons: Pokemon[];
  items: Item[];
}

/** 逐项校验宝可梦存在、归 owner 所有、status=IDLE。 */
export async function validatePokemonAssets(ctx: Context, ids: string[], ownerId: string, side: string): Promise<Pokemon[]> {
  const pokemons: Pokemon[] = [];
  for (const pid of ids) {
    try {
      pokemons.push(await requireOwnedIdlePokemon(ctx, pid, ownerId));
    } catch (e) {
      throw prefixErr(side, e);
    }
  }
  return pokemons;
}

/** 逐项校验资产存在、归 owner 所有、status=IDLE（docs/chaincode-api.md §2.5/§2.6）。 */
export async function validateBundleAssets(ctx: Context, bundle: AssetBundle, ownerId: string, side: string): Promise<LockedAssets> {
  const pokemons = await validatePokemonAssets(ctx, bundle.pokemonIds, ownerId, side);
  const items: Item[] = [];
  for (const iid of bundle.itemIds) {
    try {
      items.push(await requireOwnedIdleItem(ctx, iid, ownerId));
    } catch (e) {
      throw prefixErr(side, e);
    }
  }
  return { pokemons, items };
}

function prefixErr(side: string, e: unknown): Error {
  if (e instanceof Error) {
    const idx = e.message.indexOf(': ');
    if (idx > 0) {
      return new Error(`${e.message.slice(0, idx)}: [${side}] ${e.message.slice(idx + 2)}`);
    }
  }
  return e as Error;
}
