import { toEngineAction } from '../src/battles/battle-action';
import { errorCodeOf } from '../src/battles/battle-error';
import { battleMoveCatalog, battleMoveInfo } from '../src/battles/battle-moves';
import { BattleEngine, EngineMonInput } from '../src/battles/engine/battle-engine';
import { getMove, MoveDef } from '../src/game-data/moves.data';

const IV0 = { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 };

function mon(pokemonId: string, speciesId: number, level: number, moves: string[]): EngineMonInput {
  return { pokemonId, speciesId, level, ivs: { ...IV0 }, moves };
}

/** one mon per side: A knows thunder-shock + tackle */
function single(): BattleEngine {
  return new BattleEngine([mon('a1', 25, 50, ['thunder-shock', 'tackle'])], [mon('b1', 9, 50, ['tackle'])], () => 0.5);
}

/** two mons on A so switching has a legal target */
function pair(): BattleEngine {
  return new BattleEngine(
    [mon('a1', 25, 50, ['tackle']), mon('a2', 133, 50, ['tackle'])],
    [mon('b1', 9, 50, ['tackle'])],
    () => 0.5,
  );
}

describe('client battle action -> engine action (battle:action contract)', () => {
  it('resolves the move id the client got from publicState into the engine slot', () => {
    expect(toEngineAction(single(), 'A', { type: 'move', moveId: 'tackle' })).toEqual({ type: 'move', moveIndex: 1 });
    expect(toEngineAction(single(), 'A', { type: 'move', moveId: 'thunder-shock' })).toEqual({ type: 'move', moveIndex: 0 });
  });

  it('rejects a move the active pokemon does not know with UNKNOWN_MOVE', () => {
    expect(() => toEngineAction(single(), 'A', { type: 'move', moveId: 'flamethrower' })).toThrow(/^UNKNOWN_MOVE:/);
    expect(() => toEngineAction(single(), 'A', { type: 'move' })).toThrow(/^UNKNOWN_MOVE:/);
  });

  it('resolves a switch target pokemon id into the team slot', () => {
    expect(toEngineAction(pair(), 'A', { type: 'switch', targetPokemonId: 'a2' })).toEqual({ type: 'switch', toIndex: 1 });
    expect(() => toEngineAction(pair(), 'A', { type: 'switch', targetPokemonId: 'p_missing' })).toThrow(/^UNKNOWN_POKEMON:/);
  });

  it('still accepts the engine-native slot form', () => {
    expect(toEngineAction(single(), 'A', { type: 'move', moveIndex: 0 })).toEqual({ type: 'move', moveIndex: 0 });
    expect(toEngineAction(pair(), 'A', { type: 'switch', toIndex: 1 })).toEqual({ type: 'switch', toIndex: 1 });
  });

  it('passes run through and refuses items instead of burning the turn', () => {
    expect(toEngineAction(single(), 'A', { type: 'run' })).toEqual({ type: 'run' });
    expect(() => toEngineAction(single(), 'A', { type: 'item', itemId: 'i_potion' })).toThrow(/^ITEM_NOT_SUPPORTED:/);
  });

  it('rejects an unknown action type with BAD_ACTION', () => {
    expect(() => toEngineAction(single(), 'A', { type: 'dance' })).toThrow(/^BAD_ACTION:/);
    expect(() => toEngineAction(single(), 'A', {})).toThrow(/^BAD_ACTION:/);
  });
});

describe('battle error codes carried to the client', () => {
  it('keeps the code of CODE: detail, bare CODE and engine messages alike', () => {
    expect(errorCodeOf('MUST_SWITCH: active pokemon fainted, switch required')).toBe('MUST_SWITCH');
    expect(errorCodeOf('INVALID_MOVE_INDEX')).toBe('INVALID_MOVE_INDEX');
    expect(errorCodeOf('BATTLE_NOT_LIVE: battle is not live on this server')).toBe('BATTLE_NOT_LIVE');
    // a plain runtime error has no code: the client shows the generic message
    expect(errorCodeOf('Cannot read properties of undefined')).toBe('BATTLE_ERROR');
  });
});

describe('battle move catalog (GET /battles/moves)', () => {
  it('carries name / type / power / accuracy / category / effect text for every move', () => {
    const catalog = battleMoveCatalog();
    expect(catalog.length).toBeGreaterThan(20);
    expect(catalog.find((m) => m.id === 'tackle')).toMatchObject({
      name: 'Tackle',
      type: 'normal',
      power: 40,
      accuracy: 100,
      category: 'physical',
      effectText: '纯伤害技能，没有追加效果。',
    });
    for (const move of catalog) {
      expect(move.id).toBeTruthy();
      expect(move.name).toBeTruthy();
      expect(move.power).toBeGreaterThan(0);
      expect(move.accuracy).toBeGreaterThan(0);
      // 效果系统已落地：每个技能都带中文效果说明
      expect(move.effectText.length).toBeGreaterThan(0);
    }
  });

  it('carries the effect description of the shared move table', () => {
    expect(battleMoveInfo(getMove('thunder-shock')!).effectText).toBe('造成伤害，10% 几率使目标麻痹。');
    expect(battleMoveInfo(getMove('body-slam')!).effectText).toContain('麻痹');
    const withEffect = { ...getMove('thunder-shock')!, effectText: '10% 概率使目标麻痹' } as MoveDef & {
      effectText?: string;
    };
    expect(battleMoveInfo(withEffect).effectText).toBe('10% 概率使目标麻痹');
  });
});
