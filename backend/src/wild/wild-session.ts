import { RedisService } from '../common/redis/redis.service';
import { ZoneId } from '../game-data/encounter.data';
import { MoveDef, StatStageKey, StatusCondition } from '../game-data/moves.data';
import { PokeType } from '../game-data/type-chart';
import { PokemonState, PokemonIvs } from '../fabric/chain.types';

/** 野怪战斗会话 TTL：15 分钟无操作即到期（到期后任何访问返回 TIMEOUT 终态，Redis 自动回收）。 */
export const WILD_SESSION_TTL_SEC = 900;

export type WildStatus =
  | 'ACTIVE'
  | 'CAUGHT'
  | 'WILD_FAINTED'
  | 'PLAYER_FAINTED'
  | 'RAN'
  | 'TIMEOUT';

/** 野怪战斗的一方（整份会话直接 JSON 存 Redis）。 */
export interface WildCombatant {
  /** 链上宝可梦 id；野怪只存在于会话中，为空串 */
  pokemonId: string;
  speciesId: number;
  name: string;
  nameZh: string;
  type: PokeType;
  level: number;
  shiny: boolean;
  ivs: PokemonIvs;
  nature: string;
  maxHp: number;
  hp: number;
  atk: number;
  def: number;
  spatk: number;
  spdef: number;
  speed: number;
  moves: MoveDef[];
  /** 能力阶级（±6，战斗内累积；换下场的宝可梦保留） */
  stages: Record<StatStageKey, number>;
  /** 异常状态（brn/psn/par；同类不叠加，换下场保留） */
  status: StatusCondition | null;
  /** 链上经验值（队伍成员；野怪恒为 0） */
  exp: number;
  /** 链上羁绊值（队伍成员；野怪恒为 0） */
  bond: number;
}

export interface WildBattleEvent {
  kind:
    | 'encounter'
    | 'move'
    | 'miss'
    | 'damage'
    | 'faint'
    | 'ball'
    | 'ball-failed'
    | 'caught'
    | 'run'
    | 'timeout'
    | 'end'
    | 'switch'
    | 'paralyzed'
    | 'status'
    | 'status-damage'
    | 'stat'
    | 'drain'
    | 'recoil';
  side?: 'player' | 'wild';
  detail: Record<string, unknown>;
}

export interface WildTurnLog {
  turn: number;
  events: WildBattleEvent[];
}

/** 野怪战斗掉落（40000 区派生，见 capture-derive.ts::deriveWildDrop）：已发放的实物堆叠 */
export interface WildDropGrant {
  typeId: string;
  quantity: number;
  /** 链上堆叠 id（同 typeId 合并后返回的幸存堆叠） */
  itemId: string;
}

export interface WildSession {
  sessionId: string;
  eventId: string;
  playerId: string;
  /** 承诺-揭示种子的会话副本（encounter 时由 CaptureService 写入 capture:<eventId>） */
  serverSeed: string;
  clientSeed: string;
  /** 遇敌区域（从 capture 会话复制；决定击倒奖励：传说区 0 积分，普通区 等级×1） */
  zoneId?: ZoneId;
  turn: number;
  /** 已投出的球数：第 n 次投球消费 attempt 派生块 base=2+(n-1)*10（与快速捕捉共用计数） */
  attempts: number;
  status: WildStatus;
  finished: boolean;
  createdAt: string;
  expiresAt: number;
  expGained: number;
  /** 已下发过经验的那只我方宝可梦（防止换宠后重复发放） */
  expGainedBy?: string;
  /** 本次经验结算提升的等级数（升级学习路径，docs/backend-api.md §2） */
  levelsGained?: number;
  /** 本次经验结算学会的技能（收服 +20 / 击倒经验都走集中升级路径） */
  movesLearned?: string[];
  /** 结算后是否已满足等级进化条件（前端"可以进化！"提示） */
  canEvolve?: boolean;
  /** 本会话已发放的羁绊提升（收服 +1，BondService 每日每宠上限 +6）；未发放时缺省 */
  bondGain?: number;
  /** 羁绊提升的获得者（出战宝可梦 id） */
  bondGainBy?: string;
  /** 本会话收服奖励（+20 积分）；未收服/未发放时缺省 */
  catchReward?: number;
  /** 本会话击倒奖励（普通区野怪等级×1；传说区固定 0）；未击倒/未发放时缺省 */
  faintReward?: number;
  /** 本会话掉落道具（收服或击倒时按 40000 区派生一次，见 capture-derive.ts）；未掉落/未发放时缺省 */
  drop?: WildDropGrant;
  captured?: PokemonState;
  /** 参战队伍：owner 名下 IDLE 且非濒死的宝可梦（等级降序；以链下 Redis 的当前 HP 出战） */
  party: WildCombatant[];
  /** 当前出战成员在 party 中的下标 */
  activeIndex: number;
  /** 我方出战宝可梦濒死且还有可换成员 → 只接受 switch 动作 */
  mustSwitch: boolean;
  wild: WildCombatant;
  log: WildTurnLog[];
}

/** 当前出战的我方成员 */
export function activePokemon(session: WildSession): WildCombatant {
  return session.party[session.activeIndex];
}

export function wildSessionKey(sessionId: string): string {
  return `wild:${sessionId}`;
}

/** eventId → sessionId 索引：同一场遇敌只能开一场野怪战斗（start 幂等）。 */
export function wildEventKey(eventId: string): string {
  return `wild:event:${eventId}`;
}

export async function loadWildSession(
  redis: RedisService,
  sessionId: string,
): Promise<WildSession | null> {
  return redis.getJson<WildSession>(wildSessionKey(sessionId));
}

export async function loadWildSessionByEvent(
  redis: RedisService,
  eventId: string,
): Promise<WildSession | null> {
  const sessionId = await redis.get(wildEventKey(eventId));
  if (!sessionId) return null;
  return loadWildSession(redis, sessionId);
}
