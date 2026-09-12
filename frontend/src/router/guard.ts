import type { NavigationGuardReturn, RouteLocationNormalized } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import type { User } from '@/types';

/**
 * 新手引导：已登录的普通玩家还没领御三家（`GET /users/me` 的 hasStarter === false）时，
 * 先跳 /starter 再进游戏。`undefined`（尚未拉到 /users/me）不触发，避免误跳；admin/仲裁不参与。
 */
export function needsStarter(user: User | null | undefined): boolean {
  return user?.role === 'player' && user.hasStarter === false;
}

/**
 * 导航守卫：先等会话初始化完成（校验 localStorage 里的 token 并补拉 user，
 * 见 stores/auth.initialize），再按 meta 放行。
 *
 * 这样首屏不会出现"只看 token 存在就放行 /game、随后 /users/me 失败导致
 * user 为 null、导航栏消失且不跳转"的半初始化态：初始化失败时 store 已清空
 * 会话，受保护路由统一落到登录页。
 */
export async function authGuard(to: RouteLocationNormalized): Promise<NavigationGuardReturn> {
  const auth = useAuthStore();
  await auth.initialize();
  if (to.meta.requiresAuth && !auth.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.meta.guestOnly && auth.isLoggedIn) {
    return { name: 'game' };
  }
  if (to.meta.requiresAdmin && !(auth.isAdmin || auth.isArbitrator)) {
    return { name: 'game' };
  }
  if (to.meta.requiresAuth && to.name !== 'starter' && needsStarter(auth.user)) {
    return { name: 'starter' };
  }
  return true;
}
