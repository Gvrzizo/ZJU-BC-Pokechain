import { getItemType } from '../game-data/items.data';
import { getSpecies } from '../game-data/species.data';
import { computeStats, normalizeEvs, StatBlock } from '../game-data/stats';
import { ContractService } from '../fabric/contract.service';
import { WagerBundle } from '../fabric/chain.types';

/**
 * 押注清单的"可读化"（docs/backend-api.md §5）：房间详情把 `wagerA/B`（资产 id）
 * 富化成前端能直接渲染的明细——宝可梦带中文名/等级/闪光/羁绊/最终能力值（链下按
 * game-data/stats 计算），道具带 typeId/中英文名/押注数量与当前持有量。
 * 资产被消耗或易主后仍会出现在清单里，只是标 `unavailable`/`held=0`，方便前端提示。
 */

export interface WagerPokemonDetail {
  id: string;
  /** 链上种族英文名（assets 不可读时为 null） */
  name: string | null;
  speciesId: number | null;
  /** 中文可读名（species 表查不到时为 null） */
  nameZh: string | null;
  level: number | null;
  shiny: boolean;
  /** 羁绊值 0-255 */
  bond: number | null;
  /** 种族值 + IV + EV + 等级 + 性格 的最终六项能力值 */
  stats: StatBlock | null;
  /** 链上读不到该资产（已被消耗/易主后清理）时为 true */
  unavailable: boolean;
}

export interface WagerItemDetail {
  id: string;
  typeId: string;
  name: string;
  nameZh: string;
  /** 押注数量（旧格式 qty=0 的整堆标记已按当前持有量解析） */
  qty: number;
  /** 该堆叠当前持有量（0 = 链上已不存在） */
  held: number;
  unavailable: boolean;
}

export interface WagerDetail {
  points: number;
  pokemon: WagerPokemonDetail[];
  items: WagerItemDetail[];
  totals: { pokemon: number; itemQty: number; points: number };
}

/** 空押注的富化结果（房间未加入 / 无押注时占位，前端无需判空）。 */
export function emptyWagerDetail(): WagerDetail {
  return { points: 0, pokemon: [], items: [], totals: { pokemon: 0, itemQty: 0, points: 0 } };
}

export async function enrichWager(
  contract: ContractService,
  wager: WagerBundle | null | undefined,
): Promise<WagerDetail> {
  if (!wager) return emptyWagerDetail();

  const pokemon: WagerPokemonDetail[] = [];
  for (const id of wager.pokemonIds ?? []) {
    pokemon.push(await pokemonDetail(contract, id));
  }

  const items: WagerItemDetail[] = [];
  for (const ref of wager.items ?? []) {
    const stack = await contract.getItem(ref.id).catch(() => null);
    const typeId = stack?.typeId ?? '';
    const def = getItemType(typeId);
    const held = stack?.quantity ?? 0;
    const qty = ref.qty > 0 ? ref.qty : held;
    items.push({
      id: ref.id,
      typeId,
      name: def?.name ?? typeId,
      nameZh: def?.nameZh ?? typeId,
      qty,
      held,
      unavailable: !stack,
    });
  }

  const points = wager.points ?? 0;
  return {
    points,
    pokemon,
    items,
    totals: {
      pokemon: pokemon.length,
      itemQty: items.reduce((sum, it) => sum + it.qty, 0),
      points,
    },
  };
}

/**
 * 出战队伍的富化明细（房间详情 `teamDetailA/B`）：与押注宝可梦同一口径，
 * 逐只读链上资产后补中文名/等级/闪光/羁绊/最终能力值。房间当事人与旁观者看到的一致。
 */
export async function enrichTeam(
  contract: ContractService,
  pokemonIds: string[] | null | undefined,
): Promise<WagerPokemonDetail[]> {
  const team: WagerPokemonDetail[] = [];
  for (const id of pokemonIds ?? []) team.push(await pokemonDetail(contract, id));
  return team;
}

/**
 * 排位接受期对手阵容（docs/backend-api.md §11.1）：只保留**对局中人人可见**的信息——
 * 昵称（链上 `name`）、种族（id / 中英文名）、等级、闪光与最终六项能力值。
 * 裁剪掉羁绊与 IV/EV/性格（装备在对手视角不可见），也不要 `unavailable` 占位字段。
 */
export interface OpponentPokemonDetail {
  id: string;
  name: string | null;
  speciesId: number | null;
  nameZh: string | null;
  level: number | null;
  shiny: boolean;
  /** 最终六项能力值（隐去了推导它的 IV/EV/性格） */
  stats: StatBlock | null;
}

export function toOpponentTeam(details: WagerPokemonDetail[]): OpponentPokemonDetail[] {
  return details.map(({ id, name, speciesId, nameZh, level, shiny, stats }) => ({
    id,
    name,
    speciesId,
    nameZh,
    level,
    shiny,
    stats,
  }));
}

async function pokemonDetail(contract: ContractService, id: string): Promise<WagerPokemonDetail> {
  const mon = await contract.getPokemon(id).catch(() => null);
  if (!mon) {
    return { id, name: null, speciesId: null, nameZh: null, level: null, shiny: false, bond: null, stats: null, unavailable: true };
  }
  const species = getSpecies(mon.speciesId);
  return {
    id,
    name: mon.name,
    speciesId: mon.speciesId,
    nameZh: species?.nameZh ?? null,
    level: mon.level,
    shiny: !!mon.shiny,
    bond: mon.bond ?? null,
    stats: species ? computeStats(species.base, mon.ivs, normalizeEvs(mon.evs), mon.level, mon.nature) : null,
    unavailable: false,
  };
}
