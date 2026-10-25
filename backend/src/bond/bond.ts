/**
 * 羁绊规则（docs/backend-api.md §11）：参战队伍在链上 SETTLED 后按战果 +羁绊。
 *
 * **长线化（2026-09 重平衡）**：陪伴感应以"月"为单位，不再是一场下午刷满——
 * 赢家队 +2、输家队 +1、平局双方 +1（陪伴无关胜负）；机器人场减半后向下取整（胜 +1、负/平 +0）；
 * 野怪战斗只有**收服成功 +1**（击倒不给）；另有**每日每宠 +6 硬上限**（见 BOND_DAILY_CAP）。
 * 从铸造 50 到 255 至少需要 205 点，即使每天全勤（6/天）也要 35 天以上，实战节奏 6 周+。
 *
 * 幂等键由 battleId / sessionId 推导（BondUp 链上幂等），重放不会重复加分。
 */
export const BOND_PVP_WIN = 2;
export const BOND_PVP_LOSS = 1;

/**
 * 每日每宠羁绊上限（跨 PvP 与野怪统一计）：Redis `bond:day:<pokemonId>:<yyyy-mm-dd>`
 * 是用 `HSETNX` 记账的哈希（field = 各次 BondUp 的 idemKey、value = 实际发放值），
 * 同日重放同一场不会重复占用额度；超出上限的部分**截断**（不足 1 点即不发放）。
 */
export const BOND_DAILY_CAP = 6;

/** 每日记账键 TTL：两天（跨天后自然失效，与积分场补贴计数同口径）。 */
export const BOND_DAILY_TTL_SEC = 2 * 24 * 3600;

/** 每日记账键：`bond:day:<pokemonId>:<yyyy-mm-dd>`（UTC 日期，确定性） */
export function bondDailyKey(pokemonId: string, date: string): string {
  return `bond:day:${pokemonId}:${date}`;
}

/** BondUp 单次最多 100 个 id（chaincode-api.md §2.3），留出余量分块提交 */
export const BOND_BATCH = 50;

export type BondSide = 'A' | 'B';

/** 一只宝可梦的羁绊变化（仅列出真正被提升的） */
export interface BondChange {
  pokemonId: string;
  speciesId: number;
  name: string;
  side: 'A' | 'B';
  result: 'WIN' | 'LOSS' | 'DRAW';
  before: number;
  after: number;
  delta: number;
}

/** 一次 BondUp 调用（一个阵营的一批宝可梦） */
export interface BondGrant {
  side: BondSide;
  delta: number;
  /** 链上 reason（可审计）：`bond:pvp:<battleId>` */
  reason: string;
  /** idemKey 前缀，分块提交时按块序号派生 */
  idemKey: string;
  pokemonIds: string[];
}

export function bondReasonPvp(battleId: string): string {
  return `bond:pvp:${battleId}`;
}

/** 按战果把两支队伍拆成 BondUp 调用（winnerSide=null 即平局）。
 * `scale` 用于机器人场等奖励减半场景：变化量 ×系数 后**向下取整**（+2→+1、+1→+0）。 */
export function pvpBondGrants(
  battleId: string,
  teams: { A: string[]; B: string[] },
  winnerSide: BondSide | null,
  opts: { scale?: number } = {},
): BondGrant[] {
  const reason = bondReasonPvp(battleId);
  const scale = opts.scale ?? 1;
  const scaled = (base: number) => Math.max(0, Math.floor(base * scale));
  const side = (s: BondSide, delta: number, key: string): BondGrant | null =>
    teams[s].length > 0 ? { side: s, delta: scaled(delta), reason, idemKey: `${battleId}-${key}`, pokemonIds: teams[s] } : null;
  const grants =
    winnerSide === null
      ? [side('A', BOND_PVP_LOSS, 'bond-draw-a'), side('B', BOND_PVP_LOSS, 'bond-draw-b')]
      : [
          side(winnerSide, BOND_PVP_WIN, 'bond-win'),
          side(winnerSide === 'A' ? 'B' : 'A', BOND_PVP_LOSS, 'bond-lose'),
        ];
  return grants.filter((g): g is BondGrant => g !== null && g.delta > 0);
}

/** 把一批 id 按 BOND_BATCH 切块（BondUp 上限保护） */
export function bondBatches(pokemonIds: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < pokemonIds.length; i += BOND_BATCH) {
    out.push(pokemonIds.slice(i, i + BOND_BATCH));
  }
  return out;
}

/**
 * 野怪战斗（PvE）羁绊：**收服成功出战宝可梦 +1**（每日每宠上限 +6），**击倒不给**（0）。
 * 幂等键 `<sessionId>-bond-<catch|faint>`：同一场野怪战斗重放不会重复加分。
 */
export const BOND_WILD_CATCH = 1;
export const BOND_WILD_FAINT = 0;

export type WildBondKind = 'catch' | 'faint';

export function wildBondDelta(kind: WildBondKind): number {
  return kind === 'catch' ? BOND_WILD_CATCH : BOND_WILD_FAINT;
}

/** 链上 reason（可审计）：`bond:wild-catch:<sessionId>` / `bond:wild-faint:<sessionId>` */
export function wildBondReason(kind: WildBondKind, sessionId: string): string {
  return kind === 'catch' ? `bond:wild-catch:${sessionId}` : `bond:wild-faint:${sessionId}`;
}

export function wildBondIdemKey(kind: WildBondKind, sessionId: string): string {
  return `${sessionId}-bond-${kind}`;
}

/**
 * 每日额度：`used` 为今日已发放值、`granted` 为本次希望发放值，
 * 返回**截断后**实际可发放值（0 = 今天这只已经刷满）。
 */
export function bondDailyAllowance(used: number, wanted: number): number {
  if (wanted <= 0) return 0;
  return Math.max(0, Math.min(wanted, BOND_DAILY_CAP - Math.max(0, used)));
}
