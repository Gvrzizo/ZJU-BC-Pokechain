/**
 * 排位 ELO（docs/backend-api.md §11）：K=32、期望分 1/(1+10^((rb-ra)/400))，
 * 结算后 rating 取整并夹在链码允许的 0-99999。
 */
export const RANKED_K = 32;
export const RATING_MIN = 0;
export const RATING_MAX = 99999;
/** 匹配窗口：只与 rating 相差不超过该值的对手配对（扩圈起点） */
export const MATCH_WINDOW = 200;
/** 匹配窗口随时间扩圈：每 10 秒 +50，上限 ±1000（docs/backend-api.md §11） */
export const MATCH_WINDOW_BASE = MATCH_WINDOW;
export const MATCH_WINDOW_STEP = 50;
export const MATCH_WINDOW_STEP_MS = 10_000;
export const MATCH_WINDOW_MAX = 1000;
/** 拒绝/超时未接受对局后，匹配窗口重置为 ±200 的时长 */
export const MATCH_WINDOW_RESET_MS = 30_000;

/**
 * 当前匹配窗口（±N）：入队后每满 10 秒扩 50 分，封顶 1000；
 * `resetForMs > 0`（刚拒绝/超时过对局）时窗口回到起点 ±200。
 */
export function matchWindowFor(waitedMs: number, opts: { resetForMs?: number } = {}): number {
  if ((opts.resetForMs ?? 0) > 0) return MATCH_WINDOW_BASE;
  const steps = Math.floor(Math.max(0, waitedMs) / MATCH_WINDOW_STEP_MS);
  return Math.min(MATCH_WINDOW_MAX, MATCH_WINDOW_BASE + steps * MATCH_WINDOW_STEP);
}

export type RankedOutcome = 'A' | 'B' | 'DRAW';

export interface EloResult {
  a: { before: number; after: number; delta: number; expected: number };
  b: { before: number; after: number; delta: number; expected: number };
}

export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

export function clampRating(rating: number): number {
  return Math.max(RATING_MIN, Math.min(RATING_MAX, Math.round(rating)));
}

/**
 * 双方新分数。DRAW 各按 0.5 结算（S=0.5）；胜者 S=1、负者 S=0。
 * 纯函数：给定相同入参永远得到相同结果，供幂等重放使用。
 */
export function eloUpdate(ratingA: number, ratingB: number, outcome: RankedOutcome, k = RANKED_K): EloResult {
  const expectedA = expectedScore(ratingA, ratingB);
  const expectedB = 1 - expectedA;
  const scoreA = outcome === 'DRAW' ? 0.5 : outcome === 'A' ? 1 : 0;
  const scoreB = outcome === 'DRAW' ? 0.5 : outcome === 'B' ? 1 : 0;
  const afterA = clampRating(ratingA + k * (scoreA - expectedA));
  const afterB = clampRating(ratingB + k * (scoreB - expectedB));
  return {
    a: { before: ratingA, after: afterA, delta: afterA - ratingA, expected: round4(expectedA) },
    b: { before: ratingB, after: afterB, delta: afterB - ratingB, expected: round4(expectedB) },
  };
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * 按系数缩放一次 ELO 结果（机器人场全部奖励减半，docs/backend-api.md §11）：
 * 变化量 `delta × factor` 四舍五入后重新夹在 0-99999，期望分保持原值（仅供展示）。
 */
export function scaleElo(result: EloResult, factor: number): EloResult {
  const scale = (side: { before: number; after: number; delta: number; expected: number }) => {
    if (factor === 1) return side;
    const after = clampRating(side.before + Math.round(side.delta * factor));
    return { before: side.before, after, delta: after - side.before, expected: side.expected };
  };
  return { a: scale(result.a), b: scale(result.b) };
}
