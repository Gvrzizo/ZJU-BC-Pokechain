import { en } from './en';
import { zh } from './zh';
import type { Locale, LocaleDictionary } from './types';

export * from './types';

/** 每份语言一份词典（zh.ts / en.ts 键集必须一致，见 useI18n.test.ts 的键对齐用例） */
export const MESSAGES: Record<Locale, LocaleDictionary> = { zh, en };

export const DEFAULT_LOCALE: Locale = 'zh';

export const SUPPORTED_LOCALES: readonly Locale[] = ['zh', 'en'];

export function isLocale(value: unknown): value is Locale {
  return value === 'zh' || value === 'en';
}

/** id 归一化：小写，空格/下划线/点号折成连字符（'Thunder Shock' → 'thunder-shock'）。 */
export function normalizeId(id: string): string {
  return id.trim().toLowerCase().replace(/[\s_.]+/g, '-');
}

/** 英文名 / PokeAPI slug → 全国图鉴编号（'Pikachu' 与 'pikachu' 都能命中）。 */
const POKEMON_ID_BY_SLUG: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (const [id, name] of Object.entries(en.pokemon)) map[normalizeId(name)] = Number(id);
  // PokeAPI 的 slug 与官方英文名不总是一致：性别差异种用 -f/-m，大葱鸭没有撇号
  map['nidoran-f'] = 29;
  map['nidoran-m'] = 32;
  map['farfetchd'] = 83;
  return map;
})();

export function pokemonIdBySlug(slug: string): number | undefined {
  return POKEMON_ID_BY_SLUG[normalizeId(slug)];
}
