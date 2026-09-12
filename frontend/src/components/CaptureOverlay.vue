<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { LURE_TIERS, attemptCapture, encounter } from '@/api/capture';
import type { CaptureAttemptResult, WildEncounterResult } from '@/api/capture';
import { startWild, wildAction } from '@/api/wild';
import type { WildActionEx, WildPartyMember, WildStateEx } from '@/api/wild';
import { currentHpOf, isFainted } from '@/utils/pokemon-hp';
import { playCry } from '@/game/cries';
import {
  ballInfo,
  chanceColor,
  formatChance,
  moveDetailText,
  quickCaptureChance,
  statusLabel,
  wildLogText,
  wildResultText,
} from '@/game/wild-battle';
import { useI18n } from '@/composables/useI18n';
import { usePokemonStore } from '@/stores/pokemon';
import { useZoneStore } from '@/stores/zone';
import type { WildBallOption } from '@/types';
import BondHearts from '@/ui/BondHearts.vue';
import HpBar from '@/ui/HpBar.vue';
import PixelButton from '@/ui/PixelButton.vue';
import SpriteIcon from '@/ui/SpriteIcon.vue';

const emit = defineEmits<{ (e: 'done'): void }>();
const store = usePokemonStore();
const zoneStore = useZoneStore();
const { t, monName, moveName, itemName } = useI18n();

/** prep = 诱饵/首发选择；battle = 野怪战斗主流程；quick = 没有可出战宝可梦时的降级路径（直接投球） */
type Phase = 'prep' | 'loading' | 'battle' | 'quick' | 'error';
const phase = ref<Phase>('prep');
const state = ref<WildStateEx | null>(null);
const enc = ref<WildEncounterResult | null>(null);
const error = ref('');
const busy = ref(false);
/** 已见过的球名（球消耗后不再出现在背包列表里，日志仍要能显示名称） */
const ballNames = ref<Record<string, string>>({});
/** 已见过的技能名/队伍名（换宠后旧技能不在当前技能表里，日志仍要能显示） */
const seenMoveNames = ref<Record<string, string>>({});
const partyNames = ref<Record<string, string>>({});
const logBox = ref<HTMLElement | null>(null);
const clientSeed = crypto.randomUUID().replace(/-/g, '');

// 准备阶段：付费诱饵 + 首发选择
const lureTier = ref<0 | 1 | 2>(0);
const starterId = ref('');

// 战斗阶段：换宠面板与技能悬停说明
const showParty = ref(false);
const hoveredMove = ref('');

// 降级路径（快速捕捉）状态
const quickResult = ref<CaptureAttemptResult | null>(null);
const quickBallId = ref('');

const finished = computed(() => state.value?.finished ?? false);
const resultText = computed(() => (state.value ? wildResultText(state.value.status) : ''));
const canAct = computed(() => !busy.value && !finished.value && phase.value === 'battle');
const mustSwitch = computed(() => state.value?.mustSwitch ?? false);
const canCommand = computed(() => canAct.value && !mustSwitch.value);
const canThrow = computed(() => !busy.value && !quickResult.value && phase.value === 'quick');

/** 可出战队伍（本地链上缓存；等级降序，与后端队伍规则一致——含当前 HP 与濒死标记） */
const party = computed<WildPartyMember[]>(() =>
  store.myPokemon
    .filter((p) => p.status === 'IDLE')
    .slice()
    .sort((a, b) => b.level - a.level || a.id.localeCompare(b.id))
    .map((p) => {
      const hp = currentHpOf(p);
      return {
        pokemonId: p.id,
        speciesId: p.speciesId,
        name: p.name,
        nameZh: monName(p.speciesId, p.name),
        type: '',
        level: p.level,
        shiny: p.shiny,
        hp,
        maxHp: p.stats?.hp ?? 0,
        exp: p.exp,
        status: null,
        fainted: isFainted(p),
        active: p.id === starterId.value,
      };
    }),
);

/** 可出战的（非濒死）成员：首发只能从这里选（伤势持久化，docs/backend-api.md §2） */
const healthyParty = computed(() => party.value.filter((m) => !m.fainted));
/** 有队伍但全员濒死：不能进入草丛，先去宝可梦中心 */
const allFainted = computed(() => party.value.length > 0 && healthyParty.value.length === 0);

/** 当前所在区域（OverworldScene 按地图 y 带写入）：决定野怪等级带与野生池 */
const zone = computed(() => zoneStore.zone);

const selectedLure = computed(() => LURE_TIERS.find((l) => l.tier === lureTier.value) ?? LURE_TIERS[0]);
/** 诱饵只在区域带内加成并封顶区域上界（docs/backend-api.md §2「区域等级带」） */
const expectedLevels = computed(() => {
  const bonus = selectedLure.value.levelBonus;
  return {
    min: Math.min(zone.value.maxLevel, zone.value.minLevel + bonus),
    max: zone.value.maxLevel,
  };
});

/** 降级路径的球列表：背包里的球 + 满血投球的成功率（后端 encounter 给出官方捕获率） */
const quickBalls = computed(() =>
  store.balls.map((item) => {
    const info = ballInfo(item.typeId);
    return {
      item,
      nameZh: info.nameZh,
      chance: quickCaptureChance(enc.value?.wild.catchRate ?? 0, info.bonus),
    };
  }),
);

const logLines = computed(() => {
  const s = state.value;
  if (!s) return [] as string[];
  return s.log
    .flatMap((turn) =>
      turn.events.map((e) =>
        wildLogText(e, {
          mineName: s.mine.nameZh || s.mine.name,
          wildName: s.wild.nameZh || s.wild.name,
          moveNames: seenMoveNames.value,
          ballNames: ballNames.value,
          partyNames: partyNames.value,
        }),
      ),
    )
    .filter((line) => line.length > 0);
});

/** 技能悬停/聚焦说明（威力/命中/属性/效果） */
const moveDetail = (moveId: string) => {
  const move = state.value?.mine.moves.find((m) => m.id === moveId);
  if (!move) return moveName(moveId);
  return moveDetailText(moveName(move.id, move.name), move);
};
const shownMoveDetail = computed(() => (hoveredMove.value ? moveDetail(hoveredMove.value) : ''));

function applyState(next: WildStateEx) {
  state.value = next;
  for (const ball of next.captureChances) ballNames.value[ball.typeId] = ball.nameZh;
  for (const move of next.mine.moves) seenMoveNames.value[move.id] = moveName(move.id, move.name);
  for (const member of next.party ?? []) {
    partyNames.value[member.pokemonId] = member.nameZh || member.name;
    seenMoveNames.value[member.pokemonId] = member.nameZh || member.name;
  }
  void nextTick(() => {
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
  });
}

// 出战宝可梦倒下且还有可换成员时，自动弹出队伍面板
watch(mustSwitch, (value) => {
  if (value) {
    showParty.value = true;
    hoveredMove.value = '';
  }
});

async function start() {
  phase.value = 'loading';
  error.value = '';
  quickResult.value = null;
  try {
    // 已经付过诱饵的遇敌会保留：重试不再重复扣费
    if (!enc.value) {
      enc.value = await encounter(clientSeed, lureTier.value, zone.value.id);
      playCry(enc.value.wild.speciesId);
    }
    const found = enc.value;
    try {
      applyState(await startWild(found.eventId, starterId.value || undefined));
      phase.value = 'battle';
    } catch (e: any) {
      // 没有可出战的宝可梦（新账号）：降级为直接投球的快速捕捉，避免死路
      if (e?.response?.data?.code === 'NO_TEAM_POKEMON') {
        await store.refreshItems();
        phase.value = 'quick';
        return;
      }
      throw e;
    }
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? '遇敌失败';
    // 本地缓存的队伍已过期（宝可梦被交易/锁定）：清掉选择、刷新列表，回到准备界面
    if (e?.response?.data?.code === 'INVALID_PARTY_POKEMON') {
      starterId.value = '';
      enc.value = null;
      void store.refreshPokemon();
      phase.value = 'prep';
      return;
    }
    phase.value = 'error';
  }
}

/** 放弃当前遇敌（下一次「进入草丛」会重新扣费创建新事件） */
function restart() {
  enc.value = null;
  error.value = '';
  phase.value = 'prep';
}

async function act(action: WildActionEx) {
  if (!canAct.value || !state.value) return;
  busy.value = true;
  error.value = '';
  try {
    const next = await wildAction(state.value.sessionId, action);
    applyState(next);
    if (next.status === 'CAUGHT' && next.captured) {
      playCry(next.captured.speciesId);
      await Promise.all([store.refreshPokemon(), store.refreshItems()]);
    } else if (next.drop) {
      // 击倒结算掉落了道具：刷新背包，结算面板的"获得了 …"与新堆叠保持一致
      void store.refreshItems();
    } else if (action.type === 'ball') {
      void store.refreshItems();
    }
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? '操作失败';
  } finally {
    busy.value = false;
  }
}

const useMove = (moveId: string) => act({ type: 'move', moveId });
const throwBall = (ball: WildBallOption) => act({ type: 'ball', ballItemId: ball.itemId });
const runAway = () => act({ type: 'run' });
const switchTo = (pokemonId: string) => {
  showParty.value = false;
  hoveredMove.value = '';
  return act({ type: 'switch', targetPokemonId: pokemonId });
};

/** 降级路径：直接投球（POST /capture/attempt，等价满血投球） */
async function throwQuick(ballItemId: string) {
  if (!canThrow.value || !enc.value) return;
  quickBallId.value = ballItemId;
  busy.value = true;
  error.value = '';
  try {
    quickResult.value = await attemptCapture(enc.value.eventId, ballItemId);
    if (quickResult.value.success) {
      playCry(enc.value.wild.speciesId);
      await store.refreshPokemon();
    }
    await store.refreshItems();
  } catch (e: any) {
    error.value = e?.response?.data?.message ?? '投掷失败';
  } finally {
    busy.value = false;
  }
}

function close() {
  emit('done');
}

// 准备阶段需要队伍列表与当前 HP（跨战斗保留）：每次打开都拉一次
void store.refreshPokemon();
if (store.items.length === 0) {
  void store.refreshItems();
}
</script>

<template>
  <div class="capture-overlay">
    <div class="px-panel wild-panel">
      <template v-if="phase === 'prep' || phase === 'loading'">
        <h2 style="text-align: center">草丛中的动静…</h2>
        <p class="wild-zone">
          {{ zone.name }}
          <span class="text-dim">
            野怪 Lv{{ zone.minLevel }}–{{ zone.maxLevel }} ·
            {{ zone.maxStage === 0 ? '只出未进化型' : zone.maxStage === 1 ? '可见一段进化型' : '可见二段进化型' }}
          </span>
        </p>

        <div class="wild-group" style="margin-top: 12px">
          <div class="wild-group__title">
            诱饵 <span class="text-dim">（付费档位：带内等级加成 / 更高闪光率；费用在确认遇敌时链上扣除）</span>
          </div>
          <div class="wild-grid">
            <PixelButton
              v-for="lure in LURE_TIERS"
              :key="lure.tier"
              :variant="lureTier === lure.tier ? 'primary' : undefined"
              :disabled="phase === 'loading'"
              @click="lureTier = lure.tier"
            >
              {{ lure.nameZh }}
              <span class="text-dim">
                {{ lure.cost > 0 ? `${lure.cost} 积分` : '免费' }}
              </span>
              <span v-if="lure.levelBonus > 0 || lure.shinyMultiplier > 1" class="text-dim">
                {{ lure.levelBonus > 0 ? `等级 +${lure.levelBonus}` : '' }}
                {{ lure.shinyMultiplier > 1 ? `闪光 ×${lure.shinyMultiplier}` : '' }}
              </span>
            </PixelButton>
          </div>
          <p class="wild-hint">
            预计野怪等级：Lv{{ expectedLevels.min }} ~ Lv{{ expectedLevels.max }}（{{ zone.name }} 的等级带
            Lv{{ zone.minLevel }}–{{ zone.maxLevel }}，诱饵只在带内加成且不超过 Lv{{ zone.maxLevel }}；
            野怪等级与队伍等级无关）。付费档位会写入链上随机承诺的 meta，可在公平性页面复核。
          </p>
        </div>

        <div class="wild-group">
          <div class="wild-group__title">
            首发宝可梦 <span class="text-dim">（默认推荐：等级最高者；HP 跨战斗保留，濒死者不能出战）</span>
          </div>
          <div v-if="party.length > 0" class="wild-grid">
            <PixelButton
              v-for="member in party"
              :key="member.pokemonId"
              :variant="(starterId || healthyParty[0]?.pokemonId) === member.pokemonId ? 'primary' : undefined"
              :disabled="phase === 'loading' || member.fainted"
              @click="starterId = member.pokemonId"
            >
              {{ member.nameZh }}
              <span class="text-dim">
                Lv{{ member.level }} {{ member.hp }}/{{ member.maxHp }}
                <template v-if="member.fainted">（濒死）</template>
              </span>
            </PixelButton>
          </div>
          <p v-if="allFainted" class="wild-error">
            全队濒死：先去队伍页面的「宝可梦中心」治疗（每次 10P）或用伤药，才能再进入草丛。
          </p>
          <p v-else-if="party.length === 0" class="wild-hint">
            还没有可出战的宝可梦：本次只能直接投球（快速捕捉）。先领取/捕捉一只即可进入野怪战斗。
          </p>
        </div>

        <div class="wild-footer">
          <PixelButton
            variant="primary"
            :disabled="phase === 'loading' || busy || allFainted"
            @click="start"
          >
            {{ phase === 'loading' ? '遭遇中…' : '进入草丛' }}
          </PixelButton>
          <PixelButton :disabled="phase === 'loading'" @click="close">返回</PixelButton>
          <span v-if="phase === 'loading'" class="blink text-dim">遭遇中…</span>
        </div>
      </template>

      <template v-else-if="phase === 'error'">
        <h2 style="color: var(--gba-red); text-align: center">出错了</h2>
        <p style="font-size: var(--px-fs-sm); text-align: center">{{ error }}</p>
        <p class="wild-hint" style="text-align: center">
          重试会复用本次遇敌（不重复扣诱饵费）；重新遇敌会按当前档位再扣一次费。
        </p>
        <div class="row" style="justify-content: center; margin-top: 16px">
          <PixelButton variant="primary" :disabled="!enc" @click="start">重试</PixelButton>
          <PixelButton @click="restart">重新遇敌</PixelButton>
          <PixelButton @click="close">返回</PixelButton>
        </div>
      </template>

      <template v-else-if="phase === 'quick' && enc">
        <h2 style="text-align: center">
          野生的{{ monName(enc.wild.speciesId, enc.wild.nameZh || enc.wild.name) }}出现了！
        </h2>
        <div class="row" style="justify-content: center; margin: 12px 0">
          <SpriteIcon :species-id="enc.wild.speciesId" :size="96" />
        </div>
        <p style="font-size: var(--px-fs-sm); text-align: center">
          {{ enc.zone.name }} · Lv{{ enc.wild.level }} · 官方捕获率 {{ enc.wild.catchRate ?? '?' }}/255
          <span v-if="enc.lure.tier > 0" class="text-dim">（诱饵：{{ enc.lure.tier }} 档）</span>
        </p>
        <p class="wild-hint" style="text-align: center">
          你还没有可出战的宝可梦，无法进行野怪战斗，只能直接投球（快速捕捉，按满血判定）。
          先领取或捕捉一只宝可梦，之后遇敌即可进入野怪战斗。
        </p>

        <div class="wild-group" style="margin-top: 10px">
          <div class="wild-group__title">精灵球 <span class="text-dim">（百分比 = 当前捕捉成功率）</span></div>
          <div class="wild-grid">
            <PixelButton
              v-for="b in quickBalls"
              :key="b.item.id"
              :disabled="!canThrow || b.item.quantity <= 0"
              @click="throwQuick(b.item.id)"
            >
              {{ b.nameZh }} ×{{ b.item.quantity }}
              <span class="wild-chance" :style="{ color: chanceColor(b.chance) }">
                {{ formatChance(b.chance) }}
              </span>
            </PixelButton>
          </div>
          <p v-if="quickBalls.length === 0" class="wild-empty">背包里没有精灵球！</p>
        </div>

        <div v-if="quickResult" class="wild-result">
          <h2 v-if="quickResult.success" style="color: var(--gba-green-light)">捕捉成功！</h2>
          <template v-else>
            <h2 style="color: var(--gba-red)">捕捉失败…</h2>
            <p style="font-size: var(--px-fs-sm)">球摇了 {{ quickResult.shakes }} 次后弹开了！</p>
            <p class="wild-hint">可以继续投球（每次消耗一个球）。</p>
          </template>
          <p v-if="quickResult.success && quickResult.catchReward" class="wild-reward">
            +{{ quickResult.catchReward }}P 收服奖励已到账
          </p>
          <div style="margin-top: 12px">
            <PixelButton variant="primary" @click="close">继续探索</PixelButton>
          </div>
        </div>

        <div v-else class="wild-footer">
          <PixelButton variant="danger" :disabled="busy" @click="close">逃跑</PixelButton>
          <span v-if="busy" class="blink text-dim">投掷中…</span>
          <span v-else-if="error" class="wild-error">{{ error }}</span>
        </div>
      </template>

      <template v-else-if="state">
        <!-- 对战舞台 -->
        <div class="wild-field">
          <div class="wild-foe">
            <div class="wild-info">
              <div class="wild-name">
                野生的{{ monName(state.wild.speciesId, state.wild.nameZh || state.wild.name) }}
                <span v-if="state.wild.shiny" style="color: var(--gba-yellow)">★</span>
                <span class="text-dim">Lv{{ state.wild.level }}</span>
              </div>
              <HpBar :hp="state.wild.hp" :max-hp="state.wild.maxHp" show-text />
              <div v-if="statusLabel(state.wild.status)" class="wild-badge">
                {{ statusLabel(state.wild.status) }}
              </div>
            </div>
            <SpriteIcon :species-id="state.wild.speciesId" :size="96" />
          </div>

          <div class="wild-mine">
            <SpriteIcon :species-id="state.mine.speciesId" :size="96" />
            <div class="wild-info">
              <div class="wild-name">
                {{ monName(state.mine.speciesId, state.mine.nameZh || state.mine.name) }}
                <span v-if="state.mine.shiny" style="color: var(--gba-yellow)">★</span>
                <span class="text-dim">Lv{{ state.mine.level }}</span>
              </div>
              <HpBar :hp="state.mine.hp" :max-hp="state.mine.maxHp" show-text />
              <div v-if="statusLabel(state.mine.status)" class="wild-badge">
                {{ statusLabel(state.mine.status) }}
              </div>
            </div>
          </div>

          <div class="wild-turn">回合 {{ state.turn }}</div>
        </div>

        <!-- 战斗日志 -->
        <div ref="logBox" class="wild-log">
          <p v-for="(line, i) in logLines" :key="i" class="wild-log__line">{{ line }}</p>
        </div>
        <p v-if="error" class="wild-error">{{ error }}</p>

        <!-- 队伍面板（换宠 / 濒死强制换宠） -->
        <div v-if="showParty && !finished" class="wild-party">
          <div class="wild-group__title">
            {{ mustSwitch ? '出战宝可梦倒下了！派谁上场？' : '换宠（消耗本回合，野怪会出招一次）' }}
          </div>
          <div class="wild-grid">
            <PixelButton
              v-for="member in state.party"
              :key="member.pokemonId"
              :variant="member.active ? 'primary' : undefined"
              :disabled="busy || member.active || member.fainted"
              @click="switchTo(member.pokemonId)"
            >
              {{ member.nameZh || member.name }}
              <span class="text-dim">
                Lv{{ member.level }} {{ member.hp }}/{{ member.maxHp }}
                <template v-if="member.fainted">（濒死）</template>
                <template v-else-if="member.active">（出战中）</template>
              </span>
            </PixelButton>
          </div>
          <div style="margin-top: 6px">
            <PixelButton :disabled="busy || mustSwitch" @click="showParty = false">返回</PixelButton>
          </div>
        </div>

        <!-- 指令区 -->
        <div v-else-if="!finished" class="wild-actions">
          <div class="wild-group">
            <div class="wild-group__title">技能</div>
            <div class="wild-grid">
              <PixelButton
                v-for="m in state.mine.moves"
                :key="m.id"
                :disabled="!canCommand"
                :title="moveDetail(m.id)"
                @mouseenter="hoveredMove = m.id"
                @focus="hoveredMove = m.id"
                @click="useMove(m.id)"
              >
                {{ moveName(m.id, m.name) }}
                <span class="text-dim">威力{{ m.power }}/命中{{ m.accuracy }}</span>
              </PixelButton>
            </div>
            <p class="wild-hint">
              {{ shownMoveDetail || '悬停技能可查看 威力 / 命中 / 属性 / 效果' }}
            </p>
          </div>

          <div class="wild-group">
            <div class="wild-group__title">
              精灵球 <span class="text-dim">（百分比 = 当前捕捉成功率）</span>
            </div>
            <div class="wild-grid">
              <PixelButton
                v-for="b in state.captureChances"
                :key="b.itemId"
                :disabled="!canCommand || b.quantity <= 0"
                @click="throwBall(b)"
              >
                {{ b.nameZh }} ×{{ b.quantity }}
                <span class="wild-chance" :style="{ color: chanceColor(b.chance) }">
                  {{ formatChance(b.chance) }}
                </span>
              </PixelButton>
            </div>
            <p v-if="state.captureChances.length === 0" class="wild-empty">
              背包里没有精灵球！先去道具店/管理员处领取。
            </p>
            <p class="wild-hint">
              野怪 HP 越低捕捉率越高；大师球必中。每次投球消耗一个球，失败后野怪会反击。
            </p>
          </div>

          <div class="wild-footer">
            <PixelButton :disabled="!canCommand" @click="showParty = true">换宠</PixelButton>
            <PixelButton variant="danger" :disabled="!canCommand" @click="runAway">逃跑</PixelButton>
            <span v-if="busy" class="blink text-dim">行动中…</span>
          </div>
        </div>

        <!-- 结算 -->
        <div v-else class="wild-result">
          <h2 :style="{ color: state.status === 'CAUGHT' ? 'var(--gba-green-light)' : 'var(--gba-red)' }">
            {{ resultText }}
          </h2>

          <template v-if="state.status === 'CAUGHT' && state.captured">
            <div class="wild-caught">
              <SpriteIcon :species-id="state.captured.speciesId" :size="96" />
              <div>
                <p style="font-size: var(--px-fs-sm)">
                  {{ state.captured.name }}（Lv{{ state.captured.level }}）已加入队伍，数据已上链铸造。
                </p>
                <p v-if="state.captured.shiny" style="color: var(--gba-yellow)">★ 闪光！</p>
                <p v-if="state.catchReward" class="wild-reward">+{{ state.catchReward }}P 收服奖励</p>
                <p v-if="state.expGained" class="wild-reward">
                  {{ partyNames[state.expGainedBy ?? ''] || state.mine.nameZh || state.mine.name }} 获得
                  {{ state.expGained }} 点经验
                  <template v-if="state.levelsGained"> → Lv{{ state.mine.level }}</template>
                </p>
                <p v-if="(state.movesLearned ?? []).length" class="wild-reward">
                  学会了 {{ state.movesLearned!.map((m) => moveName(m)).join(' / ') }}！
                </p>
                <p v-if="state.canEvolve" class="wild-reward">可以进化了！去队伍页面查看进化条件</p>
                <p v-if="state.bondGain" class="wild-reward">
                  {{ t('team.bond') }} +{{ state.bondGain }} ♥
                  <BondHearts :bond="state.mine.bond ?? 0" :delta="state.bondGain" size="sm" />
                </p>
                <p v-if="state.drop" class="wild-reward">
                  获得了 {{ itemName(state.drop.typeId, state.drop.nameZh) }}×{{ state.drop.quantity }}
                </p>
                <p class="mono text-dim">
                  dnaHash: {{ state.captured.dnaHash?.slice(0, 24) }}…
                </p>
              </div>
            </div>
          </template>
          <template v-else-if="state.status === 'WILD_FAINTED'">
            <p style="font-size: var(--px-fs-sm)">
              野怪被击倒了，无法再捕捉。
              <span v-if="state.expGained > 0">
                {{ partyNames[state.expGainedBy ?? ''] || state.mine.nameZh || state.mine.name }} 获得
                {{ state.expGained }} 点经验
                <template v-if="state.levelsGained">，升到了 Lv{{ state.mine.level }}</template>。
              </span>
            </p>
            <p v-if="(state.movesLearned ?? []).length" class="wild-reward">
              学会了 {{ state.movesLearned!.map((m) => moveName(m)).join(' / ') }}！
            </p>
            <p v-if="state.canEvolve" class="wild-reward">可以进化了！去队伍页面查看进化条件</p>
            <p v-if="state.bondGain" class="wild-reward">
              {{ t('team.bond') }} +{{ state.bondGain }} ♥
              <BondHearts :bond="state.mine.bond ?? 0" :delta="state.bondGain" size="sm" />
            </p>
            <p v-if="state.faintReward" class="wild-reward">+{{ state.faintReward }}P 击倒奖励</p>
            <p v-if="state.drop" class="wild-reward">
              获得了 {{ itemName(state.drop.typeId, state.drop.nameZh) }}×{{ state.drop.quantity }}
            </p>
          </template>
          <p v-else-if="state.status === 'PLAYER_FAINTED'" style="font-size: var(--px-fs-sm)">
            你的队伍全部倒下了，本次战斗失败，野怪逃走了。
          </p>
          <p v-else-if="state.status === 'TIMEOUT'" style="font-size: var(--px-fs-sm)">
            太久没有操作，野怪逃走了。
          </p>
          <p v-else style="font-size: var(--px-fs-sm)">你带着宝可梦离开了草丛。</p>

          <div style="margin-top: 16px">
            <PixelButton variant="primary" @click="close">继续探索</PixelButton>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.capture-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  z-index: 50;
}

.wild-panel {
  width: 640px;
  max-width: 100%;
  max-height: 100%;
  overflow: auto;
}

.wild-field {
  position: relative;
  padding: 12px;
  background: linear-gradient(180deg, var(--gba-grass) 0%, var(--gba-green-light) 55%, var(--gba-cream-dark) 55%);
  border: 3px solid var(--gba-ink);
}

.wild-foe,
.wild-mine {
  display: flex;
  align-items: flex-end;
  gap: 12px;
}

.wild-foe {
  justify-content: flex-end;
}

.wild-mine {
  justify-content: flex-start;
  margin-top: 4px;
}

.wild-info {
  flex: 0 0 240px;
  background: var(--gba-cream);
  border: 3px solid var(--gba-ink);
  padding: 6px 8px;
}

.wild-name {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  font-size: var(--px-fs-sm);
  margin-bottom: 4px;
}

.wild-badge {
  display: inline-block;
  margin-top: 4px;
  padding: 1px 6px;
  font-size: var(--px-fs-sm);
  color: var(--gba-cream);
  background: var(--gba-red);
  border: 2px solid var(--gba-ink);
}

.wild-turn {
  position: absolute;
  right: 8px;
  bottom: 4px;
  font-size: var(--px-fs-sm);
  color: var(--gba-ink);
  opacity: 0.7;
}

.wild-log {
  height: 84px;
  margin-top: 8px;
  padding: 6px 8px;
  overflow-y: auto;
  background: #fffef0;
  border: 3px solid var(--gba-ink);
  font-size: var(--px-fs-sm);
  line-height: var(--px-lh-body);
}

.wild-log__line {
  margin: 0;
}

.wild-error {
  margin: 6px 0 0;
  font-size: var(--px-fs-sm);
  color: var(--gba-red);
}

.wild-actions,
.wild-party {
  margin-top: 8px;
}

.wild-group + .wild-group {
  margin-top: 8px;
}

.wild-group__title {
  font-size: var(--px-fs-sm);
  margin-bottom: 4px;
}

.wild-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.wild-grid :deep(.px-btn) {
  font-size: var(--px-fs-sm);
  padding: 8px 6px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
}

.wild-chance {
  font-size: var(--px-fs-sm);
}

.wild-hint,
.wild-empty {
  margin: 6px 0 0;
  font-size: var(--px-fs-sm);
  line-height: var(--px-lh-tight);
}

/* 当前区域：区域名 + 等级带（区域等级带模型，docs/backend-api.md §2） */
.wild-zone {
  margin: 8px 0 0;
  font-size: var(--px-fs-sm);
  text-align: center;
}

.wild-hint {
  white-space: pre-line;
}

.wild-empty {
  color: var(--gba-red);
}

.wild-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.wild-result {
  text-align: center;
  padding: 8px 4px 0;
}

.wild-caught {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin-top: 12px;
  text-align: left;
}

/* 积分奖励飘字（收服 +20 / 击倒 等级×1，docs/backend-api.md §10「积分经济」） */
.wild-reward {
  margin: 8px 0 0;
  font-size: var(--px-fs-sm);
  color: var(--gba-yellow);
  text-shadow: 1px 1px 0 var(--gba-ink);
  animation: reward-pop 0.6s steps(3) 1;
}

@keyframes reward-pop {
  from {
    transform: translateY(6px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}
</style>
