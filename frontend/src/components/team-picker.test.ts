import { describe, expect, it } from 'vitest';
import { TEAM_SIZE_MAX, toggleTeamMember } from './team-picker';

describe('出战队伍勾选上限（1-6，docs/backend-api.md §5/§11）', () => {
  it('未满时正常加入 / 取消', () => {
    expect(toggleTeamMember(['p1'], 'p2')).toEqual({ team: ['p1', 'p2'], rejected: false });
    expect(toggleTeamMember(['p1', 'p2'], 'p1')).toEqual({ team: ['p2'], rejected: false });
  });

  it('满 6 只后第 7 只被忽略（队伍不变、给出 rejected 信号）', () => {
    const full = Array.from({ length: TEAM_SIZE_MAX }, (_, i) => `p${i}`);
    const result = toggleTeamMember(full, 'p_extra');
    expect(result.rejected).toBe(true);
    expect(result.team).toEqual(full);
    expect(result.team).toHaveLength(6);
  });

  it('已选中的成员即使满员也能取消（腾出名额后可以再选）', () => {
    const full = Array.from({ length: TEAM_SIZE_MAX }, (_, i) => `p${i}`);
    const removed = toggleTeamMember(full, 'p0');
    expect(removed.rejected).toBe(false);
    expect(toggleTeamMember(removed.team, 'p_extra').team).toHaveLength(TEAM_SIZE_MAX);
  });

  it('自定义上限（测试/复用其它场景）', () => {
    expect(toggleTeamMember([], 'a', 1)).toEqual({ team: ['a'], rejected: false });
    expect(toggleTeamMember(['a'], 'b', 1).rejected).toBe(true);
  });
});
