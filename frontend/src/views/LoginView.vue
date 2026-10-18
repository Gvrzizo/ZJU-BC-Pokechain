<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getMe, login } from '@/api/auth';
import { useAuthStore } from '@/stores/auth';
import PixelButton from '@/ui/PixelButton.vue';

const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

async function onSubmit() {
  error.value = '';
  loading.value = true;
  try {
    const res = await login({ username: username.value, password: password.value });
    auth.setAll(res.user, res.accessToken, res.refreshToken);
    // 登录响应只有 PG 资料：补拉 /users/me 合并链上积分/战绩与 hasStarter（顶栏积分与新手引导都依赖它）
    try {
      auth.setUser(await getMe());
    } catch {
      /* 后端偶发不可达时先按本地资料进入，下次会话初始化会补齐 */
    }
    router.push((route.query.redirect as string) || '/game');
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? '登录失败（后端未启动？）';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="page auth-page">
    <section class="auth-intro">
      <img class="auth-art" src="/assets/ui/hoenn-postcard.svg" alt="草木环绕的未白镇，红顶房屋前的小路通向远方" />
      <span class="eyebrow">POKECHAIN · HOENN ADVENTURE</span>
      <h1>从未白镇出发。</h1>
      <p>走进草丛，遇见伙伴。<br />把每一次相遇，写进你的冒险。</p>
    </section>
    <form class="px-panel auth-form" @submit.prevent="onSubmit">
      <div class="text-dim mb-8">TRAINER CARD</div>
      <h2>继续你的旅程</h2>
      <div class="px-field">
        <label>用户名</label>
        <input v-model="username" class="px-input" required autocomplete="username" />
      </div>
      <div class="px-field">
        <label>密码</label>
        <input
          v-model="password"
          class="px-input"
          type="password"
          required
          autocomplete="current-password"
        />
      </div>
      <p v-if="error" class="mb-8" style="color: var(--gba-red); font-size: var(--px-fs-sm)">{{ error }}</p>
      <PixelButton variant="primary" type="submit" :disabled="loading" style="width: 100%">
        {{ loading ? '...' : '登录' }}
      </PixelButton>
      <p class="mt-16" style="font-size: var(--px-fs-sm); text-align: center">
        新账号注册后可选一只御三家（新手礼包：精灵球×5 + 伤药×2）。
      </p>
      <p class="mt-16" style="font-size: var(--px-fs-sm); text-align: center">
        没有账号？<router-link to="/register">注册</router-link>
      </p>
    </form>
  </div>
</template>
