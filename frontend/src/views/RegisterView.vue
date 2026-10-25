<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { getMe, register } from '@/api/auth';
import { useAuthStore } from '@/stores/auth';
import PixelButton from '@/ui/PixelButton.vue';

const username = ref('');
const nickname = ref('');
const password = ref('');
const password2 = ref('');
const error = ref('');
const loading = ref(false);
const auth = useAuthStore();
const router = useRouter();

async function onSubmit() {
  error.value = '';
  if (password.value !== password2.value) {
    error.value = '两次密码不一致';
    return;
  }
  loading.value = true;
  try {
    const res = await register({
      username: username.value,
      password: password.value,
      nickname: nickname.value || username.value,
    });
    auth.setAll(res.user, res.accessToken, res.refreshToken);
    // 注册响应只有 PG 资料：补拉 /users/me 拿到链上积分与 hasStarter，再走新手引导
    let hasStarter = false;
    try {
      const me = await getMe();
      auth.setUser(me);
      hasStarter = me.hasStarter === true;
    } catch {
      /* 后端偶发不可达时按未领取处理，/starter 页会再拉一次 */
    }
    router.push(hasStarter ? '/game' : '/starter');
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? '注册失败（后端未启动？）';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="page auth-page">
    <section class="auth-intro">
      <img class="auth-art" src="/assets/generated/ui/hoenn-welcome.png" alt="丰缘风格的像素山海与村庄，木守宫在小路上望向红顶宝可梦中心" />
      <span class="eyebrow">POKECHAIN · HOENN ADVENTURE</span>
      <h1>从未白镇出发。</h1>
      <p>走进草丛，遇见伙伴。<br />把每一次相遇，写进你的冒险。</p>
    </section>
    <form class="px-panel auth-form" @submit.prevent="onSubmit">
      <div class="text-dim mb-8">TRAINER CARD</div>
      <h2>领取训练家证</h2>
      <div class="px-field">
        <label>用户名（将作为链上 playerId）</label>
        <input v-model="username" class="px-input" required autocomplete="username" />
      </div>
      <div class="px-field">
        <label>昵称</label>
        <input v-model="nickname" class="px-input" />
      </div>
      <div class="px-field">
        <label>密码</label>
        <input
          v-model="password"
          class="px-input"
          type="password"
          required
          autocomplete="new-password"
        />
      </div>
      <div class="px-field">
        <label>确认密码</label>
        <input v-model="password2" class="px-input" type="password" required />
      </div>
      <p v-if="error" class="mb-8" style="color: var(--gba-red); font-size: var(--px-fs-sm)">{{ error }}</p>
      <PixelButton variant="primary" type="submit" :disabled="loading" style="width: 100%">
        {{ loading ? '...' : '注册并进入' }}
      </PixelButton>
      <p class="mt-16" style="font-size: var(--px-fs-sm); text-align: center">
        注册即送 400 积分 + 新手礼包：御三家三选一，附赠精灵球×5、伤药×2。
      </p>
      <p class="mt-16" style="font-size: var(--px-fs-sm); text-align: center">
        已有账号？<router-link to="/login">登录</router-link>
      </p>
    </form>
  </div>
</template>
