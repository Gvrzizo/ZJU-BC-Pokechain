import { http } from './http';
import type { AssetManifestEntry } from '@/types';

export async function getAssetManifest(): Promise<AssetManifestEntry[]> {
  const { data } = await http.get<AssetManifestEntry[]>('/assets/manifest');
  return data;
}
