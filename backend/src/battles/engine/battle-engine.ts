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
  /** 羁绊值 0–255：非 HP 五项 × (1 + bond/255 × 5%)，缺省 0（docs/backend-api.md §11） */
  bond?: number;
  moves: string[];
  /**
   * 出战时的当前 HP（缺省 = 满血）。**实时 PvP 对局一律满血出战**（房间/排位/机器人，
   * 由 `BattleManagerService.startBattle` 统一剥掉该字段，见 docs/backend-api.md §2）；
   * 该入参只对直接构造引擎的调用方生效。0 的宝可梦不能出战（队伍提交时已被 FAINTED 拒绝）。
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
  /**
   * 结构化细节。除各事件自身的字段外，**攻击/受击/异常/能力阶级事件都会带上
   * `pokemonId`（受影响单位）以及 `attacker`/`defender`（出手方/目标方）的宝可梦 id**，
   * 供前端把回合日志渲染成中文文本（名称走 i18n，见 docs/backend-api.md §5）。
   */
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
  // 最终能力值：种族值 + IV + EV + 等级 + 性格修正 + 羁绊加成（docs/backend-api.md §2 能力值计算 / §11）
  const stats = computeStats(species.base, input.ivs, input.evs, input.level, input.nature ?? 'hardy', input.bond ?? 0);
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

/** PvP 一律满血出战：剥掉链下伤势（`currentHp`），竞技只比养成与策略（docs/backend-api.md §2）。 */
export function withFullHealth(team: EngineMonInput[]): EngineMonInput[] {
  return team.map((mon) => {
    const copy = { ...mon };
    delete copy.currentHp;
    return copy;
  });
}

/**
 * Server-authoritative simplified turn engine (docs/backend-api.md §5):
 * speed decides order (paralysis halves it), 6-type chart, damage
 *   floor( floor(((2*level/5+2)*power*atk/def)/50) + 2 * eff * crit * rand(0.85..1) )
 * where atk/def/hp/speed are the final stats from game-data/stats.computeStats
 * (base + IV + EV/4 + level + nature, then the non-HP five × the bond multiplier)
 * adjusted by stat stages (±6). Live PvP battles start at full health —
 * `BattleManagerService.startBattle` strips any `EngineMonInput.currentHp`;
 * only direct engine callers see the persisted off-chain HP honoured.
 * Roll order (docs/randomness.md §4): paralysis check (only when paralyzed),
 * hit, crit, damage factor, effect chance (only for moves with a stat/status
 * effect); burn/poison residual damage at the end of the turn consumes no roll.
 * `publicState().log` carries every resolved turn (events enriched with the
 * acting/target pokemon ids) so the client can render the realtime text log.
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
        detail: { status: mon.status, damage, hp: mon.hp, maxHp: mon.maxHp, pokemonId: mon.pokemonId },
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
    const pair = { attacker: attacker.pokemonId, defender: defender.pokemonId };

    // paralysis: 25% chance to lose the action (consumes a roll before the move event)
    if (attacker.status === 'par') {
      const parRoll = this.rand();
      if (paralysisSkips(parRoll)) {
        entry.events.push({ kind: 'paralyzed', side, detail: { move: move.id, roll: round6(parRoll), pokemonId: attacker.pokemonId } });
        return;
      }
    }

    entry.events.push({ kind: 'move', side, detail: { move: move.id, ...pair } });

    const hitRoll = this.rand();
    if (!hitCheck(move.accuracy, hitRoll)) {
      entry.events.push({ kind: 'miss', side, detail: { move: move.id, roll: round6(hitRoll), ...pair } });
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
        ...pair,
      },
    });

    const effect = move.effect ?? null;
    if (effect) {
      // stat/status roll is only needed when the effect is chance-based; drain/recoil are deterministic
      const effectRoll = effect.kind === 'stat' || effect.kind === 'status' ? this.rand() : 0;
      for (const result of applyMoveEffect(effect, attacker, defender, damage, effectRoll)) {
        const ev = effectEvent(result);
        // 受影响单位（status/stat 可能落在守方，drain/recoil 落在出手方）供日志补名字
        const subject =
          ev.kind === 'status' || (ev.kind === 'stat' && ev.detail.target === 'foe')
            ? defender.pokemonId
            : attacker.pokemonId;
        entry.events.push({ kind: ev.kind, side, detail: { ...ev.detail, pokemonId: subject } });
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
      /**
       * 已结算回合的完整日志（含当前回合）：随每次 `battle:state` 推送，
       * 前端据此渲染实时中文战斗日志（docs/backend-api.md §5）。
       */
      log: this.log.map((turn) => ({
        turn: turn.turn,
        actions: { A: turn.actions.A, B: turn.actions.B },
        events: turn.events.map((event) => ({ kind: event.kind, side: event.side, detail: { ...event.detail } })),
      })),
    };
  }
}
