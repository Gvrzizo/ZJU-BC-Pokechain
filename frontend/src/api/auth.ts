import { http } from './http';
import type { AuthTokens, Item, Pokemon, User } from '@/types';

export interface LoginResponse extends AuthTokens {
  user: User;
}

/** POST /users/me/starter 响应：链上铸造的御三家 + 礼包堆叠（数量为合并后的持有量） */
export interface StarterClaim {
  pokemon: Pokemon;
  items: Item[];
  gift: Array<{ typeId: string; quantity: number }>;
}

export async function register(payload: {
  username: string;
  password: string;
  nickname: string;
}): Promise<LoginResponse> {
  const { data } = await http.post<LoginResponse>('/auth/register', payload);
  return data;
}

export async function login(payload: {
  username: string;
  password: string;
}): Promise<LoginResponse> {
  const { data } = await http.post<LoginResponse>('/auth/login', payload);
  return data;
}

export async function logout(refreshToken: string): Promise<void> {
  await http.post('/auth/logout', { refreshToken });
}

// GET /users/me 响应为 { user: ... }（链上 points/wins/losses 合并后的资料）
export async function getMe(): Promise<User> {
  const { data } = await http.get<{ user: User }>('/users/me');
  return data.user;
}

export async function patchMe(payload: {
  nickname?: string;
  avatarUri?: string;
}): Promise<User> {
  const { data } = await http.patch<{ user: User }>('/users/me', payload);
  return data.user;
}

/**
 * 新手礼包：注册后仅一次，三选一御三家（speciesId 1 妙蛙种子 / 4 小火龙 / 7 杰尼龟）。
 * 重复调用返回 409 STARTER_ALREADY_CLAIMED。
 */
export async function claimStarter(speciesId: number): Promise<StarterClaim> {
  const { data } = await http.post<StarterClaim>('/users/me/starter', { speciesId });
  return data;
}
