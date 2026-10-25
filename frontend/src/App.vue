<script setup lang="ts">
import { computed, KeepAlive } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { logout } from '@/api/auth';
import PixelIcon from '@/ui/PixelIcon.vue';
import { useI18n } from '@/composables/useI18n';

const auth = useAuthStore();
const router = useRouter();
const { t, otherLocaleLabel, toggleLocale } = useI18n();

const navItems = ['game', 'bag', 'shop', 'pokedex', 'team', 'trade', 'lobby', 'ranked', 'fairness'] as const;

const showNav = computed(() => auth.initialized && auth.isLoggedIn);

async function onLogout() {
  try {
    if (auth.refreshToken) await logout(auth.refreshToken);
  } catch {
    /* 后端不可达也照常本地登出 */
  }
  auth.clear();
  router.push('/login');
}
</script>

<template>
  <!-- 启动态：首次导航等待会话初始化（token 校验 + user 补拉），避免闪现半初始化页面 -->
  <div v-if="!auth.initialized" class="boot-screen">
    <p class="px-panel" style="font-size: var(--px-fs-lg); letter-spacing: 2px">
      POKECHAIN — NOW LOADING…
    </p>
  </div>
  <template v-else>
    <header v-if="showNav" class="app-header">
      <div class="trainer-bar">
        <router-link to="/game" class="app-brand" aria-label="PokeChain">
          <span class="brand-ball"><PixelIcon name="ball" :size="32" /></span>
          <span>{{ t('app.title') }}<small>TRAINER'S ADVENTURE</small></span>
        </router-link>
        <div class="trainer-profile">
          <span class="trainer-name">{{ auth.user?.nickname ?? auth.user?.username }}</span>
          <span v-if="auth.user?.points !== undefined" class="trainer-points">{{ auth.user.points }}<small>P</small></span>
          <button class="px-btn lang-toggle" type="button" :title="t('app.switchLang')" :aria-label="t('app.switchLang')" @click="toggleLocale()">
            {{ otherLocaleLabel() }}
          </button>
          <button class="header-logout" type="button" @click="onLogout">{{ t('nav.logout') }}</button>
        </div>
      </div>
      <nav class="topnav" aria-label="游戏导航">
        <router-link v-for="item in navItems" :key="item" :to="`/${item}`">
          <PixelIcon :name="item" /><span>{{ t(`nav.${item}`) }}</span>
        </router-link>
        <router-link v-if="auth.isAdmin || auth.isArbitrator" to="/admin"><PixelIcon name="admin" /><span>{{ t('nav.admin') }}</span></router-link>
      </nav>
    </header>
    <router-view v-slot="{ Component }">
      <!-- 游戏页保活：切走时 Phaser sleep（不重跑 BootScene），切回来直接 resume；
           超过 20 分钟未回由 GameView 自己失效重建（见 views/GameView.vue）。
           KeepAlive 以 username 为 key（P2-3）：登出/换账号会销毁缓存，避免把上一个玩家的
           Phaser 场景与游戏状态带给下一个玩家。 -->
      <KeepAlive :include="['GameView']" :key="auth.user?.username ?? 'guest'">
        <component :is="Component" />
      </KeepAlive>
    </router-view>
  </template>
</template>

<style scoped>
.boot-screen {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
}

.lang-toggle {
  font-size: var(--px-fs-sm);
  padding: 4px 8px;
}
</style>
