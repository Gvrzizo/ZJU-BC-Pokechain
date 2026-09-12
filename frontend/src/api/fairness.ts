import { http } from './http';
import type { FairnessResponse } from '@/types';

export async function getFairness(eventId: string): Promise<FairnessResponse> {
  const { data } = await http.get<FairnessResponse>(
    `/fairness/${encodeURIComponent(eventId)}`,
  );
  return data;
}
