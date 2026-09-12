import { http } from './http';
import type { WildAction, WildMoveOption, WildState } from '@/types';

/**
 * 野怪战斗类型扩展：`types.ts` 是共享契约（并行维护），这里补充本次新增的
 * 队伍/换宠/异常状态与技能效果字段，供 CaptureOverlay 使用。
 */
export interface WildMoveOptionEx extends WildMoveOption {
  /** 中文效果说明（GET /battles/moves 同一份数据） */
  effectText?: string;
}

export interface WildPartyMember {
  pokemonId: string;
  speciesId: number;
  name: string;
  nameZh: string;
  type: string;
  level: number;
  shiny: boolean;
  hp: number;
  maxHp: number;
  exp: number;
  status: string | null;
  fainted: boolean;
  /** 当前出战位 */
  active: boolean;
}

/** 野怪战斗掉落（40000 区派生，收服/击倒结算时发放；无掉落为 null） */
export interface WildDrop {
  typeId: string;
  name: string;
  nameZh: string;
  quantity: number;
  itemId: string;
}

export interface WildStateEx extends Omit<WildState, 'mine' | 'wild'> {
  wild: WildState['wild'] & { status?: string | null; stages?: Record<string, number> };
  mine: Omit<WildState['mine'], 'moves'> & {
    moves: WildMoveOptionEx[];
    status?: string | null;
    stages?: Record<string, number>;
    /** 出战宝可梦的链上羁绊值（结算面板展示收服/击倒加成） */
    bond?: number;
  };
  /** 参战队伍（全部 IDLE，等级降序） */
  party: WildPartyMember[];
  activeIndex: number;
  /** 出战宝可梦濒死且还有可换成员：此时只接受 switch 动作 */
  mustSwitch: boolean;
  expGainedBy?: string | null;
  /** 本次经验结算提升的等级数（收服 +20 / 击倒经验走集中升级路径） */
  levelsGained?: number;
  /** 本次经验结算学会的技能（升级学习表） */
  movesLearned?: string[];
  /** 结算后是否已满足等级进化条件（前端"可以进化！"提示） */
  canEvolve?: boolean;
  /** 本会话已发放的羁绊提升（收服 +1，BondService 每日每宠上限 +6；击倒不给） */
  bondGain?: number;
  bondGainBy?: string | null;
  /** 本次会话已发放的积分奖励：收服 +20 / 击倒 野怪等级×1（docs/backend-api.md §10） */
  catchReward?: number;
  faintReward?: number;
  /** 本次会话掉落的道具（40000 区派生，docs/randomness.md §3）；未掉落为 null */
  drop?: WildDrop | null;
}

/** 换宠动作（types.ts 的 WildAction 只覆盖 move/ball/run） */
export type WildActionEx = WildAction | { type: 'switch'; targetPokemonId: string };

/** 开启野怪战斗（需先 POST /capture/encounter 拿到 eventId）。 */
export async function startWild(eventId: string, partyPokemonId?: string): Promise<WildStateEx> {
  const { data } = await http.post<WildStateEx>('/wild/start', { eventId, partyPokemonId });
  return data;
}

/** 一个回合：出招 / 投球 / 换宠 / 逃跑。服务端权威，返回新状态。 */
export async function wildAction(sessionId: string, action: WildActionEx): Promise<WildStateEx> {
  const { data } = await http.post<WildStateEx>(
    `/wild/${encodeURIComponent(sessionId)}/action`,
    { action },
  );
  return data;
}

export async function getWild(sessionId: string): Promise<WildStateEx> {
  const { data } = await http.get<WildStateEx>(`/wild/${encodeURIComponent(sessionId)}`);
  return data;
}
