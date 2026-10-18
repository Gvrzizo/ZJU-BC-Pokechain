<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  evolvePokemon,
  getPokemon,
  healTeam,
  releasePokemon,
  renamePokemon,
  trainPokemon,
} from '@/api/pokemon';
import { getMe } from '@/api/auth';
import { useItem, type PokemonStatKey } from '@/api/items';
import { useAuthStore } from '@/stores/auth';
import { usePokemonStore } from '@/stores/pokemon';
import { useI18n } from '@/composables/useI18n';
import type { EvolutionStep, Item, Pokemon, Stats } from '@/types';
import { currentHpOf as curHp, isFainted as monFainted, maxHpOf as maxHp } from '@/utils/pokemon-hp';
import BondHearts from '@/ui/BondHearts.vue';
import HpBar from '@/ui/HpBar.vue';
import PixelButton from '@/ui/PixelButton.vue';
import PixelDialog from '@/ui/PixelDialog.vue';
import SpriteIcon from '@/ui/SpriteIcon.vue';

const store = usePokemonStore();
const auth = useAuthStore();
const { t, monName, moveName, itemName, natureName } = useI18n();
const selected = ref<Pokemon | null>(null);
const releasing = ref<Pokemon | null>(null);
const trainCost = ref(10);
const message = ref('');

/** 放生奖励：等级 × 1 积分（与 backend/src/pokemon/points-economy.ts 的 RELEASE_POINTS_PER_LEVEL 对齐）。 */
const RELEASE_POINTS_PER_LEVEL = 1;

/** 宝可梦中心治疗单价（backend/src/pokemon/pokemon-hp.service.ts 的 CENTER_HEAL_COST 对齐）。 */
const CENTER_HEAL_COST = 10;

/** 改名单价：第一次免费，之后每次 50P（与 backend/src/pokemon/points-economy.ts 的 RENAME_COST 对齐）。 */
const RENAME_COST = 50;

/** 当前 HP：后端 GET /pokemon 的 currentHp（链下持久伤势），缺省按满血展示（见 utils/pokemon-hp）。 */
function isFainted(p: Pokemon): boolean {
  return monFainted(p);
}

/** 受伤（含濒死）的宝可梦数量：宝可梦中心按钮的提示与禁用依据。 */
const injuredCount = computed(
  () => store.myPokemon.filter((p) => p.status === 'IDLE' && curHp(p) < maxHp(p)).length,
);
const healing = ref(false);

/** 培养道具（王冠加 IV / 神奇糖果 +1 级，docs/backend-api.md §3）；进化石走进化链按钮。 */
const TRAINING_ITEM_IDS = ['rare-candy', 'bottle-cap', 'gold-bottle-cap'];
const STONE_IDS = ['thunder-stone', 'water-stone', 'fire-stone'];
const STAT_KEYS: PokemonStatKey[] = ['hp', 'atk', 'def', 'spatk', 'spdef', 'speed'];

onMounted(() => store.refreshAll());

type NatureStat = 'atk' | 'def' | 'spatk' | 'spdef' | 'speed';

/**
 * 25 种性格修正表（有利 +10% / 不利 -10%，docs/backend-api.md §2 能力值计算）。
 * 名称与说明文案走 locales：natureName() + t('team.natureEffect')。
 */
const NATURE_EFFECTS: Record<string, { up: NatureStat; down: NatureStat }> = {
  hardy: { up: 'atk', down: 'atk' },
  lonely: { up: 'atk', down: 'def' },
  brave: { up: 'atk', down: 'speed' },
  adamant: { up: 'atk', down: 'spatk' },
  naughty: { up: 'atk', down: 'spdef' },
  bold: { up: 'def', down: 'atk' },
  docile: { up: 'def', down: 'def' },
  relaxed: { up: 'def', down: 'speed' },
  impish: { up: 'def', down: 'spatk' },
  lax: { up: 'def', down: 'spdef' },
  timid: { up: 'speed', down: 'atk' },
  hasty: { up: 'speed', down: 'def' },
  serious: { up: 'speed', down: 'speed' },
  jolly: { up: 'speed', down: 'spatk' },
  naive: { up: 'speed', down: 'spdef' },
  modest: { up: 'spatk', down: 'atk' },
  mild: { up: 'spatk', down: 'def' },
  quiet: { up: 'spatk', down: 'speed' },
  bashful: { up: 'spatk', down: 'spatk' },
  rash: { up: 'spatk', down: 'spdef' },
  calm: { up: 'spdef', down: 'atk' },
  gentle: { up: 'spdef', down: 'def' },
  sassy: { up: 'spdef', down: 'speed' },
  careful: { up: 'spdef', down: 'spatk' },
  quirky: { up: 'spdef', down: 'spdef' },
};

const STAT_KEYS_NATURE: NatureStat[] = ['atk', 'def', 'spatk', 'spdef', 'speed'];

/** 能力值标签走词典（攻击 / Attack …） */
function statLabel(key: keyof Stats): string {
  return t(`stat.${key}`);
}

/** 性格的有利/不利项；up===down 的 5 种性格为无修正。 */
function natureEffect(nature: string): { up: NatureStat | null; down: NatureStat | null } {
  const e = NATURE_EFFECTS[nature];
  if (!e || e.up === e.down) return { up: null, down: null };
  return { up: e.up, down: e.down };
}

const ZERO_EVS = { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 };

/** 「有利↑攻击 / 不利↓速度」一行摘要；无修正性格为空。 */
const natureDescription = computed(() => {
  const { up, down } = natureEffect(selected.value?.nature ?? '');
  if (!up || !down) return '';
  return t('team.natureEffect', { up: statLabel(up), down: statLabel(down) });
});

/** 六项最终能力值 + IV + EV 的展示行（stats 由后端 computeStats 提供）。 */
const statRows = computed(() => {
  const { up, down } = natureEffect(selected.value?.nature ?? '');
  return [('hp' as const), ...STAT_KEYS_NATURE].map((key) => ({
    key,
    label: statLabel(key),
    value: selected.value?.stats?.[key] ?? null,
    iv: selected.value?.ivs?.[key] ?? 0,
    ev: (selected.value?.evs ?? ZERO_EVS)[key],
    tag: key === up ? '↑' : key === down ? '↓' : '',
    cls: key === up ? 'stat-up' : key === down ? 'stat-down' : '',
  }));
});

/** 进化分支（后端按"可以进化"优先排序；无分支为 []）。 */
const evolutions = computed<EvolutionStep[]>(() => selected.value?.evolutions ?? []);

/** 背包里可用的进化石（typeId → 堆叠）与培养道具。 */
const stoneStacks = computed(
  () =>
    new Map(
      store.items
        .filter((i) => i.status === 'IDLE' && i.quantity > 0 && STONE_IDS.includes(i.typeId))
        .map((i) => [i.typeId, i]),
    ),
);
const trainingItems = computed(() =>
  store.items.filter(
    (i) => i.status === 'IDLE' && i.quantity > 0 && TRAINING_ITEM_IDS.includes(i.typeId),
  ),
);

/** 进化条件文案：等级进化 "Lv.16"，石头进化 "Lv.20 + 雷之石"。 */
function evoCondition(step: EvolutionStep): string {
  const stone = step.stoneTypeId ? itemName(step.stoneTypeId) : '';
  return stone
    ? t('team.evoLevelStone', { level: step.minLevel, stone })
    : t('team.evoLevel', { level: step.minLevel });
}

/** 不满足条件时的差距提示：先看等级，再看石头。 */
function evoGap(step: EvolutionStep): string {
  const level = selected.value?.level ?? 0;
  if (!step.levelOk) return t('team.evoNeed', { n: step.minLevel - level });
  if (step.stoneTypeId && !stoneStacks.value.has(step.stoneTypeId)) {
    return t('team.evoStone', { stone: itemName(step.stoneTypeId) });
  }
  return '';
}

/** 这一条分支现在能不能点（等级达标 + 石头进化要持有对应石头）。 */
function canEvolveWith(step: EvolutionStep): boolean {
  if (!step.levelOk) return false;
  if (!step.stoneTypeId) return step.canEvolveNow;
  return stoneStacks.value.has(step.stoneTypeId);
}

function statusBadge(s: Pokemon['status']) {
  if (s === 'IDLE') return 'badge--green';
  if (s === 'RELEASED') return 'badge--red';
  return 'badge--yellow';
}

function notIdle(): boolean {
  return selected.value?.status !== 'IDLE';
}

/** 详情刷新（道具/进化后链上数值变化，列表缓存也一起刷新）。 */
async function refreshSelected(): Promise<void> {
  if (!selected.value) return;
  const fresh = await getPokemon(selected.value.id);
  store.upsertPokemon(fresh);
  selected.value = fresh;
}

async function doTrain() {
  if (!selected.value) return;
  try {
    const updated = await trainPokemon(selected.value.id, trainCost.value);
    store.upsertPokemon(updated);
    selected.value = updated;
    message.value = t('team.trained');
  } catch (e: any) {
    message.value = e?.response?.data?.message ?? t('team.trainFail');
  }
}

/** 进化：不带石头 = 等级进化（canEvolveNow 即允许），带石头 = 消耗对应进化石。 */
async function doEvolve(step?: EvolutionStep) {
  if (!selected.value) return;
  const target = step ?? selected.value.evolution ?? undefined;
  const stone = target?.stoneTypeId ? stoneStacks.value.get(target.stoneTypeId) : undefined;
  try {
    const before = selected.value;
    const updated = await evolvePokemon(before.id, stone?.id);
    const learned = updated.moves.filter((m) => !before.moves.includes(m));
    store.upsertPokemon(updated);
    selected.value = updated;
    const suffix = learned.length
      ? `　${t('team.learnedMoves', { moves: learned.map((m) => moveName(m)).join(' / ') })}`
      : '';
    message.value = `${t('team.evolved', { name: monName(updated.speciesId, updated.name) })}${suffix}`;
    await store.refreshItems();
  } catch (e: any) {
    message.value = e?.response?.data?.message ?? t('team.evolveFail');
  }
}

async function doRelease() {
  if (!releasing.value) return;
  const reward = releasing.value.level * RELEASE_POINTS_PER_LEVEL;
  try {
    await releasePokemon(releasing.value.id);
    message.value = t('team.released', { name: monName(releasing.value.speciesId, releasing.value.name) });
    if (selected.value?.id === releasing.value.id) selected.value = null;
    await store.refreshPokemon();
    message.value = `${message.value} +${reward}P`;
  } catch (e: any) {
    message.value = e?.response?.data?.message ?? t('team.releaseFail');
  } finally {
    releasing.value = null;
  }
}

/** 宝可梦中心：全队回满，每次 10P（全员满血不扣费，后端返回 charged=false）。 */
async function doCenterHeal() {
  if (!selected.value) return;
  healing.value = true;
  try {
    const result = await healTeam();
    await store.refreshPokemon();
    if (result.charged) {
      message.value = t('team.centerHealed', { n: result.healed.length, cost: result.cost });
    } else {
      message.value = t('team.centerFull');
    }
    const fresh = await getPokemon(selected.value.id).catch(() => null);
    if (fresh) {
      store.upsertPokemon(fresh);
      selected.value = fresh;
    }
  } catch (e: any) {
    message.value = e?.response?.data?.message ?? t('team.centerFail');
  } finally {
    healing.value = false;
  }
}

// ---- 改名对话框（第一次免费，之后每次 RENAME_COST，docs/backend-api.md §2「改名」）----
const renaming = ref(false);
const renameName = ref('');
const renameBusy = ref(false);
/** 对话框里展示的积分（打开对话框 / 改名成功后从 `GET /users/me` 刷新） */
const points = ref<number | null>(null);
const displayPoints = computed(() => points.value ?? auth.user?.points ?? 0);

/** 是否首次改名（列表/详情带回 `renameCount`；缺省按 0 = 免费处理）。 */
function isFirstRename(p: Pokemon): boolean {
  return (p.renameCount ?? 0) === 0;
}

async function refreshPoints(): Promise<void> {
  try {
    const me = await getMe();
    auth.setUser(me);
    points.value = me.points ?? null;
  } catch {
    points.value = auth.user?.points ?? null;
  }
}

async function openRename() {
  if (!selected.value) return;
  renaming.value = true;
  renameBusy.value = false;
  // 已改过名 → 名字框回填当前昵称；没改过 → 留空让玩家输入新昵称
  renameName.value = isFirstRename(selected.value) ? '' : selected.value.name;
  await refreshPoints();
}

/** 改名：校验与扣费都在后端（链码 ApplyGrowth(name) + AddPoints），成功后刷新列表/详情/积分。 */
async function doRename() {
  const target = selected.value;
  if (!target) return;
  const name = renameName.value.trim();
  if (!name) {
    message.value = t('team.renameHint');
    return;
  }
  renameBusy.value = true;
  try {
    const result = await renamePokemon(target.id, name);
    message.value = result.charged
      ? t('team.renamedPaid', { name: result.name, cost: RENAME_COST })
      : t('team.renamedFree', { name: result.name });
    renaming.value = false;
    await refreshPoints();
    await store.refreshPokemon();
    await refreshSelected();
  } catch (e: any) {
    message.value = e?.response?.data?.message ?? t('team.renameFail');
  } finally {
    renameBusy.value = false;
  }
}

// ---- 培养道具对话框（银色王冠要选一项个体值）----
const usingItem = ref<Item | null>(null);
const useStat = ref<PokemonStatKey | null>(null);
const itemBusy = ref(false);

function openItem(item: Item) {
  usingItem.value = item;
  useStat.value = null;
}

async function confirmUseItem() {
  const item = usingItem.value;
  const target = selected.value;
  if (!item || !target) return;
  if (item.typeId === 'bottle-cap' && !useStat.value) {
    message.value = t('team.itemStatMissing');
    return;
  }
  itemBusy.value = true;
  try {
    const result = await useItem(item.id, {
      targetPokemonId: target.id,
      ...(useStat.value ? { stat: useStat.value } : {}),
    });
    const learned = result.movesLearned ?? [];
    const detail = [
      result.message ?? '',
      result.levelsGained ? `Lv${target.level + result.levelsGained}` : '',
      learned.length ? t('team.learnedMoves', { moves: learned.map((m) => moveName(m)).join(' / ') }) : '',
      result.canEvolve ? t('team.evoCan') : '',
    ]
      .filter(Boolean)
      .join('　');
    message.value = t('team.itemUsed', { item: itemName(item.typeId), detail });
    await store.refreshItems();
    await refreshSelected();
  } catch (e: any) {
    message.value = e?.response?.data?.message ?? t('team.itemFail');
  } finally {
    usingItem.value = null;
    useStat.value = null;
    itemBusy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <div class="px-panel mb-16 row" style="justify-content: space-between">
      <h2 style="margin: 0">{{ t('team.title') }}</h2>
      <span class="row" style="gap: 8px; align-items: center">
        <span v-if="injuredCount > 0" style="font-size: var(--px-fs-sm); color: var(--gba-red)">
          {{ t('team.injured', { n: injuredCount }) }}
        </span>
        <PixelButton variant="blue" :disabled="healing" @click="doCenterHeal">
          {{ t('team.center', { cost: CENTER_HEAL_COST }) }}
        </PixelButton>
        <span style="font-size: var(--px-fs-sm)">{{ t('team.count', { n: store.myPokemon.length }) }}</span>
      </span>
    </div>
    <p v-if="message" class="mb-8" style="font-size: var(--px-fs-sm); color: var(--gba-blue)">{{ message }}</p>

    <div class="collection-layout" :class="{ 'collection-layout--detail': selected }">
      <div class="collection-grid">
        <button
          v-for="p in store.myPokemon"
          :key="p.id"
          class="px-panel collection-cell"
          :aria-pressed="selected?.id === p.id"
          @click="selected = p"
        >
          <SpriteIcon :species-id="p.speciesId" :size="64" style="margin: 0 auto" />
          <div style="font-size: var(--px-fs-sm); margin-top: 6px">
            {{ monName(p.speciesId, p.name) }}<template v-if="p.shiny"> ★</template>
          </div>
          <div style="font-size: var(--px-fs-sm)">Lv{{ p.level }}</div>
          <!-- 伤势持久化：当前 HP 条 + 濒死标记（chain 上不存 HP，见 docs/backend-api.md §2） -->
          <HpBar :hp="curHp(p)" :max-hp="maxHp(p)" />
          <div v-if="isFainted(p)" class="badge badge--red" style="margin-top: 2px">
            {{ t('team.fainted') }}
          </div>
          <span class="badge" :class="statusBadge(p.status)">{{ p.status }}</span>
        </button>
        <p v-if="store.myPokemon.length === 0" class="text-dim" style="font-size: var(--px-fs-sm)">
          {{ t('team.empty') }}
        </p>
      </div>

      <div v-if="selected" class="px-panel collection-detail">
        <h2>
          {{ monName(selected.speciesId, selected.name) }}
          <span v-if="selected.shiny" style="color: var(--gba-yellow)">★</span>
        </h2>
        <div class="row">
          <SpriteIcon :species-id="selected.speciesId" :size="96" />
          <div style="font-size: var(--px-fs-sm); flex: 1">
            <p>{{ t('team.species') }}：{{ monName(selected.speciesId) }}（No.{{ selected.speciesId }}）</p>
            <p>Lv{{ selected.level }}　EXP {{ selected.exp }}</p>
            <p>
              {{ t('team.hp') }}：{{ curHp(selected) }} / {{ maxHp(selected) }}
              <span v-if="isFainted(selected)" class="badge badge--red">{{ t('team.fainted') }}</span>
            </p>
            <HpBar v-if="maxHp(selected) > 0" :hp="curHp(selected)" :max-hp="maxHp(selected)" />
            <p>
              {{ t('team.nature') }}：{{ natureName(selected.nature) }}
              <span class="text-dim">（{{ selected.nature }}）</span>　{{ t('team.ability') }}：{{ selected.ability }}
            </p>
            <p v-if="natureDescription" style="color: var(--gba-blue)">{{ natureDescription }}</p>
            <p>
              {{ t('team.bond') }}：<BondHearts :bond="selected.bond ?? 0" size="sm" show-value />
              <span class="text-dim">{{ t('team.bondHint') }}</span>
            </p>
            <!-- 羁绊战斗加成：非 HP 五项 × (1 + bond/255 × 5%)，战斗引擎出战时的实际增益 -->
            <p style="color: var(--gba-blue)">
              {{ t('team.bondBonus', { n: (selected.bondBonus ?? 0).toFixed(1) }) }}
            </p>
            <p>{{ t('common.status') }}：<span class="badge" :class="statusBadge(selected.status)">{{ selected.status }}</span></p>
          </div>
        </div>

        <h3 class="mt-16" style="font-size: var(--px-fs-sm)">{{ t('team.statsTitle') }}</h3>
        <div class="grid" style="grid-template-columns: repeat(3, 1fr); font-size: var(--px-fs-sm); gap: 4px">
          <div v-for="row in statRows" :key="row.key" :class="row.cls">
            <div style="font-size: var(--px-fs-sm)">
              {{ row.label }} <strong>{{ row.value ?? '—' }}</strong>
              <span v-if="row.tag">{{ row.tag }}</span>
            </div>
            <div class="text-dim">IV {{ row.iv }} / EV {{ row.ev }}</div>
          </div>
        </div>
        <p class="text-dim" style="font-size: var(--px-fs-sm); margin-top: 4px">
          {{ t('team.statsFormula') }}
        </p>
        <h3 class="mt-16" style="font-size: var(--px-fs-sm)">{{ t('team.moves') }}</h3>
        <p style="font-size: var(--px-fs-sm)">{{ selected.moves.map((m) => moveName(m)).join(' / ') || '—' }}</p>

        <!-- 进化链：当前 → 目标（sprite/中文名/条件）；条件满足高亮按钮，否则灰显差距 -->
        <h3 class="mt-16" style="font-size: var(--px-fs-sm)">{{ t('team.evoTitle') }}</h3>
        <div v-if="evolutions.length > 0">
          <div
            v-for="step in evolutions"
            :key="step.targetSpeciesId"
            class="evo-row px-panel"
            :class="{ 'evo-row--ready': canEvolveWith(step) }"
          >
            <SpriteIcon :species-id="selected.speciesId" :size="40" />
            <span class="evo-arrow">→</span>
            <SpriteIcon :species-id="step.targetSpeciesId" :size="40" />
            <div style="flex: 1; font-size: var(--px-fs-sm)">
              <div>{{ monName(step.targetSpeciesId, step.targetNameZh || step.targetName) }}</div>
              <div class="text-dim">{{ evoCondition(step) }}</div>
            </div>
            <template v-if="canEvolveWith(step)">
              <PixelButton variant="primary" :disabled="notIdle()" @click="doEvolve(step)">
                {{ step.stoneTypeId ? t('team.evoStoneReady', { stone: itemName(step.stoneTypeId) }) : t('team.evoCan') }}
              </PixelButton>
            </template>
            <span v-else class="text-dim" style="font-size: var(--px-fs-sm)">{{ evoGap(step) }}</span>
          </div>
        </div>
        <p v-else class="text-dim" style="font-size: var(--px-fs-sm)">{{ t('team.evoFinal') }}</p>

        <h3 class="mt-16" style="font-size: var(--px-fs-sm)">{{ t('team.chain') }}</h3>
        <p class="mono">dnaHash: {{ selected.dnaHash }}</p>
        <p class="mono">captureEvent: {{ selected.captureEventId || '—' }}</p>

        <h3 class="mt-16" style="font-size: var(--px-fs-sm)">{{ t('team.itemsTitle') }}</h3>
        <div v-if="trainingItems.length > 0" class="row" style="flex-wrap: wrap">
          <PixelButton
            v-for="item in trainingItems"
            :key="item.id"
            :disabled="notIdle()"
            @click="openItem(item)"
          >
            {{ itemName(item.typeId) }} ×{{ item.quantity }}
          </PixelButton>
        </div>
        <p v-else class="text-dim" style="font-size: var(--px-fs-sm)">{{ t('team.itemsEmpty') }}</p>

        <div class="mt-16">
          <div class="px-field row">
            <input
              v-model.number="trainCost"
              class="px-input"
              type="number"
              min="1"
              style="width: 90px"
            />
            <PixelButton variant="blue" :disabled="notIdle()" @click="doTrain">
              {{ t('team.train') }}
            </PixelButton>
          </div>
          <p class="text-dim" style="font-size: var(--px-fs-sm)">{{ t('team.trainHint') }}</p>
          <div class="row">
            <PixelButton variant="blue" :disabled="notIdle()" @click="openRename">
              {{ t('team.rename') }}
            </PixelButton>
            <PixelButton variant="danger" :disabled="notIdle()" @click="releasing = selected">
              {{ t('team.release') }}
            </PixelButton>
          </div>
          <p v-if="notIdle()" class="mt-8" style="font-size: var(--px-fs-sm); color: var(--gba-red)">
            {{ t('team.locked', { status: selected.status, ref: selected.lockRef || '—' }) }}
          </p>
        </div>
      </div>
    </div>

    <PixelDialog
      v-if="usingItem && selected"
      :title="t('team.useItemTitle', { item: itemName(usingItem.typeId), name: monName(selected.speciesId, selected.name) })"
      :confirm-text="t('common.use')"
      @confirm="confirmUseItem"
      @cancel="usingItem = null"
    >
      <p style="font-size: var(--px-fs-sm)">{{ t('team.useItemAsk', { item: itemName(usingItem.typeId) }) }}</p>
      <div v-if="usingItem.typeId === 'bottle-cap'" class="mt-8">
        <p style="font-size: var(--px-fs-sm)">{{ t('team.pickStat') }}</p>
        <div class="grid" style="grid-template-columns: repeat(3, 1fr); gap: 4px">
          <PixelButton
            v-for="key in STAT_KEYS"
            :key="key"
            :variant="useStat === key ? 'primary' : undefined"
            :disabled="itemBusy"
            @click="useStat = key"
          >
            {{ statLabel(key) }}
            <span class="text-dim">IV {{ selected.ivs[key] }}</span>
          </PixelButton>
        </div>
      </div>
    </PixelDialog>

    <PixelDialog
      v-if="renaming && selected"
      :title="t('team.renameTitle', { name: monName(selected.speciesId, selected.name) })"
      :confirm-text="t('team.renameAction')"
      @confirm="doRename"
      @cancel="renaming = false"
    >
      <!-- 第一次免费 / 之后每次 50P，价格依据链下 renameCount（列表接口带回） -->
      <p :style="{ color: isFirstRename(selected) ? 'var(--gba-green-light)' : 'var(--gba-yellow)' }">
        {{ isFirstRename(selected) ? t('team.renameFree') : t('team.renameCost', { cost: RENAME_COST }) }}
      </p>
      <p class="mt-8">{{ t('team.renamePoints', { points: displayPoints }) }}</p>
      <div class="px-field mt-8">
        <input
          v-model="renameName"
          class="px-input"
          type="text"
          maxlength="12"
          style="width: 100%"
          :disabled="renameBusy"
          :placeholder="t('team.rename')"
          @keyup.enter="doRename"
        />
      </div>
      <p class="text-dim mt-8" style="font-size: var(--px-fs-sm)">{{ t('team.renameHint') }}</p>
    </PixelDialog>

    <PixelDialog
      v-if="releasing"
      :title="t('team.releaseTitle')"
      danger
      :confirm-text="t('team.releaseConfirm')"
      @confirm="doRelease"
      @cancel="releasing = null"
    >
      <p>
        {{ t('team.releaseAsk', { name: monName(releasing.speciesId, releasing.name), level: releasing.level }) }}
      </p>
      <p class="mt-8" style="color: var(--gba-green-light)">
        放生可得 {{ releasing.level * RELEASE_POINTS_PER_LEVEL }} 积分（等级 × {{ RELEASE_POINTS_PER_LEVEL }}，链上 AddPoints 发放）。
      </p>
      <p class="mt-8" style="color: var(--gba-red)">
        {{ t('team.releaseWarn') }}
      </p>
    </PixelDialog>
  </div>
</template>

<style scoped>
.evo-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  margin-top: 6px;
}

.evo-row--ready {
  border-color: var(--gba-green);
  background: rgba(120, 200, 120, 0.15);
}

.evo-arrow {
  font-size: var(--px-fs-sm);
  color: var(--gba-ink);
}
</style>
