import { BattleEngine, EngineAction, Side } from './engine/battle-engine';

/**
 * Client battle action as sent over `battle:action` (docs/backend-api.md §5).
 * The client only ever sees assets (move ids, pokemon ids), while the engine is
 * slot-indexed, so ids are resolved against the battle state here.
 */
export interface ClientBattleAction {
  type?: string;
  /** move id, e.g. 'thunderbolt' (publicState sends the active mon's move ids) */
  moveId?: string;
  /** engine-native move slot; accepted for engine-level callers */
  moveIndex?: number;
  /** switch target pokemon id */
  targetPokemonId?: string;
  /** engine-native team slot; accepted for engine-level callers */
  toIndex?: number;
  itemId?: string;
}

function asIndex(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : -1;
}

/** Translate a client action into the engine's index-based action. Throws `CODE: detail`. */
export function toEngineAction(engine: BattleEngine, side: Side, action: ClientBattleAction): EngineAction {
  if (!action || typeof action.type !== 'string') throw new Error('BAD_ACTION: action.type is required');
  switch (action.type) {
    case 'move': {
      const moves = engine.active(side).moves;
      const index =
        typeof action.moveId === 'string'
          ? moves.findIndex((m) => m.id === action.moveId)
          : asIndex(action.moveIndex);
      if (index < 0) {
        throw new Error(`UNKNOWN_MOVE: ${action.moveId ?? action.moveIndex} is not available to the active pokemon`);
      }
      return { type: 'move', moveIndex: index };
    }
    case 'switch': {
      const index =
        typeof action.targetPokemonId === 'string'
          ? engine.team(side).findIndex((m) => m.pokemonId === action.targetPokemonId)
          : asIndex(action.toIndex);
      if (index < 0) {
        throw new Error(`UNKNOWN_POKEMON: ${action.targetPokemonId ?? action.toIndex} is not in your team`);
      }
      return { type: 'switch', toIndex: index };
    }
    case 'run':
      return { type: 'run' };
    case 'item':
      // the engine has no in-battle item effects yet; rejecting it beats the old
      // behaviour of silently burning the turn on a no-op action
      throw new Error('ITEM_NOT_SUPPORTED: items cannot be used during a PvP turn');
    default:
      throw new Error(`BAD_ACTION: unknown action type '${action.type}'`);
  }
}
