import { http } from './http';
import type { Trade, TradeAssets } from '@/types';

export async function listTrades(box: 'in' | 'out'): Promise<Trade[]> {
  const { data } = await http.get<Trade[]>('/trades', { params: { box } });
  return data;
}

export async function getTrade(id: string): Promise<Trade> {
  const { data } = await http.get<Trade>(`/trades/${encodeURIComponent(id)}`);
  return data;
}

export async function createTrade(payload: {
  toPlayerId: string;
  offer: TradeAssets;
  request: TradeAssets;
  ttlSeconds: number;
}): Promise<Trade> {
  const { data } = await http.post<Trade>('/trades', payload);
  return data;
}

export async function confirmTrade(id: string): Promise<Trade> {
  const { data } = await http.post<Trade>(`/trades/${encodeURIComponent(id)}/confirm`);
  return data;
}

export async function cancelTrade(id: string): Promise<Trade> {
  const { data } = await http.post<Trade>(`/trades/${encodeURIComponent(id)}/cancel`);
  return data;
}
