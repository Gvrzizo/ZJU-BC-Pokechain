import { PokeType } from './type-chart';

/** 能力阶级可变的五项（HP 无阶级，官方口径） */
export type StatStageKey = 'atk' | 'def' | 'spatk' | 'spdef' | 'speed';

/** 本作简化的三种异常状态：灼伤（brn）/ 中毒（psn）/ 麻痹（par） */
export type StatusCondition = 'brn' | 'psn' | 'par';

/**
 * 追加效果（适度简化，最多一个）：命中后按 chance 掷点触发（见 docs/randomness.md §4）。
 * - stat：能力阶级 ±6，乘率正阶 (2+s)/2、负阶 2/(2-s)（如 特防-1 → ×2/3）
 * - status：写入异常状态，同类不叠加；brn/psn 回合末扣 maxHP/16，par 速度减半且 25% 不能行动
 * - drain：按造成伤害的比例回复自身
 * - recoil：按造成伤害的比例反伤自身
 */
export type MoveEffect =
  | { kind: 'stat'; stat: StatStageKey; stages: number; target: 'self' | 'foe'; chance: number }
  | { kind: 'status'; status: StatusCondition; chance: number }
  | { kind: 'drain'; ratio: number }
  | { kind: 'recoil'; ratio: number };

export interface MoveDef {
  id: string;
  name: string;
  type: PokeType;
  power: number;
  /** percent 0-100 */
  accuracy: number;
  category: 'physical' | 'special';
  /** 中文效果简述（战斗界面悬停说明行；纯伤害技能也会说明"无追加效果"） */
  effectText: string;
  /** 结构化追加效果；null = 纯伤害技能 */
  effect?: MoveEffect | null;
}

/** [id, 英文名, 属性, 威力, 命中, 分类, 效果说明, 结构化效果] */
type MoveRow = [
  string,
  string,
  PokeType,
  number,
  number,
  'physical' | 'special',
  string,
  MoveEffect | null,
];

const PURE = '纯伤害技能，没有追加效果。';

export const MOVES: Record<string, MoveDef> = Object.fromEntries(
  (
    [
      ['tackle', 'Tackle', 'normal', 40, 100, 'physical', PURE, null],
      ['quick-attack', 'Quick Attack', 'normal', 40, 100, 'physical', PURE, null],
      ['body-slam', 'Body Slam', 'normal', 85, 100, 'physical', '造成伤害，30% 几率使目标麻痹。', { kind: 'status', status: 'par', chance: 30 }],
      ['hyper-beam', 'Hyper Beam', 'normal', 150, 90, 'special', '高威力纯伤害技能（简化引擎不模拟下一回合无法行动）。', null],
      ['thunder-shock', 'Thunder Shock', 'electric', 40, 100, 'special', '造成伤害，10% 几率使目标麻痹。', { kind: 'status', status: 'par', chance: 10 }],
      ['spark', 'Spark', 'electric', 65, 100, 'physical', '造成伤害，30% 几率使目标麻痹。', { kind: 'status', status: 'par', chance: 30 }],
      ['thunderbolt', 'Thunderbolt', 'electric', 90, 100, 'special', '造成伤害，10% 几率使目标麻痹。', { kind: 'status', status: 'par', chance: 10 }],
      ['thunder', 'Thunder', 'electric', 110, 70, 'special', '造成伤害，30% 几率使目标麻痹。', { kind: 'status', status: 'par', chance: 30 }],
      ['ember', 'Ember', 'fire', 40, 100, 'special', '造成伤害，10% 几率使目标灼伤。', { kind: 'status', status: 'brn', chance: 10 }],
      ['fire-fang', 'Fire Fang', 'fire', 65, 95, 'physical', '造成伤害，10% 几率使目标灼伤。', { kind: 'status', status: 'brn', chance: 10 }],
      ['flamethrower', 'Flamethrower', 'fire', 90, 100, 'special', '造成伤害，10% 几率使目标灼伤。', { kind: 'status', status: 'brn', chance: 10 }],
      ['fire-blast', 'Fire Blast', 'fire', 110, 85, 'special', '造成伤害，10% 几率使目标灼伤。', { kind: 'status', status: 'brn', chance: 10 }],
      ['water-gun', 'Water Gun', 'water', 40, 100, 'special', PURE, null],
      ['aqua-tail', 'Aqua Tail', 'water', 90, 90, 'physical', PURE, null],
      ['surf', 'Surf', 'water', 90, 100, 'special', PURE, null],
      ['hydro-pump', 'Hydro Pump', 'water', 110, 80, 'special', PURE, null],
      ['vine-whip', 'Vine Whip', 'grass', 45, 100, 'physical', PURE, null],
      ['razor-leaf', 'Razor Leaf', 'grass', 55, 95, 'physical', PURE, null],
      ['solar-beam', 'Solar Beam', 'grass', 120, 100, 'special', '高威力纯伤害技能（简化引擎不模拟充能回合）。', null],
      ['psybeam', 'Psybeam', 'psychic', 65, 100, 'special', '纯伤害技能（简化引擎不模拟混乱）。', null],
      ['psychic', 'Psychic', 'psychic', 90, 100, 'special', '造成伤害，10% 几率使目标特防 -1。', { kind: 'stat', stat: 'spdef', stages: -1, target: 'foe', chance: 10 }],
      ['bite', 'Bite', 'dark', 60, 100, 'physical', '纯伤害技能（简化引擎不模拟畏缩）。', null],
      ['crunch', 'Crunch', 'dark', 80, 100, 'physical', '造成伤害，20% 几率使目标防御 -1。', { kind: 'stat', stat: 'def', stages: -1, target: 'foe', chance: 20 }],
      ['dark-pulse', 'Dark Pulse', 'dark', 80, 100, 'special', '纯伤害技能（简化引擎不模拟畏缩）。', null],
      // 第三世代常用技能（图鉴 #1–386 生成技能的属性匹配池，官方威力/命中/分类）
      ['absorb', 'Absorb', 'grass', 20, 100, 'special', '造成伤害，按伤害的 50% 回复自身 HP。', { kind: 'drain', ratio: 0.5 }],
      ['giga-drain', 'Giga Drain', 'grass', 75, 100, 'special', '造成伤害，按伤害的 50% 回复自身 HP。', { kind: 'drain', ratio: 0.5 }],
      ['leaf-blade', 'Leaf Blade', 'grass', 90, 100, 'physical', '纯伤害技能（简化引擎不模拟易击中要害）。', null],
      ['blaze-kick', 'Blaze Kick', 'fire', 85, 90, 'physical', '造成伤害，10% 几率使目标灼伤。', { kind: 'status', status: 'brn', chance: 10 }],
      ['dragon-claw', 'Dragon Claw', 'dragon', 80, 100, 'physical', PURE, null],
      ['dragon-breath', 'Dragon Breath', 'dragon', 60, 100, 'special', '造成伤害，30% 几率使目标麻痹。', { kind: 'status', status: 'par', chance: 30 }],
      ['fly', 'Fly', 'flying', 90, 95, 'physical', '高威力纯伤害技能（简化引擎不模拟蓄力飞行）。', null],
      ['wing-attack', 'Wing Attack', 'flying', 60, 100, 'physical', PURE, null],
      ['ice-beam', 'Ice Beam', 'ice', 90, 100, 'special', '纯伤害技能（简化引擎不模拟冰冻）。', null],
      ['earthquake', 'Earthquake', 'ground', 100, 100, 'physical', '高威力纯伤害技能。', null],
      ['shadow-ball', 'Shadow Ball', 'ghost', 80, 100, 'special', '造成伤害，20% 几率使目标特防 -1。', { kind: 'stat', stat: 'spdef', stages: -1, target: 'foe', chance: 20 }],
      ['silver-wind', 'Silver Wind', 'bug', 60, 100, 'special', '纯伤害技能（简化引擎不模拟全能力提升）。', null],
      ['brick-break', 'Brick Break', 'fighting', 75, 100, 'physical', PURE, null],
      ['iron-tail', 'Iron Tail', 'steel', 100, 75, 'physical', '造成伤害，30% 几率使目标防御 -1。', { kind: 'stat', stat: 'def', stages: -1, target: 'foe', chance: 30 }],
      ['metal-claw', 'Metal Claw', 'steel', 50, 95, 'physical', '造成伤害，10% 几率使自身攻击 +1。', { kind: 'stat', stat: 'atk', stages: 1, target: 'self', chance: 10 }],
      ['dig', 'Dig', 'ground', 80, 100, 'physical', '纯伤害技能（简化引擎不模拟蓄力钻地）。', null],
      ['sludge-bomb', 'Sludge Bomb', 'poison', 90, 100, 'special', '造成伤害，30% 几率使目标中毒。', { kind: 'status', status: 'psn', chance: 30 }],
      ['poison-sting', 'Poison Sting', 'poison', 15, 100, 'physical', '造成伤害，30% 几率使目标中毒。', { kind: 'status', status: 'psn', chance: 30 }],
      ['rock-slide', 'Rock Slide', 'rock', 75, 90, 'physical', '纯伤害技能（简化引擎不模拟畏缩）。', null],
    ] as MoveRow[]
  ).map(([id, name, type, power, accuracy, category, effectText, effect]) => [
    id,
    { id, name, type, power, accuracy, category, effectText, effect },
  ]),
);

export function getMove(id: string): MoveDef | undefined {
  return MOVES[id];
}
