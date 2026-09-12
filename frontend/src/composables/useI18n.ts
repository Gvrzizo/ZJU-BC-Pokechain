import { computed, ref, type ComputedRef } from 'vue';
import {
  DEFAULT_LOCALE,
  MESSAGES,
  isLocale,
  normalizeId,
  pokemonIdBySlug,
  type Locale,
  type LocaleDictionary,
} from '@/locales';

/**
 * 轻量 i18n：语言状态是模块级单例（所有组件共享），持久化在 localStorage。
 * 词典与选择逻辑分开，Phaser 场景（BattleScene 等）也可以直接 import 下面这些函数，
 * 不需要在 Vue setup() 里调用。
 *
 * 用法：
 *   const { t, monName, moveName, itemName, natureName, locale, toggleLocale } = useI18n();
 *   t('nav.bag') / monName(pokemon.speciesId) / moveName('thunder-shock') / itemName(item.typeId)
 */

export const LOCALE_STORAGE_KEY = 'pokechain.locale';

export type LocaleParams = Record<string, string | number>;

function readStoredLocale(): Locale {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LOCALE_STORAGE_KEY) : null;
    if (isLocale(raw)) return raw;
  } catch {
    /* 无 localStorage（SSR / 隐私模式 / vitest node 环境）时用默认语言 */
  }
  return DEFAULT_LOCALE;
}

/** 当前语言（模块级单例，响应式） */
export const locale = ref<Locale>(readStoredLocale());

export const dictionary: ComputedRef<LocaleDictionary> = computed(() => MESSAGES[locale.value]);

export function setLocale(next: Locale): void {
  locale.value = next;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    /* 存不进去不影响本次会话 */
  }
}

/** 中 ⇄ en 切换，返回切换后的语言 */
export function toggleLocale(): Locale {
  setLocale(locale.value === 'zh' ? 'en' : 'zh');
  return locale.value;
}

/** 切换按钮上的文案 = 另一种语言 */
export function otherLocaleLabel(): string {
  return locale.value === 'zh' ? 'EN' : '中';
}

function interpolate(raw: string, params?: LocaleParams): string {
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    params[key] === undefined ? placeholder : String(params[key]),
  );
}

/** UI 文案；缺失的键回退默认语言，再回退键名本身 */
export function t(key: string, params?: LocaleParams): string {
  const raw = dictionary.value.ui[key] ?? MESSAGES[DEFAULT_LOCALE].ui[key] ?? key;
  return interpolate(raw, params);
}

/**
 * 链上 `name` 是不是"种族名"（而不是玩家改的昵称）：与中/英词典的种族名等值，
 * 或能被 slug 索引（'pikachu' / 'nidoran-f' / 'Mr. Mime'）解析回同一个图鉴编号。
 * 未改名的链上 name 就是铸造时的种族 slug（`species.data.ts` 的 name 字段），改名后是玩家昵称。
 */
function isSpeciesLabel(dexId: number, value: string): boolean {
  return (
    pokemonIdBySlug(value) === dexId ||
    MESSAGES.zh.pokemon[dexId] === value ||
    MESSAGES.en.pokemon[dexId] === value
  );
}

/**
 * 宝可梦名：收图鉴编号（25 / '25'）或英文名 / slug（'pikachu'），未收录回退 fallback → 原值。
 * **昵称优先**：fallback（链上 name）与种族名不同即视为昵称，直接显示（docs/backend-api.md §2「改名」）；
 * 图鉴页只传 speciesId 不传 fallback，因此始终显示种族名。种族详情里仍能看到种族名（各视图自行展示）。
 */
export function monName(id: number | string, fallback?: string): string {
  const numeric = typeof id === 'number' ? id : /^\d+$/.test(id.trim()) ? Number(id) : Number.NaN;
  const dexId = Number.isFinite(numeric) ? numeric : pokemonIdBySlug(String(id));
  if (dexId !== undefined) {
    if (fallback && !isSpeciesLabel(dexId, fallback)) return fallback;
    const name = dictionary.value.pokemon[dexId];
    if (name) return name;
  }
  if (fallback) return fallback;
  return Number.isFinite(numeric) ? `#${numeric}` : String(id);
}

/** 技能名：收技能 id（'thunder-shock'）或英文技能名（'Thunder Shock'） */
export function moveName(id: string, fallback?: string): string {
  const moves = dictionary.value.moves;
  return moves[id] ?? moves[normalizeId(id)] ?? fallback ?? id;
}

/** 道具名：收链上 typeId（'poke-ball' / 'tm-surf'） */
export function itemName(typeId: string, fallback?: string): string {
  const items = dictionary.value.items;
  return items[typeId] ?? items[normalizeId(typeId)] ?? fallback ?? typeId;
}

/** 性格名：收性格 id（'adamant'） */
export function natureName(id: string, fallback?: string): string {
  const entry = dictionary.value.natures[id] ?? dictionary.value.natures[normalizeId(id)];
  return entry?.name ?? fallback ?? id;
}

/** 性格的能力修正说明（'+攻击 -特攻' / 'no stat change'），无此性格返回空串 */
export function natureEffect(id: string): string {
  const entry = dictionary.value.natures[id] ?? dictionary.value.natures[normalizeId(id)];
  return entry?.effect ?? '';
}

/** 组件里统一入口；函数与上面导出的完全同一份（模块级单例） */
export function useI18n() {
  return {
    locale,
    dictionary,
    setLocale,
    toggleLocale,
    otherLocaleLabel,
    t,
    monName,
    moveName,
    itemName,
    natureName,
    natureEffect,
  };
}
