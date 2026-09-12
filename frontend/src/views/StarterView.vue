<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { claimStarter, getMe, type StarterClaim } from '@/api/auth';
import { useAuthStore } from '@/stores/auth';
import { usePokemonStore } from '@/stores/pokemon';
import { useI18n } from '@/composables/useI18n';
import PixelButton from '@/ui/PixelButton.vue';
import SpriteIcon from '@/ui/SpriteIcon.vue';

/**
 * 新手御三家（speciesId 与 backend/src/game-data/species.data.ts、backend/src/users/starter.service.ts 对齐）：
 * 卡片三选一，领取走 POST /users/me/starter（链上 Commit→Reveal→MintFromCapture + 礼包）。
 */
interface StarterOption {
  speciesId: number;
  nameEn: string;
  nameZh: string;
  typeZh: string;
  typeClass: string;
  abilityZh: string;
  abilityEn: string;
  blurb: string;
}

const STARTERS: StarterOption[] = [
  {
    speciesId: 1,
    nameEn: 'bulbasaur',
    nameZh: '妙蛙种子',
    typeZh: '草',
    typeClass: 'badge--green',
    abilityZh: '茂盛',
    abilityEn: 'overgrow',
    blurb: '体力与特防扎实的耐久型，草系特攻成长稳定，适合稳扎稳打。',
  },
  {
    speciesId: 4,
    nameEn: 'charmander',
    nameZh: '小火龙',
    typeZh: '火',
    typeClass: 'badge--red',
    abilityZh: '猛火',
    abilityEn: 'blaze',
    blurb: '速度最快的进攻型，火系特攻爆发高，先手压制对手。',
  },
  {
    speciesId: 7,
    nameEn: 'squirtle',
    nameZh: '杰尼龟',
    typeZh: '水',
    typeClass: 'badge--blue',
    abilityZh: '激流',
    abilityEn: 'torrent',
    blurb: '防御最高的均衡型，水系招式稳健，挨打能力最强。',
  },
];

const auth = useAuthStore();
const store = usePokemonStore();
const router = useRouter();
const { monName } = useI18n();

const selected = ref(STARTERS[0].speciesId);
const claiming = ref(false);
const error = ref('');
const claimed = ref<StarterClaim | null>(null);

// 已经领过的玩家（hasStarter 从 /users/me 恢复）直接进游戏，避免停在选择页点按钮吃 409
if (auth.user?.hasStarter) void router.replace('/game');

async function confirm() {
  if (claiming.value) return;
  claiming.value = true;
  error.value = '';
  try {
    claimed.value = await claimStarter(selected.value);
    auth.setHasStarter(true);
    // 礼包与积分都已上链：刷新用户（顶栏积分）与本地资产缓存
    try {
      auth.setUser(await getMe());
    } catch {
      /* 后端偶发不可达时保留本地资料，积分在下次会话初始化时补齐 */
    }
    await store.refreshAll().catch(() => undefined);
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? '领取失败（后端未启动？）';
  } finally {
    claiming.value = false;
  }
}

function enterGame() {
  router.push('/game');
}

function itemName(typeId: string) {
  return { 'poke-ball': '精灵球', potion: '伤药' }[typeId] ?? typeId;
}
</script>

<template>
  <div class="page">
    <div class="px-panel" style="max-width: 760px; margin: 0 auto">
      <h1 style="text-align: center">POKECHAIN</h1>
      <h2 style="text-align: center">— 新手礼包 —</h2>

      <template v-if="!claimed">
        <p style="font-size: var(--px-fs-sm); text-align: center">
          欢迎，训练家！注册即得 <strong>1000 积分</strong>，再挑一只御三家，
          外加 <strong>精灵球 ×5 + 伤药 ×2</strong>。御三家只能选一次，个体值/性格/闪光全部来自链上
          承诺-揭示随机数（可在公平性页面复核）。
        </p>

        <div class="starter-grid">
          <button
            v-for="s in STARTERS"
            :key="s.speciesId"
            type="button"
            class="px-panel starter-card"
            :class="{ 'starter-card--on': selected === s.speciesId }"
            :disabled="claiming"
            @click="selected = s.speciesId"
          >
            <SpriteIcon :species-id="s.speciesId" :size="96" style="margin: 0 auto" />
            <div class="starter-card__name">
              No.{{ String(s.speciesId).padStart(3, '0') }} {{ s.nameZh }}
            </div>
            <div style="font-size: var(--px-fs-sm)" class="text-dim">{{ s.nameEn }}</div>
            <span class="badge" :class="s.typeClass">{{ s.typeZh }}</span>
            <p class="starter-card__ability">
              特性：{{ s.abilityZh }}<span class="text-dim">（{{ s.abilityEn }}）</span>
            </p>
            <p class="starter-card__blurb">{{ s.blurb }}</p>
            <div class="starter-card__pick" v-if="selected === s.speciesId">已选择</div>
          </button>
        </div>

        <p v-if="error" class="mb-8" style="color: var(--gba-red); font-size: var(--px-fs-sm); text-align: center">
          {{ error }}
        </p>

        <div class="row" style="justify-content: center; margin-top: 16px">
          <PixelButton variant="primary" :disabled="claiming" @click="confirm">
            {{ claiming ? '签约中…' : '就是你了！领取并开始冒险' }}
          </PixelButton>
        </div>
        <p class="text-dim" style="font-size: var(--px-fs-sm); text-align: center; margin-top: 8px">
          领取会提交链上交易：随机承诺 → 揭示 → 铸造（Lv5）+ 道具入袋；重复领取会被链上拒绝。
        </p>
      </template>

      <template v-else>
        <h2 style="text-align: center; color: var(--gba-green-light)">契约达成！</h2>
        <div class="row" style="justify-content: center; gap: 16px; align-items: center; margin-top: 12px">
          <SpriteIcon :species-id="claimed.pokemon.speciesId" :size="96" />
          <div style="font-size: var(--px-fs-sm)">
            <p>
              <strong>{{ monName(claimed.pokemon.speciesId, claimed.pokemon.name) }}</strong>
              <span v-if="claimed.pokemon.shiny" style="color: var(--gba-yellow)">★ 闪光！</span>
            </p>
            <p>Lv{{ claimed.pokemon.level }}　性格 {{ claimed.pokemon.nature }}　特性 {{ claimed.pokemon.ability }}</p>
            <p class="text-dim" style="font-size: var(--px-fs-sm)">
              技能：{{ claimed.pokemon.moves.join(' / ') }}
            </p>
            <p class="mono text-dim">
              dnaHash: {{ claimed.pokemon.dnaHash.slice(0, 24) }}…
            </p>
          </div>
        </div>

        <div class="px-panel px-panel--dark" style="margin-top: 16px; padding: 8px 12px; font-size: var(--px-fs-sm)">
          <div>礼包已入袋：</div>
          <ul style="margin: 6px 0 0; padding-left: 16px">
            <li v-for="g in claimed.gift" :key="g.typeId">
              {{ itemName(g.typeId) }} ×{{ g.quantity }}
            </li>
          </ul>
          <p class="text-dim" style="font-size: var(--px-fs-sm); margin-top: 6px">
            捕捉 / 击倒野怪 / 放生宝可梦都会获得积分奖励，详见「积分经济」。
          </p>
        </div>

        <div class="row" style="justify-content: center; margin-top: 16px">
          <PixelButton variant="primary" @click="enterGame">进入游戏</PixelButton>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.starter-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-top: 16px;
}

.starter-card {
  padding: 10px 8px;
  cursor: pointer;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
}

.starter-card--on {
  outline: 3px solid var(--gba-yellow);
  background: #fff6cf;
}

.starter-card__name {
  font-size: var(--px-fs-sm);
  margin-top: 6px;
}

.starter-card__ability {
  margin: 4px 0 0;
  font-size: var(--px-fs-sm);
}

.starter-card__blurb {
  margin: 2px 0 0;
  font-size: var(--px-fs-sm);
  line-height: var(--px-lh-body);
  text-align: left;
}

.starter-card__pick {
  margin-top: 4px;
  font-size: var(--px-fs-sm);
  color: var(--gba-green-light);
}
</style>
