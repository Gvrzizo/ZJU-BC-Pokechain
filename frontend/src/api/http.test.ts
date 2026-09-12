import { beforeEach, describe, expect, it } from 'vitest';
import axios, { type AxiosRequestConfig } from 'axios';
import { createPinia, setActivePinia } from 'pinia';
import { attachInterceptors, API_BASE } from './http';
import { useAuthStore } from '@/stores/auth';

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
});
