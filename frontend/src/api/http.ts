import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios';
import { useAuthStore } from '@/stores/auth';

export const API_BASE = '/api/v1';

// 变更类方法需要带防重放头（X-Nonce / X-Timestamp）
const MUTATING = new Set(['post', 'put', 'patch', 'delete']);

let refreshing: Promise<string> | null = null;

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
      config.headers.set('X-Nonce', crypto.randomUUID());
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
          refreshing = refreshing ?? refreshAccessToken();
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
