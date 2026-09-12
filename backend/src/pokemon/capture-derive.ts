import { DeriveStream, sha256hex } from '../common/utils/crypto.util';
import { PokemonIvs } from '../fabric/chain.types';
import { NATURES } from '../game-data/natures.data';
import { SpeciesDef, WILD_TABLE } from '../game-data/species.data';

/**
 * Deterministic derivation layout for capture events. One RandomCommit event
 * covers the encounter, the whole wild (PvE) battle fought on it and every
 * capture attempt, so the doc's simple "rand(0..8)" layout is offset into
 * disjoint blocks (documented for auditors, see FairnessModule):
 *
 *   n=0          wild species index (into WILD_TABLE)
 *   n=1          wild base level = clamp(L-2 + floor(rand*5), 2, 100)
 *                (L = highest IDLE party level, 5 when the player has none;
 *                 +5/+10 for lure tier 1/2, capped at 100)
 *   attempt k:   base = 2 + (k-1)*10
 *     +0  catch roll   -> success iff roll < captureProbability(...)
 *     +1..+6  IVs hp/atk/def/spatk/spdef/speed = floor(rand*32)
 *     +7  nature index (25 natures)
 *     +8  shiny iff rand < shinyChance (1/4096, 1/1024 with lure tier 2)
 *     +9  shakes on failure = 1 + floor(rand*3)
 *   wild battle specimen: base = 20000
 *     +0..+5 IVs, +6 nature, +7 shiny  (fixed for the whole session and reused
 *     by MintFromCapture, so the mon you fought is the mon you caught)
 *   wild battle turn t (1-based): base = 30000 + (t-1)*16
 *     +0 wild AI move roll
 *     +1..+5 player attack: par check (only when paralyzed), hit, crit,
 *            damage factor, effect chance (only for stat/status moves)
 *     +6..+10 wild attack: same five slots
 *     +11 speed tie-break
 *     +12..+15 reserved (future AI switch / multi-hit slots)
 *   battle drop (wild battle only, settled at the terminal turn): base = 40000
 *     +0 drop roll   -> item drops iff rand < WILD_DROP_CHANCE (20%)
 *     +1 kind roll   -> 60% potion / 30% poke-ball / 10% great-ball
 *     (CAUGHT and WILD_FAINTED are mutually exclusive endings of the same
 *      event, so both read the same two slots; quantity is always 1)
 *
 * The 20000/30000/40000 regions stay disjoint from the attempt blocks (an
 * attempt block would have to reach n=20000, i.e. 2000 throws).
 */
export const CAPTURE_DERIVATION_DOC =
  'rand(n)=HMAC-SHA256(key=serverSeed,msg=`${clientSeed}|${eventId}|${n}`) first 8 bytes BE / 2^64; ' +
  'n=0 species, n=1 wild base level=clamp(partyTopLevel-2+floor(r*5),2,100) (+lure tier bonus, capped 100); ' +
  'attempt k uses base=2+(k-1)*10: +0 catch roll vs ' +
  'p=min(1,a/255), a=((3*maxHP-2*curHP)*catchRate*ballBonus)/(3*maxHP), ' +
  '+1..6 IVs=floor(r*32), +7 nature=r*25, +8 shiny=r<shinyChance (1/4096, x4 with lure tier 2), +9 shakes=1+floor(r*3); ' +
  'wild specimen base=20000: +0..5 IVs, +6 nature, +7 shiny; ' +
  'wild turn t base=30000+(t-1)*16: +0 AI move, +1..5 player par/hit/crit/factor/effect, ' +
  '+6..10 wild par/hit/crit/factor/effect, +11 speed tie, +12..15 reserved; ' +
  'battle drop base=40000: +0 drop iff r<0.2, +1 kind 60% potion / 30% poke-ball / 10% great-ball';

export const ATTEMPT_BLOCK = 10;
export const ATTEMPT_BASE = 2;
export const WILD_MON_BASE = 20_000;
export const WILD_TURN_BASE = 30_000;
export const WILD_TURN_BLOCK = 16;
/** 野怪战斗掉落区：+0 是否掉落、+1 品类（见 deriveWildDrop） */
export const WILD_DROP_BASE = 40_000;
/** 大师球倍率；ballBonus ≥ 该值 → 必中（官方大师球 255） */
export const MASTER_BALL_BONUS = 255;

/** 闪光基准概率（第 3 世代 1/4096）；诱饵 tier 2 ×4 → 1/1024 */
export const SHINY_CHANCE = 1 / 4096;

/** 付费诱饵档位：0 免费 / 1 = 50 积分 +5 级 / 2 = 200 积分 +10 级且闪光概率 ×4 */
export interface LureSpec {
  cost: number;
  levelBonus: number;
  shinyMultiplier: number;
}

export const LURE_TIERS: Record<number, LureSpec> = {
  0: { cost: 0, levelBonus: 0, shinyMultiplier: 1 },
  1: { cost: 50, levelBonus: 5, shinyMultiplier: 1 },
  2: { cost: 200, levelBonus: 10, shinyMultiplier: 4 },
};

/** 档位 → 规格；非法档位返回 null（调用方抛 INVALID_LURE_TIER） */
export function lureSpec(tier: number): LureSpec | null {
  return LURE_TIERS[tier] ?? null;
}

/** 水平线的队伍最高等级：无队伍按 5 计（新账号第一只也有合理的野怪强度） */
export const DEFAULT_TEAM_TOP_LEVEL = 5;

/**
 * 官方风格捕捉率（第三世代起）：
 *   a = ((3*maxHP - 2*curHP) * catchRate * ballBonus) / (3*maxHP)
 *   p = min(1, a / 255)
 * HP 越低 p 越高；大师球（ballBonus ≥ 255）恒为 1。快速捕捉
 * （POST /capture/attempt）等价于满血投球：captureProbability(1, 1, ...)。
 */
export function captureProbability(
  maxHp: number,
  curHp: number,
  catchRate: number,
  ballBonus: number,
): number {
  if (ballBonus >= MASTER_BALL_BONUS) return 1;
  if (!(maxHp > 0)) return 0;
  const hp = Math.min(maxHp, Math.max(0, curHp));
  const a = ((3 * maxHp - 2 * hp) * catchRate * ballBonus) / (3 * maxHp);
  return Math.min(1, Math.max(0, a / 255));
}

/**
 * 野怪基础等级：`clamp(L − 2 + floor(rand(1)×5), 2, 100)`，再叠加诱饵等级加成（上限 100）。
 * L = 玩家队伍（链上 IDLE）最高等级，无队伍按 5 计（docs/backend-api.md §2）。
 */
export function deriveWildLevel(stream: DeriveStream, teamTopLevel = DEFAULT_TEAM_TOP_LEVEL, levelBonus = 0): number {
  const base = teamTopLevel - 2 + Math.floor(stream.at(1) * 5);
  return Math.min(100, Math.max(2, base + levelBonus));
}

export function deriveWild(
  stream: DeriveStream,
  teamTopLevel = DEFAULT_TEAM_TOP_LEVEL,
  levelBonus = 0,
): { species: SpeciesDef; level: number } {
  const species = WILD_TABLE[Math.floor(stream.at(0) * WILD_TABLE.length) % WILD_TABLE.length];
  return { species, level: deriveWildLevel(stream, teamTopLevel, levelBonus) };
}

export interface CaptureDerivation {
  success: boolean;
  catchRoll: number;
  threshold: number;
  ivs: PokemonIvs;
  nature: string;
  shiny: boolean;
  shakes: number;
}

/** 一次投球的判定结果（attempt 块 +0/+9），与投出前的概率阈值对照。 */
export interface CaptureRoll {
  success: boolean;
  catchRoll: number;
  threshold: number;
  shakes: number;
}

/** 捕捉概率 → attempt k 的派生判定（块 +0 捕捉判定、+9 摇晃次数）。 */
export function deriveCaptureRoll(
  stream: DeriveStream,
  attempt: number,
  probability: number,
): CaptureRoll {
  const base = ATTEMPT_BASE + (attempt - 1) * ATTEMPT_BLOCK;
  const catchRoll = stream.at(base);
  return {
    success: catchRoll < probability,
    catchRoll,
    threshold: probability,
    shakes: 1 + Math.floor(stream.at(base + 9) * 3),
  };
}

/** 快速捕捉路径：满血投球（概率 = captureProbability(1, 1, catchRate, ballBonus)）。 */
export function deriveAttempt(
  stream: DeriveStream,
  attempt: number,
  catchRate: number,
  ballBonus: number,
  shinyChance = SHINY_CHANCE,
): CaptureDerivation {
  const base = ATTEMPT_BASE + (attempt - 1) * ATTEMPT_BLOCK;
  const roll = deriveCaptureRoll(stream, attempt, captureProbability(1, 1, catchRate, ballBonus));
  const ivOf = (n: number) => Math.floor(stream.at(n) * 32);
  const ivs: PokemonIvs = {
    hp: ivOf(base + 1),
    atk: ivOf(base + 2),
    def: ivOf(base + 3),
    spatk: ivOf(base + 4),
    spdef: ivOf(base + 5),
    speed: ivOf(base + 6),
  };
  const nature = NATURES[Math.floor(stream.at(base + 7) * NATURES.length) % NATURES.length];
  const shiny = stream.at(base + 8) < shinyChance;
  return { ...roll, ivs, nature, shiny };
}

/** 野怪战斗的个体样本（整场会话固定，捕捉成功后直接用于 MintFromCapture）。 */
export interface WildSpecimen {
  ivs: PokemonIvs;
  nature: string;
  shiny: boolean;
}

export function deriveWildSpecimen(stream: DeriveStream, shinyChance = SHINY_CHANCE): WildSpecimen {
  const ivOf = (n: number) => Math.floor(stream.at(WILD_MON_BASE + n) * 32);
  const ivs: PokemonIvs = {
    hp: ivOf(0),
    atk: ivOf(1),
    def: ivOf(2),
    spatk: ivOf(3),
    spdef: ivOf(4),
    speed: ivOf(5),
  };
  const nature = NATURES[Math.floor(stream.at(WILD_MON_BASE + 6) * NATURES.length) % NATURES.length];
  const shiny = stream.at(WILD_MON_BASE + 7) < shinyChance;
  return { ivs, nature, shiny };
}

/** 野怪战斗掉落概率（20% 掉落一件道具）。 */
export const WILD_DROP_CHANCE = 0.2;

/** 掉落品类表：按 +1 槽的累计区间映射（60% 伤药 / 30% 精灵球 / 10% 超级球）。 */
export const WILD_DROP_TABLE: ReadonlyArray<{ typeId: string; upTo: number }> = [
  { typeId: 'potion', upTo: 0.6 },
  { typeId: 'poke-ball', upTo: 0.9 },
  { typeId: 'great-ball', upTo: 1 },
];

export interface WildDrop {
  typeId: string;
  quantity: number;
}

/**
 * 野怪战斗掉落（40000 区，docs/randomness.md §3）：收服成功或击倒野怪时各读一次。
 * 同一 eventId 的两种收尾互斥，因此共用 +0/+1 两个槽位；不掉落返回 null。
 */
export function deriveWildDrop(stream: DeriveStream): WildDrop | null {
  if (!(stream.at(WILD_DROP_BASE) < WILD_DROP_CHANCE)) return null;
  const roll = stream.at(WILD_DROP_BASE + 1);
  const entry = WILD_DROP_TABLE.find((e) => roll < e.upTo) ?? WILD_DROP_TABLE[WILD_DROP_TABLE.length - 1];
  return { typeId: entry.typeId, quantity: 1 };
}

/** 攻方一次攻击的五次掷点（命中/暴击/伤害浮动 + 麻痹检查 + 追加效果），顺序与战斗引擎一致。 */
export interface AttackRolls {
  /** 麻痹检查（仅麻痹者使用，< 0.25 → 无法行动） */
  par: number;
  hit: number;
  crit: number;
  factor: number;
  /** 追加效果判定（仅带 stat/status 效果的技能使用） */
  effect: number;
}

/** 一个野怪回合的掷点：先手按最终速度判定，平速用 tieBreak。 */
export interface WildTurnRolls {
  wildMoveRoll: number;
  player: AttackRolls;
  wild: AttackRolls;
  tieBreak: number;
}

export function deriveWildTurn(stream: DeriveStream, turn: number): WildTurnRolls {
  const base = WILD_TURN_BASE + (turn - 1) * WILD_TURN_BLOCK;
  return {
    wildMoveRoll: stream.at(base),
    player: {
      par: stream.at(base + 1),
      hit: stream.at(base + 2),
      crit: stream.at(base + 3),
      factor: stream.at(base + 4),
      effect: stream.at(base + 5),
    },
    wild: {
      par: stream.at(base + 6),
      hit: stream.at(base + 7),
      crit: stream.at(base + 8),
      factor: stream.at(base + 9),
      effect: stream.at(base + 10),
    },
    tieBreak: stream.at(base + 11),
  };
}

export function computeDnaHash(
  speciesId: number,
  ivs: PokemonIvs,
  nature: string,
  shiny: boolean,
  eventId: string,
): string {
  return sha256hex(
    `${speciesId}|${ivs.hp},${ivs.atk},${ivs.def},${ivs.spatk},${ivs.spdef},${ivs.speed}|${nature}|${shiny}|${eventId}`,
  );
}
