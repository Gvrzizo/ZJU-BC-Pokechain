/**
 * 积分经济的权威口径（docs/backend-api.md §10「积分经济」）。
 *
 * 积分是链上游戏发行资产：只能由 admin/system 身份经 PlayerContract.AddPoints 增减，
 * 每笔都带可审计的 reason。玩家侧来源：注册 1000 / 收服野怪 20 / 击倒野怪 等级×1 /
 * 放生宝可梦 等级×1 / 对战押注赢取 / 积分场（arena）/ admin 投放；
 * 消耗：训练、付费诱饵、押注、**积分场准入、宝可梦中心治疗、商店购买**。
 *
 * 2026-09 重平衡：休闲玩家日收入约 100–300P（野怪 + 排位），商店稀有道具（高级球/王冠）
 * 因此成为 2-3 天到月级的积累目标（见 docs/backend-api.md §3 商店价目表）。
 */

/** 收服野怪成功（快速捕捉与野怪战斗两条路径共用）。 */
export const CATCH_REWARD_POINTS = 20;

/** 击倒野怪：野怪等级 × 该系数（1 级 1 分：野生 2-10 级，单次收益个位数）。 */
export const WILD_FAINT_POINTS_PER_LEVEL = 1;

/** 放生宝可梦：等级 × 该系数（放生是"清仓"而不是刷分手段）。 */
export const RELEASE_POINTS_PER_LEVEL = 1;

/** 改名：第一次免费，之后每次 50 积分（sink；docs/backend-api.md §2「改名」）。 */
export const RENAME_COST = 50;

/** 第 `ordinal` 次改名的扣费 reason（ordinal 从 1 起，第 1 次免费不产生流水）。 */
export function renameReason(pokemonId: string, ordinal: number): string {
  return `rename:${pokemonId}:${ordinal}`;
}

/**
 * 第 `ordinal` 次改名的确定性幂等键。链上幂等记录是**全局命名空间**
 * （`idemp:<key>`，与交易类型无关），扣费与 `ApplyGrowth` 必须用不同的键，
 * 否则第二笔会命中第一笔的结果。重试同一请求两笔都按首次结果返回，不会重复扣分。
 */
export function renameIdemKey(pokemonId: string, ordinal: number): string {
  return `${pokemonId}-rename-${ordinal}`;
}

export function renameChargeIdemKey(pokemonId: string, ordinal: number): string {
  return `${pokemonId}-rename-${ordinal}-charge`;
}

export function catchRewardReason(pokemonId: string): string {
  return `reward:catch:${pokemonId}`;
}

export function wildFaintRewardReason(sessionId: string): string {
  return `reward:wild-faint:${sessionId}`;
}

export function releaseRewardReason(pokemonId: string): string {
  return `reward:release:${pokemonId}`;
}
