import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { authGuard } from './guard';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/game' },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { guestOnly: true },
  },
  {
    path: '/register',
    name: 'register',
    component: () => import('@/views/RegisterView.vue'),
    meta: { guestOnly: true },
  },
  {
    path: '/starter',
    name: 'starter',
    component: () => import('@/views/StarterView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/game',
    name: 'game',
    component: () => import('@/views/GameView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/bag',
    name: 'bag',
    component: () => import('@/views/BagView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/shop',
    name: 'shop',
    component: () => import('@/views/ShopView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/pokedex',
    name: 'pokedex',
    component: () => import('@/views/PokedexView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/team',
    name: 'team',
    component: () => import('@/views/TeamView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/trade',
    name: 'trade',
    component: () => import('@/views/TradeView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/lobby',
    name: 'lobby',
    component: () => import('@/views/LobbyView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/ranked',
    name: 'ranked',
    component: () => import('@/views/RankedView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/battle/:id',
    name: 'battle',
    component: () => import('@/views/BattleView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/fairness',
    name: 'fairness',
    component: () => import('@/views/FairnessView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/admin',
    name: 'admin',
    component: () => import('@/views/AdminView.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(authGuard);
