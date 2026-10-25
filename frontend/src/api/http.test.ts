import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { type AxiosRequestConfig } from 'axios';
import { createPinia, setActivePinia } from 'pinia';
import {
  attachInterceptors,
  API_BASE,
  REFRESH_LOCK_KEY,
  REFRESH_TIMEOUT_MS,
  refreshAccessToken,
  refreshAccessTokenCrossTab,
} from './http';
import { useAuthStore } from '@/stores/auth';
import { createNonce } from '@/utils/nonce';

function makeClient(capture: { config?: AxiosRequestConfig }) {
  const client = axios.create({ baseURL: API_BASE });
  attachInterceptors(client);
  client.defaults.adapter = async (config) => {
    capture.config = config;
    return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
  };
  return client;
}

// node 环境下补一个内存 localStorage
const mem = new Map<string, string>();
beforeEach(() => {
  (globalThis as any).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  };
});

describe('http 拦截器', () => {
  beforeEach(() => {
    mem.clear();
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('变更类请求注入 X-Nonce / X-Timestamp / Authorization', async () => {
    useAuthStore().accessToken = 'tok123';
    const capture: { config?: AxiosRequestConfig } = {};
    await makeClient(capture).post('/capture/attempt', { eventId: 'ev_1' });

    const headers = capture.config!.headers as Record<string, string>;
    expect(headers['X-Nonce']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(new Date(headers['X-Timestamp']).toString()).not.toBe('Invalid Date');
    expect(headers['Authorization']).toBe('Bearer tok123');
  });

  it('GET 请求不注入防重放头；两次 POST 的 nonce 不同', async () => {
    const c1: { config?: AxiosRequestConfig } = {};
    await makeClient(c1).get('/pokedex');
    const h1 = c1.config!.headers as Record<string, string>;
    expect(h1['X-Nonce']).toBeUndefined();
    expect(h1['X-Timestamp']).toBeUndefined();

    const c2: { config?: AxiosRequestConfig } = {};
    const client = makeClient(c2);
    await client.post('/a', {});
    const n1 = (c2.config!.headers as Record<string, string>)['X-Nonce'];
    await client.post('/b', {});
    const n2 = (c2.config!.headers as Record<string, string>)['X-Nonce'];
    expect(n1).not.toBe(n2);
  });

  it('refresh 请求带 5s 超时（H17：首屏不会因 refresh 挂起卡死）', async () => {
    useAuthStore().setTokens('old-access', 'old-refresh');
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { accessToken: 'new-access', refreshToken: 'new-refresh' },
    } as never);
    try {
      await expect(refreshAccessToken()).resolves.toBe('new-access');
      expect(post).toHaveBeenCalledWith(
        `${API_BASE}/auth/refresh`,
        { refreshToken: 'old-refresh' },
        { timeout: REFRESH_TIMEOUT_MS },
      );
      expect(REFRESH_TIMEOUT_MS).toBe(5000);
      expect(useAuthStore().accessToken).toBe('new-access');
    } finally {
      post.mockRestore();
    }
  });

  it('H18：crypto.randomUUID 不可用时退回 getRandomValues（非安全上下文不报错）', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i += 1) arr[i] = i + 1;
        return arr;
      },
    });
    try {
      expect(createNonce()).toBe('0102030405060708090a0b0c0d0e0f10');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('P2-3：refresh 锁在本标签持有时会正常 refresh 并释放锁', async () => {
    useAuthStore().setTokens('old-access', 'old-refresh');
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { accessToken: 'new-access', refreshToken: 'new-refresh' },
    } as never);
    try {
      await expect(refreshAccessTokenCrossTab()).resolves.toBe('new-access');
      expect(post).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(REFRESH_LOCK_KEY)).toBeNull();
    } finally {
      post.mockRestore();
    }
  });

  it('P2-3：另一标签页持锁时等待其写入的新 token，不并发 refresh', async () => {
    useAuthStore().setTokens('old-access', 'old-refresh');
    localStorage.setItem(REFRESH_LOCK_KEY, String(Date.now()));
    const post = vi.spyOn(axios, 'post');
    try {
      const pending = refreshAccessTokenCrossTab();
      setTimeout(() => {
        useAuthStore().setTokens('new-access', 'new-refresh');
        localStorage.removeItem(REFRESH_LOCK_KEY);
      }, 50);
      await expect(pending).resolves.toBe('new-access');
      expect(post).not.toHaveBeenCalled();
    } finally {
      post.mockRestore();
    }
  });
});
