import { BaseStats } from './species.data';

/**
 * 第三世代起官方能力值公式（Bulbapedia "Stat" / "Nature"，经核实）：
 *
 *   HP    = floor((2*Base + IV + floor(EV/4)) * Level / 100) + Level + 10
 *   其他五项 = floor( ( floor((2*Base + IV + floor(EV/4)) * Level / 100) + 5 ) * 性格修正 )
 *
 * 性格修正：有利 1.1 / 不利 0.9 / 无修正 1.0。EV 单项 0–255、六项总和 ≤ 510，
 * 故 510/4 = 127 点加成封顶（等级 100 时约 +63 单项）。
 */

export type StatKey = 'hp' | 'atk' | 'def' | 'spatk' | 'spdef' | 'speed';
export type StatBlock = Record<StatKey, number>;

export const STAT_KEYS: StatKey[] = ['hp', 'atk', 'def', 'spatk', 'spdef', 'speed'];

export const EV_MAX_PER_STAT = 255;
export const EV_MAX_TOTAL = 510;

export const NATURE_BOOST = 1.1;
export const NATURE_HINDER = 0.9;

/** 非 HP 五项（性格不影响 HP）。 */
export type NatureStat = Exclude<StatKey, 'hp'>;

export interface NatureEffect {
  up: NatureStat | null;
  down: NatureStat | null;
}

/** 25 种性格：有利项 +10%，不利项 -10%；up===down 的 5 种（hardy/docile/serious/bashful/quirky）无修正。 */
export const NATURE_EFFECTS: Record<string, NatureEffect> = {
  hardy: { up: null, down: null },
  lonely: { up: 'atk', down: 'def' },
  brave: { up: 'atk', down: 'speed' },
  adamant: { up: 'atk', down: 'spatk' },
  naughty: { up: 'atk', down: 'spdef' },
  bold: { up: 'def', down: 'atk' },
  docile: { up: null, down: null },
  relaxed: { up: 'def', down: 'speed' },
  impish: { up: 'def', down: 'spatk' },
  lax: { up: 'def', down: 'spdef' },
  timid: { up: 'speed', down: 'atk' },
  hasty: { up: 'speed', down: 'def' },
  serious: { up: null, down: null },
  jolly: { up: 'speed', down: 'spatk' },
  naive: { up: 'speed', down: 'spdef' },
  modest: { up: 'spatk', down: 'atk' },
  mild: { up: 'spatk', down: 'def' },
  quiet: { up: 'spatk', down: 'speed' },
  bashful: { up: null, down: null },
  rash: { up: 'spatk', down: 'spdef' },
  calm: { up: 'spdef', down: 'atk' },
  gentle: { up: 'spdef', down: 'def' },
  sassy: { up: 'spdef', down: 'speed' },
  careful: { up: 'spdef', down: 'spatk' },
  quirky: { up: null, down: null },
};

export function natureEffect(nature: string): NatureEffect {
  return NATURE_EFFECTS[nature?.toLowerCase()] ?? { up: null, down: null };
}

/** 性格修正系数：有利 1.1 / 不利 0.9 / 无修正 1.0。 */
export function natureMultiplier(nature: string, stat: NatureStat): number {
  const { up, down } = natureEffect(nature);
  if (up === stat) return NATURE_BOOST;
  if (down === stat) return NATURE_HINDER;
  return 1;
}

export function emptyEvs(): StatBlock {
  return { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 };
}

/** 兼容旧链上记录：缺失/非法 EV 一律按 0 处理，并夹取到单项与总和上限。 */
export function normalizeEvs(evs?: Partial<StatBlock> | null): StatBlock {
  const out = emptyEvs();
  if (!evs) return out;
  let total = 0;
  for (const key of STAT_KEYS) {
    const raw = evs[key];
    const value = Number.isInteger(raw) && (raw as number) > 0 ? Math.min(raw as number, EV_MAX_PER_STAT) : 0;
    out[key] = value;
    total += value;
  }
  if (total > EV_MAX_TOTAL) {
    let budget = EV_MAX_TOTAL;
    for (const key of STAT_KEYS) {
      const take = Math.min(out[key], budget);
      out[key] = take;
      budget -= take;
    }
  }
  return out;
}

export function evTotal(evs: Partial<StatBlock> | null | undefined): number {
  if (!evs) return 0;
  return STAT_KEYS.reduce((sum, key) => {
    const raw = evs[key];
    return sum + (Number.isInteger(raw) && (raw as number) > 0 ? (raw as number) : 0);
  }, 0);
}

export function computeStats(
  base: BaseStats,
  ivs: Partial<StatBlock> | null | undefined,
  evs: Partial<StatBlock> | null | undefined,
  level: number,
  nature: string,
): StatBlock {
  const safeLevel = Number.isFinite(level) ? Math.min(100, Math.max(1, Math.floor(level))) : 1;
  const poke = (key: StatKey) => 2 * base[key] + (ivs?.[key] ?? 0) + Math.floor((evs?.[key] ?? 0) / 4);

  const hp = Math.floor((poke('hp') * safeLevel) / 100) + safeLevel + 10;
  const other = (key: NatureStat) =>
    Math.floor((Math.floor((poke(key) * safeLevel) / 100) + 5) * natureMultiplier(nature, key));

  return {
    hp,
    atk: other('atk'),
    def: other('def'),
    spatk: other('spatk'),
    spdef: other('spdef'),
    speed: other('speed'),
  };
}

/** 训练加成优先级（主攻项固定插到最前）：速度 → 物防 → 另一攻 → 特防 → HP。 */
export const TRAIN_EV_ORDER: NatureStat[] = ['atk', 'speed', 'def', 'spatk', 'spdef'];

/** 训练收益：每点 costPoints 折 4 EV，遵守单项 255 / 总和 510；分配方案见 TRAIN_EV_ORDER。 */
export function applyTrainingEvs(
  current: Partial<StatBlock> | null | undefined,
  offense: NatureStat,
  gain: number,
): StatBlock {
  const evs = normalizeEvs(current);
  let budget = Number.isSafeInteger(gain) && gain > 0 ? gain : 0;
  let total = evTotal(evs);
  const order: StatKey[] = [offense, ...TRAIN_EV_ORDER.filter((k) => k !== offense), 'hp'];
  for (const key of order) {
    if (budget <= 0) break;
    const room = Math.min(EV_MAX_PER_STAT - evs[key], EV_MAX_TOTAL - total);
    const take = Math.min(room, budget);
    if (take > 0) {
      evs[key] += take;
      total += take;
      budget -= take;
    }
  }
  return evs;
}

/** 默认主攻项：物攻 ≥ 特攻则练物攻，否则练特攻（按等级 100 的种族值直观比较）。 */
export function offenseStatOf(base: BaseStats): NatureStat {
  return base.atk >= base.spatk ? 'atk' : 'spatk';
}
