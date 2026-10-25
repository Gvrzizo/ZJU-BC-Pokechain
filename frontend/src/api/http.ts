import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios';
import { useAuthStore } from '@/stores/auth';
import { createNonce } from '@/utils/nonce';

export const API_BASE = '/api/v1';

// 变更类方法需要带防重放头（X-Nonce / X-Timestamp）
const MUTATING = new Set(['post', 'put', 'patch', 'delete']);

let refreshing: Promise<string> | null = null;

/** 跨标签页 refresh 互斥锁（P2-3）：同一时刻只让一个标签页轮换 refresh token。 */
export const REFRESH_LOCK_KEY = 'pokechain.auth.refresh-lock';
export const REFRESH_LOCK_TTL_MS = 10_000;

function readRefreshLock(): number {
  try {
    return Number(localStorage.getItem(REFRESH_LOCK_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function acquireRefreshLock(): boolean {
  const now = Date.now();
  const held = readRefreshLock();
  if (held && now - held < REFRESH_LOCK_TTL_MS) return false;
  try {
    localStorage.setItem(REFRESH_LOCK_KEY, String(now));
  } catch {
    /* 隐私模式/localStorage 不可用：退化为本页单飞 */
  }
  return true;
}

function releaseRefreshLock(): void {
  try {
    localStorage.removeItem(REFRESH_LOCK_KEY);
  } catch {
    /* ignore */
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 跨标签页协调的 refresh（P2-3）：
 * - 拿到锁：正常 refresh，结束时释放（失败也释放，避免死锁）；
 * - 别的标签页持锁：等待它把新 token 写进 localStorage（auth store 的 storage 监听会同步过来）；
 *   超时/对方失败则自己再 refresh 一次。
 */
export async function refreshAccessTokenCrossTab(): Promise<string> {
  if (acquireRefreshLock()) {
    try {
      return await refreshAccessToken();
    } finally {
      releaseRefreshLock();
    }
  }
  const before = useAuthStore().accessToken;
  for (let i = 0; i < 25; i += 1) {
    await sleep(200);
    const current = useAuthStore().accessToken;
    if (current && current !== before) return current;
    const held = readRefreshLock();
    if (!held || Date.now() - held >= REFRESH_LOCK_TTL_MS) break;
  }
  // 对方没把新 token 交出来（拒绝/崩溃/超时）：自己补一次
  return refreshAccessToken();
}

/** H17：refresh 不能沿用全局 15s（首屏守卫 await 它，挂起会把全站卡在 loading）。 */
export const REFRESH_TIMEOUT_MS = 5000;

export async function refreshAccessToken(): Promise<string> {
  const auth = useAuthStore();
  if (!auth.refreshToken) throw new Error('NO_REFRESH_TOKEN');
  const { data } = await axios.post(
    `${API_BASE}/auth/refresh`,
    { refreshToken: auth.refreshToken },
    { timeout: REFRESH_TIMEOUT_MS },
  );
  auth.setTokens(data.accessToken, data.refreshToken);
  return data.accessToken as string;
}

export function attachInterceptors(client: AxiosInstance): void {
  client.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    const auth = useAuthStore();
    const method = (config.method ?? 'get').toLowerCase();
    if (MUTATING.has(method)) {
      // 防重放：每次变更请求生成一次性 nonce + 时间戳
      config.headers.set('X-Nonce', createNonce());
      config.headers.set('X-Timestamp', new Date().toISOString());
    }
    if (auth.accessToken) {
      config.headers.set('Authorization', `Bearer ${auth.accessToken}`);
    }
    return config;
  });

  client.interceptors.response.use(
    (res) => res,
    async (error: AxiosError) => {
      const original = error.config as (AxiosRequestConfig & { _retried?: boolean }) | undefined;
      const status = error.response?.status;
      const url = original?.url ?? '';
      const isAuthEndpoint = url.includes('/auth/login') || url.includes('/auth/refresh');
      if (status === 401 && original && !original._retried && !isAuthEndpoint) {
        original._retried = true;
        try {
          refreshing = refreshing ?? refreshAccessTokenCrossTab();
          const token = await refreshing;
          refreshing = null;
          original.headers = {
            ...original.headers,
            Authorization: `Bearer ${token}`,
          };
          return client(original);
        } catch (e) {
          refreshing = null;
          const auth = useAuthStore();
          auth.clear();
          return Promise.reject(error);
        }
      }
      return Promise.reject(error);
    },
  );
}

export function createHttp(): AxiosInstance {
  const client = axios.create({
    baseURL: API_BASE,
    timeout: 15000,
  });
  attachInterceptors(client);
  return client;
}

export const http = createHttp();
