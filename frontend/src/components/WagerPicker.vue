<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { listWagerTemplates, saveWagerTemplate } from '@/api/battles';
import { usePokemonStore } from '@/stores/pokemon';
import { useI18n } from '@/composables/useI18n';
import { clampWagerToInventory, describeWager } from '@/components/wager-inventory';
import { TEAM_SIZE_MAX, toggleTeamMember } from '@/components/team-picker';
import { isFainted } from '@/utils/pokemon-hp';
import type { Pokemon, WagerItemRef, WagerRequest, WagerTemplate } from '@/types';
import ItemIcon from '@/ui/ItemIcon.vue';

const props = defineProps<{
  wager: WagerRequest;
  team: string[];
}>();

const emit = defineEmits<{
  (e: 'update:wager', v: WagerRequest): void;
  (e: 'update:team', v: string[]): void;
}>();

const store = usePokemonStore();
const { monName, itemName } = useI18n();

/** 常用押注模板（GET /battles/templates，每用户最多 10 个） */
const templates = ref<WagerTemplate[]>([]);
const selectedTemplate = ref('');
const templateName = ref('');
const templateNote = ref('');
const showSave = ref(false);
const templateHint = ref('');
/** 出战队伍超上限（6 只）时的提示 */
const teamHint = ref('');

onMounted(async () => {
  try {
    templates.value = await listWagerTemplates();
  } catch (e) {
    // 模板是增益功能：拉不到不影响手动押注
    console.warn('[lobby] 押注模板加载失败', e);
  }
});

function toggleList(arr: string[], id: string): string[] {
  return arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id];
}

function setPoints(v: number) {
  emit('update:wager', { ...props.wager, points: v });
}

function toggleWagerPokemon(id: string) {
  emit('update:wager', { ...props.wager, pokemonIds: toggleList(props.wager.pokemonIds, id) });
}

/** 出战队伍勾选：最多 6 只（与服务端 1-6 校验同一口径），超限时提示而不改动选择 */
function toggleTeam(id: string) {
  const { team, rejected } = toggleTeamMember(props.team, id);
  if (rejected) {
    teamHint.value = `出战队伍最多 ${TEAM_SIZE_MAX} 只（当前已选 ${props.team.length} 只）`;
    return;
  }
  teamHint.value = '';
  emit('update:team', team);
}

/**
 * 可出战的宝可梦（我的 IDLE）与濒死名单（伤势持久化，docs/backend-api.md §2）：
 * 濒死者在这里灰显禁选——即便漏选，服务端 `assertTeam`/`assertTeamOwnership` 也会 FAINTED 拒绝。
 */
const idlePokemon = computed<Pokemon[]>(() => store.myPokemon.filter((p) => p.status === 'IDLE'));
const faintedCount = computed(() => idlePokemon.value.filter((p) => isFainted(p)).length);
const selectableCount = computed(() => idlePokemon.value.length - faintedCount.value);

/** 已押数量；未勾选返回 null */
function wageredQty(id: string): number | null {
  const ref = props.wager.items.find((r) => r.id === id);
  return ref ? ref.qty : null;
}

/** 勾选道具默认押整堆（qty=持有量），取消则整项移除 */
function toggleWagerItem(id: string, held: number) {
  const items: WagerItemRef[] =
    wageredQty(id) !== null
      ? props.wager.items.filter((r) => r.id !== id)
      : [...props.wager.items, { id, qty: held }];
  emit('update:wager', { ...props.wager, items });
}

/** 数量夹在 1..持有量；非法输入回退整堆 */
function setItemQty(id: string, held: number, raw: string) {
  const n = Number(raw);
  const qty = Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), held) : held;
  emit('update:wager', {
    ...props.wager,
    items: props.wager.items.map((r) => (r.id === id ? { ...r, qty } : r)),
  });
}

/** 载入模板：按当前背包裁剪（模板里的资产可能已消耗/易主/被锁定），张数夹到持有量 */
function loadTemplate() {
  const tpl = templates.value.find((t) => t.id === selectedTemplate.value);
  if (!tpl) return;
  const { wager, dropped } = clampWagerToInventory(tpl.wager, store.myPokemon, store.items);
  emit('update:wager', wager);
  templateHint.value = dropped
    ? `已载入「${tpl.name}」：${dropped} 项资产已不在背包（或非空闲/濒死），已自动剔除`
    : `已载入「${tpl.name}」：${describeWager(wager)}`;
}

/** 存为模板：存"名称 + 当前押注清单 + 备注"，上限由服务端把关（10 个） */
async function saveAsTemplate() {
  const name = templateName.value.trim();
  if (!name) return;
  try {
    const saved = await saveWagerTemplate({
      name,
      note: templateNote.value.trim(),
      wager: { ...props.wager, items: [...props.wager.items] },
    });
    templates.value = [saved, ...templates.value];
    selectedTemplate.value = saved.id;
    templateName.value = '';
    templateNote.value = '';
    showSave.value = false;
    templateHint.value = `已保存模板「${saved.name}」（${describeWager(saved.wager)}）`;
  } catch (e: unknown) {
    const err = e as { response?: { data?: { code?: string; message?: string } } };
    templateHint.value =
      err?.response?.data?.code === 'TEMPLATE_LIMIT'
        ? '模板已达上限（10 个），请先删除不用的模板'
        : (err?.response?.data?.message ?? '模板保存失败');
  }
}
</script>

<template>
  <div>
    <div class="px-field">
      <label>押注模板（最多 10 个）</label>
      <div class="row">
        <select v-model="selectedTemplate" class="px-input" aria-label="押注模板">
          <option value="">选择模板…</option>
          <option v-for="t in templates" :key="t.id" :value="t.id">
            {{ t.name }}（{{ describeWager(t.wager) }}）
          </option>
        </select>
        <button class="px-btn" type="button" :disabled="!selectedTemplate" @click="loadTemplate">
          载入
        </button>
        <button class="px-btn" type="button" @click="showSave = !showSave">存为模板</button>
      </div>
      <div v-if="showSave" class="row mt-8">
        <input
          v-model="templateName"
          class="px-input"
          maxlength="30"
          placeholder="模板名（≤30 字）"
          aria-label="模板名"
        />
        <input
          v-model="templateNote"
          class="px-input"
          maxlength="100"
          placeholder="备注（≤100 字）"
          aria-label="模板备注"
        />
        <button class="px-btn" type="button" :disabled="!templateName.trim()" @click="saveAsTemplate">
          保存
        </button>
      </div>
      <p v-if="templateHint" class="text-dim" style="font-size: var(--px-fs-sm)">{{ templateHint }}</p>
    </div>
    <div class="px-field">
      <label>押注积分</label>
      <input
        class="px-input"
        type="number"
        min="0"
        :value="wager.points"
        @input="setPoints(Number(($event.target as HTMLInputElement).value))"
      />
    </div>
    <label style="font-size: var(--px-fs-sm)">
      出战队伍 / 押注宝可梦（我的 IDLE 宝可梦，濒死者不可出战）
      <span class="text-dim">出战 {{ team.length }}/{{ TEAM_SIZE_MAX }}</span>
    </label>
    <div style="max-height: 160px; overflow: auto; font-size: var(--px-fs-sm); margin-bottom: 8px">
      <div v-for="p in idlePokemon" :key="p.id" :class="{ 'picker-row--fainted': isFainted(p) }">
        <label :title="isFainted(p) ? '濒死：先去宝可梦中心恢复（队伍页面）或使用伤药' : undefined">
          <input
            type="checkbox"
            :checked="team.includes(p.id)"
            :disabled="isFainted(p) || (!team.includes(p.id) && team.length >= TEAM_SIZE_MAX)"
            @change="toggleTeam(p.id)"
          />
          出战 {{ monName(p.speciesId, p.name) }} Lv{{ p.level }}
          <span v-if="isFainted(p)" class="badge badge--red">濒死</span>
        </label>
        <label style="margin-left: 12px">
          <input
            type="checkbox"
            :checked="wager.pokemonIds.includes(p.id)"
            :disabled="isFainted(p)"
            @change="toggleWagerPokemon(p.id)"
          />
          押注
        </label>
      </div>
      <p v-if="faintedCount > 0" class="text-dim" style="font-size: var(--px-fs-sm); margin: 4px 0 0">
        有 {{ faintedCount }} 只宝可梦处于濒死状态，不能出战/押注；请先去队伍页面的「宝可梦中心」恢复（每次 10P）或使用伤药。
      </p>
      <p v-else-if="selectableCount === 0" class="text-dim" style="font-size: var(--px-fs-sm)">
        没有可出战的宝可梦——先去草丛捕捉一只吧。
      </p>
      <p v-if="teamHint" style="font-size: var(--px-fs-sm); color: var(--gba-red)">{{ teamHint }}</p>
    </div>
    <label style="font-size: var(--px-fs-sm)">押注道具（可押部分数量）</label>
    <div style="max-height: 120px; overflow: auto; font-size: var(--px-fs-sm)">
      <div
        v-for="i in store.items.filter((x) => x.status === 'IDLE' && x.quantity > 0)"
        :key="i.id"
        class="wager-row"
      >
        <label class="wager-row__pick">
          <input
            type="checkbox"
            :checked="wageredQty(i.id) !== null"
            @change="toggleWagerItem(i.id, i.quantity)"
          />
          <ItemIcon :type-id="i.typeId" :size="24" />
          {{ itemName(i.typeId) }}
        </label>
        <span class="text-dim">持有 ×{{ i.quantity }}</span>
        <template v-if="wageredQty(i.id) !== null">
          <input
            class="px-input wager-row__qty"
            type="number"
            min="1"
            :max="i.quantity"
            :value="wageredQty(i.id)"
            aria-label="押注数量"
            @input="setItemQty(i.id, i.quantity, ($event.target as HTMLInputElement).value)"
          />
          <button
            class="px-btn"
            type="button"
            title="押整堆"
            @click="setItemQty(i.id, i.quantity, String(i.quantity))"
          >
            全量
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 濒死（0 HP）的宝可梦：整行灰显 + 禁选（伤势持久化，docs/backend-api.md §2） */
.picker-row--fainted {
  opacity: 0.55;
}

.wager-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.wager-row__pick {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 1;
}

.wager-row__qty {
  width: 56px;
  padding: 2px 4px;
  font-size: var(--px-fs-sm);
}
</style>
