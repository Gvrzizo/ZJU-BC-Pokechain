import { http } from './http';
import type { DisputeEntry, Item } from '@/types';

export async function mintItem(payload: {
  playerId: string;
  typeId: string;
  quantity: number;
  uri?: string;
  metadataHash?: string;
}): Promise<Item> {
  const { data } = await http.post<Item>('/admin/items/mint', payload);
  return data;
}

// 争议列表：GET /battles?status=disputed（admin/arbitrator 角色守卫）
export async function listDisputes(status: 'disputed' | 'resolved' | 'all' = 'disputed'): Promise<DisputeEntry[]> {
  const { data } = await http.get<DisputeEntry[]>('/battles', {
    params: { status },
  });
  return data;
}
