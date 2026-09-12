import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { createPinia, setActivePinia } from 'pinia';
import { authGuard } from './guard';
import { useAuthStore } from '@/stores/auth';
import type { User } from '@/types';

vi.mock('@/api/auth', () => ({ getMe: vi.fn() }));
import { getMe } from '@/api/auth';

const mesh: { user: User } = {
  user: { id: 'u1', username: 'ash', nickname: '小智', role: 'player', points: 1000 },
};

function makeRouter(): Router {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/game' },
      { path: '/login', name: 'login', component: { render: () => null }, meta: { guestOnly: true } },
      { path: '/game', name: 'game', component: { render: () => null }, meta: { requiresAuth: true } },
      { path: '/admin', name: 'admin', component: { render: () => null }, meta: { requiresAuth: true, requiresAdmin: true } },
    ],
  });
  router.beforeEach(authGuard);
  return router;
}

function seedSession(user: User | null = mesh.user, accessToken = 'tok123') {
  localStorage.setItem(
    'pokechain.auth.v1',
    JSON.stringify({ accessToken, refreshToken: 'ref123', user }),
  );
}

// node 环境下补一个内存 localStorage（沿用 http.test.ts 的做法）
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

describe('authGuard: 首次导航先完成会话初始化', () => {
  it('无 token：受保护路由直接落到登录页并带 redirect', async () => {
    const router = makeRouter();
    await router.push('/game');

    expect(router.currentRoute.value.name).toBe('login');
    expect(router.currentRoute.value.query.redirect).toBe('/game');
    expect(getMe).not.toHaveBeenCalled();
  });

  it('有 token 且校验成功：放行 /game，user 与 initialized 一起就位（导航栏不再半初始化）', async () => {
    seedSession();
    vi.mocked(getMe).mockResolvedValue(mesh.user);
    const router = makeRouter();

    await router.push('/game');

    const auth = useAuthStore();
    expect(router.currentRoute.value.name).toBe('game');
    expect(auth.initialized).toBe(true);
    expect(auth.user?.nickname).toBe('小智');
  });

  it('token 校验失败（后端未就绪/已过期且 refresh 失败）：清会话并跳登录页，不再停留在 /game', async () => {
    seedSession();
    vi.mocked(getMe).mockRejectedValue(new Error('401'));
    const router = makeRouter();

    await router.push('/game');

    const auth = useAuthStore();
    expect(router.currentRoute.value.name).toBe('login');
    expect(auth.isLoggedIn).toBe(false);
    expect(auth.user).toBeNull();
    expect(localStorage.getItem('pokechain.auth.v1')).toBeNull();
  });

  it('初始化只做一次：已登录后再次导航不再重复调 /users/me', async () => {
    seedSession();
    vi.mocked(getMe).mockResolvedValue(mesh.user);
    const router = makeRouter();

    await router.push('/game');
    await router.push('/login'); // guestOnly + 已登录 -> 弹回 /game

    expect(router.currentRoute.value.name).toBe('game');
    expect(getMe).toHaveBeenCalledTimes(1);
  });

  it('未登录时登录页正常进入', async () => {
    const router = makeRouter();
    await router.push('/login');
    expect(router.currentRoute.value.name).toBe('login');
  });

  it('已登录时访问 guestOnly（登录页）被弹回 /game', async () => {
    seedSession();
    vi.mocked(getMe).mockResolvedValue(mesh.user);
    const router = makeRouter();
    await router.push('/login');
    expect(router.currentRoute.value.name).toBe('game');
  });
});
