import { randomBytes } from 'crypto';
import { DeriveStream } from '../common/utils/crypto.util';
import { utcDate } from '../common/utils/time.util';
import { EngineAction, EngineMonInput } from '../battles/engine/battle-engine';
import { MoveDef } from '../game-data/moves.data';
import { NATURES } from '../game-data/natures.data';
import { getLearnset } from '../game-data/learnsets.data';
import { getSpecies, WILD_TABLE } from '../game-data/species.data';

/**
 * 练习机器人（docs/backend-api.md §11）：排队 60 秒没有真人时给玩家的 PvE 对手。
 *
 * - 链上注册一个共享的 `BOT` 玩家（RegisterPlayer 幂等，初始 rating 1000）；
 * - 队伍按玩家队伍平均等级 ±2 生成 3 只，种族从野生池随机，**只在内存里存在、不上链**；
 * - 出招由服务端代打：从该对局的 RandomCommit 派生流（偏移 100000 起，与引擎顺序游标
 *   互不干扰）随机挑一个合法技能，普通伤害招优先；
 * - **羁绊/经验减半**、且每人每天最多 5 场；**rating 增益为 0**（H12：机器人场零风险，
 *   给分会让玩家 20 天零风险到大师，改由真人场决定段位）。
 */
export const BOT_PLAYER_ID = 'BOT';
export const BOT_NICKNAME = '训练家机器人';
/** 机器人队伍规模（固定 3 只） */
export const BOT_TEAM_SIZE = 3;
/** 机器人等级相对玩家队伍平均等级的浮动幅度（±N） */
export const BOT_LEVEL_SPREAD = 2;
/** 每人每天可打的机器人场次上限 */
export const BOT_DAILY_LIMIT = 5;
/** 排队满 60 秒才出现机器人选项 */
export const BOT_OFFER_AFTER_MS = 60_000;
/** 机器人场的羁绊/经验系数（减半，四舍五入） */
export const BOT_REWARD_SCALE = 0.5;
/** 机器人场的 rating 系数：0 = 不改变排位分（H12）。 */
export const BOT_RATING_SCALE = 0;
/** 机器人接受出招前的思考时间（演示观感；出招本身来自派生流） */
export const BOT_MOVE_DELAY_MS = 700;
/** 机器人出招用的派生流偏移区：base + turn × block，避开引擎从 0 递增的顺序游标 */
export const BOT_STREAM_BASE = 100_000;
export const BOT_STREAM_BLOCK = 8;

/** 机器人队伍的内存 id（不上链，只在对局引擎与事件里出现） */
export function botPokemonId(battleId: string, index: number): string {
  return `bot_${battleId}_${index + 1}`;
}

/** 机器人场计数键（每人每天） */
export function botDailyKey(playerId: string, date?: string): string {
  return `ranked:bot:${playerId}:${date ?? utcDate()}`;
}

/** 每日上限的日期分界（UTC，确定性）；实现见 common/utils/time.util.ts */
export { utcDate } from '../common/utils/time.util';

/** 玩家队伍平均等级（无队伍按 5 计，与野怪口径一致） */
export function averageLevel(levels: number[], fallback = 5): number {
  if (levels.length === 0) return fallback;
  return levels.reduce((sum, lv) => sum + lv, 0) / levels.length;
}

/**
 * 机器人三只的等级：平均等级 ±2（roll ∈ [0,1)），夹在 2-100。
 * 与 `buildBotTeam` 分开是为了单测不经派生流直接校验等级区间。
 */
export function botLevel(avgLevel: number, roll: number): number {
  const offset = Math.round((roll * 2 - 1) * BOT_LEVEL_SPREAD);
  return Math.min(100, Math.max(2, Math.round(avgLevel) + offset));
}

/** 某等级下该种族的技能（学习表里等级已达标的最后 4 条；缺省回退种族自带技能表） */
export function botMovesAt(speciesId: number, level: number): string[] {
  const known = getLearnset(speciesId)
    .filter((entry) => entry.level <= level)
    .map((entry) => entry.moveId);
  const moves = known.length > 0 ? known.slice(-4) : (getSpecies(speciesId)?.defaultMoves ?? []);
  return moves.slice(0, 4);
}

/**
 * 生成机器人队伍（内存临时实体，不上链）：等级按玩家队伍平均等级 ±2，
 * 种族从野生池随机，个体值/性格来自本地随机种子（记录在排位房留痕里，可复核）。
 */
export function buildBotTeam(input: {
  battleId: string;
  avgLevel: number;
  seed?: string;
}): { team: EngineMonInput[]; seed: string } {
  const seed = input.seed ?? randomBytes(32).toString('hex');
  const stream = new DeriveStream(seed, input.battleId, 'bot-team');
  const team: EngineMonInput[] = [];
  for (let i = 0; i < BOT_TEAM_SIZE; i += 1) {
    const base = i * 8;
    const species = WILD_TABLE[Math.floor(stream.at(base) * WILD_TABLE.length) % WILD_TABLE.length];
    const level = botLevel(input.avgLevel, stream.at(base + 1));
    team.push({
      pokemonId: botPokemonId(input.battleId, i),
      speciesId: species.id,
      level,
      ivs: {
        hp: Math.floor(stream.at(base + 2) * 32),
        atk: Math.floor(stream.at(base + 3) * 32),
        def: Math.floor(stream.at(base + 4) * 32),
        spatk: Math.floor(stream.at(base + 5) * 32),
        spdef: Math.floor(stream.at(base + 6) * 32),
        speed: Math.floor(stream.at(base + 7) * 32),
      },
      evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 },
      nature: NATURES[Math.floor(stream.at(base + 8) * NATURES.length) % NATURES.length],
      moves: botMovesAt(species.id, level),
    });
  }
  return { team, seed };
}

/**
 * 机器人一次出招：mustSwitch（当前宝可梦倒下）时换上一只存活队友，
 * 否则从**普通伤害招**（power > 0）里随机挑一个——没有伤害招就用全部技能。
 * 纯函数：roll ∈ [0,1) 来自该对局派生流。
 */
export function pickBotAction(input: {
  moves: MoveDef[];
  team: Array<{ hp: number }>;
  activeIndex: number;
  mustSwitch: boolean;
  roll: number;
  switchRoll?: number;
}): EngineAction {
  if (input.mustSwitch) {
    const alive = input.team
      .map((mon, index) => ({ mon, index }))
      .filter(({ mon, index }) => mon.hp > 0 && index !== input.activeIndex);
    if (alive.length > 0) {
      const pick = alive[Math.floor((input.switchRoll ?? input.roll) * alive.length) % alive.length];
      return { type: 'switch', toIndex: pick.index };
    }
  }
  const damaging = input.moves
    .map((move, index) => ({ move, index }))
    .filter(({ move }) => move.power > 0);
  const pool = damaging.length > 0 ? damaging : input.moves.map((move, index) => ({ move, index }));
  const pick = pool[Math.floor(input.roll * pool.length) % pool.length];
  return { type: 'move', moveIndex: pick.index };
}

/** 机器人第 turn 回合的掷点（move=出招选择、switch=换宠选择），来自对局派生流 */
export function botTurnRolls(stream: DeriveStream, turn: number): { move: number; switch: number } {
  const base = BOT_STREAM_BASE + turn * BOT_STREAM_BLOCK;
  return { move: stream.at(base), switch: stream.at(base + 1) };
}
