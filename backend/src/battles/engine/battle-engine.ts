import { getMove, MoveDef, StatStageKey, StatusCondition } from '../../game-data/moves.data';
import { computeStats, StatBlock } from '../../game-data/stats';
import { getSpecies } from '../../game-data/species.data';
import { PokeType, typeEffectiveness } from '../../game-data/type-chart';
import {
  applyMoveEffect,
  computeDamage,
  critCheck,
  damageFactor,
  effectiveStat,
  effectEvent,
  hitCheck,
  newConditions,
  paralysisSkips,
  residualDamage,
  round6,
  speedForOrder,
} from './battle-math';

export interface EngineMonInput {
  pokemonId: string;
  speciesId: number;
  level: number;
  ivs: StatBlock;
  /** 努力值；缺省按全 0（旧调用方兼容） */
  evs?: StatBlock;
  /** 性格（25 种，影响最终能力值非 HP 五项 ±10%）；缺省按无修正 */
  nature?: string;
  moves: string[];
  /**
   * 出战时的当前 HP（链下 Redis 的伤势，缺省 = 满血）。
   * 0 的宝可梦不能出战（队伍提交时已被 FAINTED 拒绝，见 docs/backend-api.md §2）。
   */
  currentHp?: number;
}

export interface EngineMon {
  pokemonId: string;
  speciesId: number;
  name: string;
  type: PokeType;
  level: number;
  maxHp: number;
  hp: number;
  atk: number;
  def: number;
  spatk: number;
  spdef: number;
  speed: number;
  moves: MoveDef[];
  /** 能力阶级（±6，战斗内累积） */
  stages: Record<StatStageKey, number>;
  /** 异常状态（brn/psn/par），同类不叠加 */
  status: StatusCondition | null;
}

export type EngineAction =
  | { type: 'move'; moveIndex: number }
  | { type: 'switch'; toIndex: number }
  | { type: 'run' };

export type Side = 'A' | 'B';

export interface EngineEvent {
  kind:
    | 'switch'
    | 'move'
    | 'miss'
    | 'damage'
    | 'faint'
    | 'run'
    | 'win'
    | 'paralyzed'
    | 'status'
    | 'status-damage'
    | 'stat'
    | 'drain'
    | 'recoil';
  side?: Side;
  detail: Record<string, unknown>;
}

export interface TurnEntry {
  turn: number;
  actions: { A?: EngineAction; B?: EngineAction };
  events: EngineEvent[];
}

export type EngineOutcome = { winnerSide: Side } | { draw: true } | null;

export { CRIT_MULT, CRIT_RATE } from './battle-math';

function buildMon(input: EngineMonInput): EngineMon {
  const species = getSpecies(input.speciesId);
  if (!species) throw new Error(`UNKNOWN_SPECIES: ${input.speciesId}`);
  // 最终能力值：种族值 + IV + EV + 等级 + 性格修正（docs/backend-api.md §2 能力值计算）
  const stats = computeStats(species.base, input.ivs, input.evs, input.level, input.nature ?? 'hardy');
  const moves = input.moves
    .map((m) => getMove(m))
    .filter((m): m is MoveDef => !!m)
    .slice(0, 4);
  if (moves.length === 0) throw new Error(`NO_MOVES: pokemon ${input.pokemonId} has no usable moves`);
  const conditions = newConditions();
  const maxHp = stats.hp;
  const currentHp = Number.isFinite(input.currentHp) ? Math.floor(input.currentHp as number) : maxHp;
  return {
    pokemonId: input.pokemonId,
    speciesId: input.speciesId,
    name: species.name,
    type: species.type,
    level: input.level,
    maxHp,
    /** 伤势持久化：以传入的当前 HP 出战（夹取到 [0, maxHp]），缺省满血 */
    hp: Math.min(maxHp, Math.max(0, currentHp)),
    atk: stats.atk,
    def: stats.def,
    spatk: stats.spatk,
    spdef: stats.spdef,
    speed: stats.speed,
    moves,
    stages: conditions.stages,
    status: conditions.status,
  };
}

/**
 * Server-authoritative simplified turn engine (docs/backend-api.md §5):
 * speed decides order (paralysis halves it), 6-type chart, damage
 *   floor( floor(((2*level/5+2)*power*atk/def)/50) + 2 * eff * crit * rand(0.85..1) )
 * where atk/def/hp/speed are the final stats from game-data/stats.computeStats
 * (base + IV + EV/4 + level + nature) adjusted by stat stages (±6), and the
 * opening hp comes from the persisted off-chain HP (EngineMonInput.currentHp,
 * docs/backend-api.md §2「伤势持久化」) — a battle no longer resets the party
 * to full health. Roll order (docs/randomness.md §4): paralysis
 * check (only when paralyzed), hit, crit, damage factor, effect chance (only
 * for moves with a stat/status effect); burn/poison residual damage at the end
 * of the turn consumes no roll.
 */
export class BattleEngine {
  readonly teamA: EngineMon[];
  readonly teamB: EngineMon[];
  activeA = 0;
  activeB = 0;
  turn = 1;
  readonly log: TurnEntry[] = [];
  private pending: { A?: EngineAction; B?: EngineAction } = {};
  private mustSwitch: { A: boolean; B: boolean } = { A: false, B: false };
  outcome: EngineOutcome = null;

  constructor(
    teamA: EngineMonInput[],
    teamB: EngineMonInput[],
    private readonly rand: () => number,
  ) {
    if (teamA.length === 0 || teamB.length === 0) throw new Error('EMPTY_TEAM');
    this.teamA = teamA.map(buildMon);
    this.teamB = teamB.map(buildMon);
  }

  get finished(): boolean {
    return this.outcome !== null;
  }

  active(side: Side): EngineMon {
    return side === 'A' ? this.teamA[this.activeA] : this.teamB[this.activeB];
  }

  team(side: Side): EngineMon[] {
    return side === 'A' ? this.teamA : this.teamB;
  }

  needsSwitch(side: Side): boolean {
    return this.mustSwitch[side];
  }

  /** Submit one side's action for the current turn. Returns the resolved turn when both sides are in. */
  submitAction(side: Side, action: EngineAction): { resolved: boolean; entry?: TurnEntry } {
    if (this.finished) throw new Error('BATTLE_FINISHED: this battle is already over');
    if (this.pending[side]) throw new Error('ACTION_ALREADY_SUBMITTED: this side already acted this turn');
    this.validate(side, action);
    if (action.type === 'run') {
      const entry: TurnEntry = {
        turn: this.turn,
        actions: { ...this.pending, [side]: action },
        events: [{ kind: 'run', side, detail: {} }],
      };
      const winnerSide: Side = side === 'A' ? 'B' : 'A';
      entry.events.push({ kind: 'win', side: winnerSide, detail: { reason: 'run' } });
      this.log.push(entry);
      this.outcome = { winnerSide };
      return { resolved: true, entry };
    }
    this.pending[side] = action;
    if (!this.pending.A || !this.pending.B) {
      return { resolved: false };
    }
    const entry = this.resolveTurn(this.pending.A, this.pending.B);
    this.pending = {};
    return { resolved: true, entry };
  }

  private validate(side: Side, action: EngineAction): void {
    const team = this.team(side);
    if (this.mustSwitch[side] && action.type !== 'switch') {
      throw new Error('MUST_SWITCH: active pokemon fainted, switch required');
    }
    if (action.type === 'move') {
      const active = this.active(side);
      if (!Number.isInteger(action.moveIndex) || action.moveIndex < 0 || action.moveIndex >= active.moves.length) {
        throw new Error(`INVALID_MOVE_INDEX: slot ${action.moveIndex} is not a move of ${active.name}`);
      }
    } else if (action.type === 'switch') {
      const idx = action.toIndex;
      if (!Number.isInteger(idx) || idx < 0 || idx >= team.length) {
        throw new Error(`INVALID_SWITCH_INDEX: no team slot ${idx}`);
      }
      const current = side === 'A' ? this.activeA : this.activeB;
      if (idx === current) throw new Error('SWITCH_TO_ACTIVE: that pokemon is already on the field');
      if (team[idx].hp <= 0) throw new Error('SWITCH_TO_FAINTED: that pokemon has fainted');
    }
  }

  private resolveTurn(a: EngineAction, b: EngineAction): TurnEntry {
    const entry: TurnEntry = { turn: this.turn, actions: { A: a, B: b }, events: [] };

    // switches resolve before attacks
    for (const [side, action] of [['A', a], ['B', b]] as Array<[Side, EngineAction]>) {
      if (action.type === 'switch') {
        this.applySwitch(side, action.toIndex, entry);
        this.mustSwitch[side] = false;
      }
    }

    // order by speed (paralysis halves speed); ties broken by the battle random stream
    const speedA = speedForOrder(this.active('A').speed, this.active('A'));
    const speedB = speedForOrder(this.active('B').speed, this.active('B'));
    let first: Side = 'A';
    if (speedB > speedA) first = 'B';
    else if (speedA === speedB) first = this.rand() < 0.5 ? 'A' : 'B';
    const order: Side[] = first === 'A' ? ['A', 'B'] : ['B', 'A'];

    for (const side of order) {
      if (this.finished || this.mustSwitch.A || this.mustSwitch.B) break;
      const action = side === 'A' ? a : b;
      if (action.type !== 'move') continue;
      const attacker = this.active(side);
      if (attacker.hp <= 0) continue;
      const defenderSide: Side = side === 'A' ? 'B' : 'A';
      this.applyMove(side, attacker, this.active(defenderSide), action.moveIndex, entry);
      this.checkFaints(entry);
    }

    // end of turn: burn/poison residual damage on both actives
    for (const side of ['A', 'B'] as Side[]) {
      if (this.finished) break;
      const mon = this.active(side);
      if (mon.hp <= 0 || !mon.status) continue;
      const damage = residualDamage(mon.maxHp, mon.status);
      mon.hp = Math.max(0, mon.hp - damage);
      entry.events.push({
        kind: 'status-damage',
        side,
        detail: { status: mon.status, damage, hp: mon.hp, maxHp: mon.maxHp },
      });
      this.checkFaints(entry);
    }

    this.log.push(entry);
    this.turn += 1;
    return entry;
  }

  private applySwitch(side: Side, toIndex: number, entry: TurnEntry): void {
    if (side === 'A') this.activeA = toIndex;
    else this.activeB = toIndex;
    entry.events.push({ kind: 'switch', side, detail: { toIndex, pokemonId: this.active(side).pokemonId } });
  }

  private applyMove(side: Side, attacker: EngineMon, defender: EngineMon, moveIndex: number, entry: TurnEntry): void {
    const move = attacker.moves[moveIndex];

    // paralysis: 25% chance to lose the action (consumes a roll before the move event)
    if (attacker.status === 'par') {
      const parRoll = this.rand();
      if (paralysisSkips(parRoll)) {
        entry.events.push({ kind: 'paralyzed', side, detail: { move: move.id, roll: round6(parRoll) } });
        return;
      }
    }

    entry.events.push({ kind: 'move', side, detail: { move: move.id, attacker: attacker.pokemonId, defender: defender.pokemonId } });

    const hitRoll = this.rand();
    if (!hitCheck(move.accuracy, hitRoll)) {
      entry.events.push({ kind: 'miss', side, detail: { move: move.id, roll: round6(hitRoll) } });
      return;
    }

    const atkKey: StatStageKey = move.category === 'physical' ? 'atk' : 'spatk';
    const defKey: StatStageKey = move.category === 'physical' ? 'def' : 'spdef';
    const atk = effectiveStat(attacker[atkKey], attacker.stages[atkKey]);
    const def = effectiveStat(defender[defKey], defender.stages[defKey]);
    const eff = typeEffectiveness(move.type, defender.type);
    const crit = critCheck(this.rand());
    const factor = damageFactor(this.rand());
    const damage = computeDamage({
      level: attacker.level,
      power: move.power,
      attack: atk,
      defense: def,
      effectiveness: eff,
      crit,
      factor,
    });
    defender.hp = Math.max(0, defender.hp - damage);
    entry.events.push({
      kind: 'damage',
      side,
      detail: {
        move: move.id,
        damage,
        eff,
        crit,
        roll: round6(factor),
        defenderHp: defender.hp,
        defenderMaxHp: defender.maxHp,
      },
    });

    const effect = move.effect ?? null;
    if (effect) {
      // stat/status roll is only needed when the effect is chance-based; drain/recoil are deterministic
      const effectRoll = effect.kind === 'stat' || effect.kind === 'status' ? this.rand() : 0;
      for (const result of applyMoveEffect(effect, attacker, defender, damage, effectRoll)) {
        const ev = effectEvent(result);
        entry.events.push({ kind: ev.kind, side, detail: ev.detail });
      }
      this.checkFaints(entry);
    }
  }

  private checkFaints(entry: TurnEntry): void {
    for (const side of ['A', 'B'] as Side[]) {
      const mon = this.active(side);
      if (mon.hp <= 0 && !this.mustSwitch[side] && !this.finished) {
        entry.events.push({ kind: 'faint', side, detail: { pokemonId: mon.pokemonId } });
        const alive = this.team(side).some((m) => m.hp > 0);
        if (!alive) {
          const otherAlive = this.team(side === 'A' ? 'B' : 'A').some((m) => m.hp > 0);
          if (otherAlive) {
            const winnerSide: Side = side === 'A' ? 'B' : 'A';
            entry.events.push({ kind: 'win', side: winnerSide, detail: { reason: 'knockout' } });
            this.outcome = { winnerSide };
          } else {
            entry.events.push({ kind: 'win', detail: { reason: 'double-ko' } });
            this.outcome = { draw: true };
          }
        } else {
          this.mustSwitch[side] = true;
        }
      }
    }
  }

  /** Forfeit by timeout/disconnect/rest: the losing side is decided externally. */
  forceWin(winnerSide: Side, reason: string): TurnEntry {
    if (this.finished) return this.log[this.log.length - 1];
    const entry: TurnEntry = {
      turn: this.turn,
      actions: { ...this.pending },
      events: [{ kind: 'win', side: winnerSide, detail: { reason } }],
    };
    this.pending = {};
    this.log.push(entry);
    this.outcome = { winnerSide };
    return entry;
  }

  /** Public state broadcast (no secrets). */
  publicState() {
    const sideState = (side: Side) => ({
      active: side === 'A' ? this.activeA : this.activeB,
      team: this.team(side).map((m) => ({
        pokemonId: m.pokemonId,
        speciesId: m.speciesId,
        name: m.name,
        type: m.type,
        level: m.level,
        hp: m.hp,
        maxHp: m.maxHp,
        moves: m.moves.map((mv) => mv.id),
        fainted: m.hp <= 0,
        status: m.status,
        stages: { ...m.stages },
      })),
      mustSwitch: this.mustSwitch[side],
      acted: !!this.pending[side],
    });
    return {
      turn: this.turn,
      A: sideState('A'),
      B: sideState('B'),
      finished: this.finished,
      outcome: this.outcome,
    };
  }
}
