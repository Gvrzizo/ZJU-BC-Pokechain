<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { logout } from '@/api/auth';
import { useI18n } from '@/composables/useI18n';

const auth = useAuthStore();
const router = useRouter();
const { t, otherLocaleLabel, toggleLocale } = useI18n();

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
    <nav v-if="showNav" class="topnav">
      <strong style="color: var(--gba-yellow); font-size: var(--px-fs-lg)">{{
        t('app.title')
      }}</strong>
      <router-link to="/game">{{ t('nav.game') }}</router-link>
      <router-link to="/bag">{{ t('nav.bag') }}</router-link>
      <router-link to="/shop">{{ t('nav.shop') }}</router-link>
      <router-link to="/pokedex">{{ t('nav.pokedex') }}</router-link>
      <router-link to="/team">{{ t('nav.team') }}</router-link>
      <router-link to="/trade">{{ t('nav.trade') }}</router-link>
      <router-link to="/lobby">{{ t('nav.lobby') }}</router-link>
      <router-link to="/ranked">{{ t('nav.ranked') }}</router-link>
      <router-link to="/fairness">{{ t('nav.fairness') }}</router-link>
      <router-link v-if="auth.isAdmin || auth.isArbitrator" to="/admin">{{ t('nav.admin') }}</router-link>
      <span class="spacer" />
      <span style="color: var(--gba-cream); font-size: var(--px-fs-sm)">
        {{ auth.user?.nickname ?? auth.user?.username }}
        <template v-if="auth.user?.points !== undefined">| {{ auth.user.points }}P</template>
      </span>
      <button
        class="px-btn lang-toggle"
        type="button"
        :title="t('app.switchLang')"
        :aria-label="t('app.switchLang')"
        @click="toggleLocale()"
      >
        {{ otherLocaleLabel() }}
      </button>
      <a href="#" @click.prevent="onLogout">{{ t('nav.logout') }}</a>
    </nav>
    <router-view />
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
