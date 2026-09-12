import { http } from './http';
import type { PokedexEntry, Pokemon } from '@/types';

export async function getMyPokemon(): Promise<Pokemon[]> {
  const { data } = await http.get<Pokemon[]>('/pokemon', { params: { owner: 'me' } });
  return data;
}

export async function getPokemon(id: string): Promise<Pokemon> {
  const { data } = await http.get<Pokemon>(`/pokemon/${encodeURIComponent(id)}`);
  return data;
}

export async function getPokedex(): Promise<PokedexEntry[]> {
  const { data } = await http.get<PokedexEntry[]>('/pokedex');
  return data;
}

export async function trainPokemon(id: string, costPoints: number): Promise<Pokemon> {
  const { data } = await http.post<Pokemon>(
    `/pokemon/${encodeURIComponent(id)}/train`,
    { costPoints },
  );
  return data;
}

/**
 * 进化：不传 stoneItemId = 等级进化（EVOLUTIONS 里纯等级分支，等级达标即可）；
 * 传 = 进化石进化（消耗 1 个对应石头）。返回更新后的详情（带新的 evolution/evolutions）。
 */
export async function evolvePokemon(id: string, stoneItemId?: string): Promise<Pokemon> {
  const { data } = await http.post<Pokemon>(
    `/pokemon/${encodeURIComponent(id)}/evolve`,
    stoneItemId ? { stoneItemId } : {},
  );
  return data;
}

export async function releasePokemon(id: string): Promise<void> {
  await http.post(`/pokemon/${encodeURIComponent(id)}/release`);
}

/** 宝可梦中心治疗结果：`charged=false` 表示全员满血、本次未扣费（docs/backend-api.md §10）。 */
export interface CenterHealResult {
  cost: number;
  charged: boolean;
  /** 扣费后的链上积分余额 */
  points: number;
  healed: Array<{
    pokemonId: string;
    speciesId: number;
    name: string;
    before: number;
    after: number;
    maxHp: number;
  }>;
}

/**
 * 宝可梦中心：全队回满，每次 10P（`AddPoints(-10, reason='heal:center')`）。
 * 全员满血时不扣费（`charged=false`，`healed=[]`）。
 */
export async function healTeam(): Promise<CenterHealResult> {
  const { data } = await http.post<CenterHealResult>('/pokemon/center/heal');
  return data;
}

export async function learnMove(
  id: string,
  moveId: string,
  forgetMoveId?: string,
): Promise<Pokemon> {
  const { data } = await http.post<Pokemon>(
    `/pokemon/${encodeURIComponent(id)}/moves/learn`,
    { moveId, forgetMoveId },
  );
  return data;
}
