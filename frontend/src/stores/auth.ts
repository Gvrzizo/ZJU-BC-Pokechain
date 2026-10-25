import { defineStore } from 'pinia';
import { getMe } from '@/api/auth';
import type { User } from '@/types';

const LS_KEY = 'pokechain.auth.v1';

interface Persisted {
  accessToken: string;
  refreshToken: string;
  user: User | null;
}

/** 会话只初始化一次（首次导航或并发调用都复用同一个 Promise） */
let bootstrapping: Promise<void> | null = null;
/** 跨标签页同步只绑一次（P2-3：另一个标签 refresh/登出后本页立即跟上） */
let crossTabBound = false;

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as Persisted;
  } catch {
    /* 忽略损坏的持久化数据 */
  }
  return { accessToken: '', refreshToken: '', user: null };
}

export const useAuthStore = defineStore('auth', {
  state: (): Persisted & { initialized: boolean } => ({ ...loadPersisted(), initialized: false }),
  getters: {
    isLoggedIn: (s) => Boolean(s.accessToken),
    isAdmin: (s) => s.user?.role === 'admin',
    isArbitrator: (s) => s.user?.role === 'arbitrator' || s.user?.role === 'admin',
  },
  actions: {
    /**
     * 恢复会话（路由守卫在首次导航时 await）：
     * - localStorage 无 token：直接标记完成，守卫按未登录处理；
     * - 有 token：调 /users/me 校验并补拉 user（access token 过期时由 http 拦截器
     *   自动 refresh 一次）——刷新页面后导航栏不会停在"已登录但 user 为空"的半初始化态；
     * - 校验失败：清空会话，守卫统一跳登录页（避免停留在 /game 但导航栏消失）。
     */
    async initialize(): Promise<void> {
      if (this.initialized) return;
      this.bindCrossTab();
      if (!bootstrapping) {
        // 注意：.finally 挂在 IIFE 之后注册，保证清空发生在赋值完成之后
        bootstrapping = (async () => {
          try {
            if (this.accessToken) this.setUser(await getMe());
          } catch {
            this.clear();
          } finally {
            this.initialized = true;
          }
        })().finally(() => {
          bootstrapping = null;
        });
      }
      return bootstrapping;
    },
    /**
     * 监听 localStorage 的 auth 记录：另一个标签页登录/refresh/登出时，
     * 本页 store 同步更新，避免用旧 refresh token 再去轮换一次（多标签竞态，P2-3）。
     */
    bindCrossTab(): void {
      if (crossTabBound || typeof window === 'undefined') return;
      crossTabBound = true;
      window.addEventListener('storage', (event) => {
        if (event.key !== LS_KEY) return;
        try {
          const next = event.newValue ? (JSON.parse(event.newValue) as Persisted) : null;
          this.accessToken = next?.accessToken ?? '';
          this.refreshToken = next?.refreshToken ?? '';
          this.user = next?.user ?? null;
        } catch {
          /* 忽略损坏数据 */
        }
      });
    },
    setTokens(accessToken: string, refreshToken: string) {
      this.accessToken = accessToken;
      this.refreshToken = refreshToken;
      this.persist();
    },
    setUser(user: User) {
      this.user = user;
      this.persist();
    },
    /** 领到御三家后翻转新手引导标志（/starter 守卫用）。 */
    setHasStarter(hasStarter: boolean) {
      if (!this.user) return;
      this.user = { ...this.user, hasStarter };
      this.persist();
    },
    setAll(user: User, accessToken: string, refreshToken: string) {
      this.user = user;
      this.accessToken = accessToken;
      this.refreshToken = refreshToken;
      this.persist();
    },
    clear() {
      this.user = null;
      this.accessToken = '';
      this.refreshToken = '';
      localStorage.removeItem(LS_KEY);
    },
    persist() {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({
          accessToken: this.accessToken,
          refreshToken: this.refreshToken,
          user: this.user,
        }),
      );
    },
  },
});
