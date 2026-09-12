/**
 * 出战队伍勾选的公共口径（WagerPicker / RankedView 共用）：
 * 队伍 1-6 只（与后端 TEAM_SIZE_MAX 一致，docs/backend-api.md §5/§11），
 * 超过上限的勾选被忽略（由调用方给出提示），已在队伍里的再点一次即取消。
 */
export const TEAM_SIZE_MAX = 6;

export interface TeamToggleResult {
  /** 勾选后的队伍（超限时原样返回） */
  team: string[];
  /** true = 这次勾选因为超出上限被忽略 */
  rejected: boolean;
}

export function toggleTeamMember(team: string[], id: string, max = TEAM_SIZE_MAX): TeamToggleResult {
  if (team.includes(id)) return { team: team.filter((x) => x !== id), rejected: false };
  if (team.length >= max) return { team, rejected: true };
  return { team: [...team, id], rejected: false };
}
