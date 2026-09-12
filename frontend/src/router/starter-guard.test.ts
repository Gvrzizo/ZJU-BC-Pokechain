import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { createPinia, setActivePinia } from 'pinia';
import { authGuard, needsStarter } from './guard';
import { useAuthStore } from '@/stores/auth';
import type { User } from '@/types';

vi.mock('@/api/auth', () => ({ getMe: vi.fn() }));
import { getMe } from '@/api/auth';

const base: User = { id: 'u1', username: 'ash', nickname: '小智', role: 'player', points: 1000 };
const newPlayer: User = { ...base, hasStarter: false };
const oldPlayer: User = { ...base, hasStarter: true };

function makeRouter(): Router {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', name: 'login', component: { render: () => null }, meta: { guestOnly: true } },
      { path: '/game', name: 'game', component: { render: () => null }, meta: { requiresAuth: true } },
      { path: '/starter', name: 'starter', component: { render: () => null }, meta: { requiresAuth: true } },
    ],
  });
  router.beforeEach(authGuard);
  return router;
}

function seedSession(user: User) {
  localStorage.setItem(
    'pokechain.auth.v1',
    JSON.stringify({ accessToken: 'tok123', refreshToken: 'ref123', user }),
  );
}

const mem = new Map<string, string>();
beforeEach(() => {
  (globalThis as any).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  };
  mem.clear();
  setActivePinia(createPinia());
  vi.mocked(getMe).mockReset();
});

describe('needsStarter：只有「player + hasStarter===false」才触发新手引导', () => {
  it('未领御三家的玩家为 true，其余情况为 false', () => {
    expect(needsStarter(newPlayer)).toBe(true);
    expect(needsStarter(oldPlayer)).toBe(false);
    // undefined = 还没拉到 /users/me，不误跳
    expect(needsStarter(base)).toBe(false);
    expect(needsStarter(null)).toBe(false);
    expect(needsStarter(undefined)).toBe(false);
    expect(needsStarter({ ...newPlayer, role: 'admin' })).toBe(false);
    expect(needsStarter({ ...newPlayer, role: 'arbitrator' })).toBe(false);
  });
});

describe('authGuard：已登录未领御三家 → 先进 /starter', () => {
  it('访问 /game 被重定向到 /starter', async () => {
    seedSession(newPlayer);
    vi.mocked(getMe).mockResolvedValue(newPlayer);
    const router = makeRouter();

    await router.push('/game');

    expect(router.currentRoute.value.name).toBe('starter');
    expect(useAuthStore().user?.hasStarter).toBe(false);
  });

  it('已领御三家：/game 正常放行，/starter 也不被弹走', async () => {
    seedSession(oldPlayer);
    vi.mocked(getMe).mockResolvedValue(oldPlayer);
    const router = makeRouter();

    await router.push('/game');
    expect(router.currentRoute.value.name).toBe('game');

    await router.push('/starter');
    expect(router.currentRoute.value.name).toBe('starter');
  });

  it('未登录访问 /starter：按受保护路由落到登录页', async () => {
    const router = makeRouter();
    await router.push('/starter');

    expect(router.currentRoute.value.name).toBe('login');
    expect(router.currentRoute.value.query.redirect).toBe('/starter');
  });
});
