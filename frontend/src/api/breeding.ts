import { http } from './http';
import type { Pokemon } from '@/types';

// --- [FEAT:breeding] begin ---

export interface BreedingConfig {
  minLevel: number;
  cost: number;
  layout?: Record<string, unknown>;
}

export interface LineageParent {
  id: string;
  speciesId: number;
  name: string;
  level: number;
  ownerId: string;
}

export interface Lineage {
  id: string;
  speciesId: number;
  name: string;
  generation: number;
  dnaHash: string;
  parents: LineageParent[];
}

export async function getBreedingConfig(): Promise<BreedingConfig> {
  const { data } = await http.get<BreedingConfig>('/breeding/config');
  return data;
}

export async function getLineage(id: string): Promise<Lineage> {
  const { data } = await http.get<Lineage>(`/breeding/lineage/${encodeURIComponent(id)}`);
  return data;
}

/** 繁殖：亲代 A/B 必须同 owner、IDLE、等级达标；费用与遗传校验都在链码。 */
export async function breed(parentAId: string, parentBId: string): Promise<Pokemon> {
  const { data } = await http.post<Pokemon>('/breeding/breed', { parentAId, parentBId });
  return data;
}

// --- [FEAT:breeding] end ---
