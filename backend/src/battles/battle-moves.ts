import { MOVES, MoveDef } from '../game-data/moves.data';
import { PokeType } from '../game-data/type-chart';

/** Skill metadata for the battle screen: name/威力/命中/属性/说明 (docs/backend-api.md §5). */
export interface BattleMoveInfo {
  id: string;
  name: string;
  type: PokeType;
  power: number;
  /** percent 0-100 */
  accuracy: number;
  category: 'physical' | 'special';
  /** 中文效果说明（game-data/moves.data 的 effectText，纯伤害技能也会说明无追加效果） */
  effectText: string;
}

export function battleMoveInfo(move: MoveDef): BattleMoveInfo {
  return {
    id: move.id,
    name: move.name,
    type: move.type,
    power: move.power,
    accuracy: move.accuracy,
    category: move.category,
    effectText: move.effectText ?? '',
  };
}

/** 全量技能元数据（静态表；战斗界面按 id 索引展示） */
export function battleMoveCatalog(): BattleMoveInfo[] {
  return Object.values(MOVES).map(battleMoveInfo);
}
