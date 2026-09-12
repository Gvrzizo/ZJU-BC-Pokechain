import { EventEmitter } from 'events';
import { randomBytes, randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { canonicalize, DeriveStream, sha256hex } from '../common/utils/crypto.util';
import { ContractService } from '../fabric/contract.service';
import { BattleState, SYSTEM_IDENTITY } from '../fabric/chain.types';
import { RedisService } from '../common/redis/redis.service';
import { BattleLog } from './entities/battle-log.entity';
import { SigningService } from './signing.service';
import { BattleEngine, EngineAction, EngineMonInput, Side } from './engine/battle-engine';

export interface ActiveBattle {
  battleId: string;
  playerA: string;
  playerB: string;
  engine: BattleEngine;
  serverSeed: string;
  clientSeed: string;
  eventId: string;
  /** players whose socket joined the battle; the turn clock waits for both */
  arrived: Set<string>;
  entryTimer?: NodeJS.Timeout;
  entryDeadline: number;
  turnTimer?: NodeJS.Timeout;
  disconnectTimers: Map<string, NodeJS.Timeout>;
  finalized: boolean;
}

export type FinalizeOutcome = { kind: 'win'; winnerId: string } | { kind: 'draw' } | { kind: 'forfeit'; loserId: string };

/**
 * Owns the live battle engines: entry grace (a party that never reaches the
 * battle screen forfeits), per-turn 30s timeout, 60s disconnect forfeit, and
 * the end-of-battle orchestration (reveal random -> SubmitResult/Forfeit ->
 * battle log -> settle fallback).
 */
@Injectable()
export class BattleManagerService {
  private readonly logger = new Logger(BattleManagerService.name);
  private readonly active = new Map<string, ActiveBattle>();
  /** battle-update notifications consumed by the Socket.IO gateway */
  readonly events = new EventEmitter();

  constructor(
    private readonly contract: ContractService,
    private readonly redis: RedisService,
    private readonly signing: SigningService,
    private readonly config: ConfigService,
    @InjectRepository(BattleLog) private readonly battleLogs: Repository<BattleLog>,
  ) {}

  private get turnTimeoutMs(): number {
    return this.config.get<number>('battle.turnTimeoutMs') ?? 30_000;
  }

  private get disconnectTimeoutMs(): number {
    return this.config.get<number>('battle.disconnectTimeoutMs') ?? 60_000;
  }

  private get entryGraceMs(): number {
    return this.config.get<number>('battle.entryGraceMs') ?? 90_000;
  }

  private get settleFallbackMs(): number {
    return this.config.get<number>('battle.settleFallbackMs') ?? 120_000;
  }

  get(battleId: string): ActiveBattle | undefined {
    return this.active.get(battleId);
  }

  sideOf(battle: ActiveBattle, playerId: string): Side | null {
    if (battle.playerA === playerId) return 'A';
    if (battle.playerB === playerId) return 'B';
    return null;
  }

  /**
   * Create the engine for a chain-activated battle. Both players get an entry
   * grace window to reach the battle screen; only once both sockets joined
   * does the first turn clock (30s) start. A party that never arrives forfeits
   * when the window closes — a DRAW is only possible when both never arrive.
   */
  async startBattle(battleId: string, playerA: string, playerB: string, teamA: EngineMonInput[], teamB: EngineMonInput[]): Promise<ActiveBattle> {
    const serverSeed = randomBytes(32).toString('hex');
    const clientSeed = randomBytes(16).toString('hex');
    const eventId = `ev_battle_${battleId}`;
    await this.contract.commitRandom(SYSTEM_IDENTITY, {
      eventId,
      purpose: 'battle',
      playerId: 'system',
      commitHash: sha256hex(serverSeed),
      clientSeed,
    });
    const stream = new DeriveStream(serverSeed, clientSeed, eventId);
    const engine = new BattleEngine(teamA, teamB, () => stream.next());
    const battle: ActiveBattle = {
      battleId,
      playerA,
      playerB,
      engine,
      serverSeed,
      clientSeed,
      eventId,
      arrived: new Set<string>(),
      entryDeadline: 0,
      disconnectTimers: new Map(),
      finalized: false,
    };
    this.active.set(battleId, battle);
    await this.redis.setJson(`battle:seed:${battleId}`, { serverSeed, clientSeed, eventId }, 24 * 3600);
    this.armEntryWindow(battle);
    return battle;
  }

  /** Announce the entry window so both clients can show "waiting for <player>". */
  private armEntryWindow(battle: ActiveBattle): void {
    battle.entryDeadline = Date.now() + this.entryGraceMs;
    this.clearEntryTimer(battle);
    battle.entryTimer = setTimeout(() => void this.onEntryTimeout(battle), this.entryGraceMs);
    battle.entryTimer.unref?.();
    this.emitEntry(battle);
  }

  private emitEntry(battle: ActiveBattle): void {
    const awaiting = [battle.playerA, battle.playerB].filter((p) => !battle.arrived.has(p));
    this.events.emit('entry', battle.battleId, {
      awaitingPlayerIds: awaiting,
      arrivedPlayerIds: [...battle.arrived],
      deadline: battle.entryDeadline,
      graceMs: this.entryGraceMs,
    });
  }

  private async onEntryTimeout(battle: ActiveBattle): Promise<void> {
    if (battle.finalized || battle.engine.finished) return;
    const missing = [battle.playerA, battle.playerB].filter((p) => !battle.arrived.has(p));
    if (missing.length === 0) {
      this.announceTurn(battle); // both arrived on the deadline; start the fight
      return;
    }
    if (missing.length === 1) {
      await this.finalize(battle, { kind: 'forfeit', loserId: missing[0] }, 'entry-timeout');
      return;
    }
    await this.finalize(battle, { kind: 'draw' }, 'entry-timeout-both');
  }

  /**
   * Socket joined (or reconnected): mark the player as present at the battle
   * screen and cancel a pending disconnect forfeit. Starts the 30s turn clock
   * once both sides are in; before that a leave is only "not arrived yet".
   */
  enterBattle(battleId: string, playerId: string): void {
    const battle = this.active.get(battleId);
    if (!battle || battle.finalized || battle.engine.finished) return;
    const timer = battle.disconnectTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      battle.disconnectTimers.delete(playerId);
      this.events.emit('presence', battleId, { playerId, online: true });
    }
    const firstArrival = !battle.arrived.has(playerId);
    battle.arrived.add(playerId);
    if (battle.arrived.size >= 2) {
      if (battle.entryTimer) {
        this.clearEntryTimer(battle);
        this.emitEntry(battle); // awaitingPlayerIds: [] -> both clients close the entry banner
        this.announceTurn(battle);
      }
      return;
    }
    if (firstArrival) this.emitEntry(battle);
  }

  /** Player action from the gateway; resolves the turn when both sides acted. */
  submitAction(battleId: string, playerId: string, action: EngineAction): void {
    const battle = this.mustBattle(battleId);
    const side = this.sideOf(battle, playerId);
    if (!side) throw new Error('NOT_PARTY: you are not in this battle');
    const { resolved } = battle.engine.submitAction(side, action);
    this.events.emit('state', battleId, battle.engine.publicState());
    if (battle.engine.finished) {
      void this.finalizeEngineEnd(battle);
      return;
    }
    if (resolved) this.announceTurn(battle);
  }

  private announceTurn(battle: ActiveBattle): void {
    this.clearTurnTimer(battle);
    const awaiting: string[] = [];
    const state = battle.engine.publicState();
    if (!state.A.acted && !battle.engine.finished) awaiting.push(battle.playerA);
    if (!state.B.acted && !battle.engine.finished) awaiting.push(battle.playerB);
    const deadline = Date.now() + this.turnTimeoutMs;
    battle.turnTimer = setTimeout(() => void this.onTurnTimeout(battle), this.turnTimeoutMs);
    battle.turnTimer.unref?.();
    this.events.emit('turn', battle.battleId, { awaitingPlayerIds: awaiting, deadline });
  }

  private async onTurnTimeout(battle: ActiveBattle): Promise<void> {
    if (battle.finalized || battle.engine.finished) return;
    const state = battle.engine.publicState();
    const aMissing = !state.A.acted;
    const bMissing = !state.B.acted;
    if (aMissing && bMissing) {
      await this.finalize(battle, { kind: 'draw' }, 'turn-timeout-both');
    } else if (aMissing) {
      await this.finalize(battle, { kind: 'forfeit', loserId: battle.playerA }, 'turn-timeout');
    } else if (bMissing) {
      await this.finalize(battle, { kind: 'forfeit', loserId: battle.playerB }, 'turn-timeout');
    } else {
      this.announceTurn(battle); // stale timer
    }
  }

  /** Socket connected: cancel any pending disconnect forfeit. */
  playerConnected(battleId: string, playerId: string): void {
    this.enterBattle(battleId, playerId);
  }

  /**
   * Socket disconnected. During the entry window this only marks the player as
   * absent again (the entry grace decides the forfeit); after the fight started
   * the 60s forfeit clock runs.
   */
  playerDisconnected(battleId: string, playerId: string): void {
    const battle = this.active.get(battleId);
    if (!battle || battle.finalized || battle.engine.finished) return;
    if (battle.entryTimer) {
      if (battle.arrived.delete(playerId)) {
        this.events.emit('presence', battleId, { playerId, online: false, graceMs: this.entryGraceMs });
        this.emitEntry(battle);
      }
      return;
    }
    if (battle.disconnectTimers.has(playerId)) return;
    const timer = setTimeout(() => {
      battle.disconnectTimers.delete(playerId);
      void this.finalize(battle, { kind: 'forfeit', loserId: playerId }, 'disconnect');
    }, this.disconnectTimeoutMs);
    timer.unref?.();
    battle.disconnectTimers.set(playerId, timer);
    this.events.emit('presence', battleId, { playerId, online: false, graceMs: this.disconnectTimeoutMs });
  }

  /** Explicit forfeit (REST or 'run' handled by engine). */
  async forfeit(battleId: string, loserId: string): Promise<void> {
    const battle = this.mustBattle(battleId);
    await this.finalize(battle, { kind: 'forfeit', loserId }, 'forfeit');
  }

  private async finalizeEngineEnd(battle: ActiveBattle): Promise<void> {
    const outcome = battle.engine.outcome;
    if (!outcome) return;
    if ('draw' in outcome) {
      await this.finalize(battle, { kind: 'draw' }, 'knockout-draw');
    } else {
      const winnerId = outcome.winnerSide === 'A' ? battle.playerA : battle.playerB;
      await this.finalize(battle, { kind: 'win', winnerId }, 'knockout');
    }
  }

  /**
   * End-of-battle orchestration: resultHash = sha256(canonical(turn log)),
   * serverSig = secp256k1(resultHash); reveal the battle random; submit the
   * result (or Forfeit, which settles immediately); persist the replay log;
   * arm the SettleBattle fallback.
   */
  async finalize(battle: ActiveBattle, outcome: FinalizeOutcome, reason: string): Promise<void> {
    if (battle.finalized) return;
    battle.finalized = true;
    this.clearTurnTimer(battle);
    this.clearEntryTimer(battle);
    for (const t of battle.disconnectTimers.values()) clearTimeout(t);
    battle.disconnectTimers.clear();

    let winnerId = 'DRAW';
    if (outcome.kind === 'win') winnerId = outcome.winnerId;
    if (outcome.kind === 'forfeit') {
      winnerId = outcome.loserId === battle.playerA ? battle.playerB : battle.playerA;
      battle.engine.forceWin(winnerId === battle.playerA ? 'A' : 'B', reason);
    }

    const resultHash = sha256hex(canonicalize(battle.engine.log));
    const serverSig = this.signing.signResultHash(resultHash);

    try {
      // reveal the battle random stream for post-hoc audit
      const random = await this.contract.getRandom(battle.eventId).catch(() => null);
      if (random && random.status === 'COMMITTED') {
        await this.contract.revealAndVerify(SYSTEM_IDENTITY, battle.eventId, battle.serverSeed, {
          idemKey: `${battle.battleId}-reveal`,
        });
      }

      if (outcome.kind === 'forfeit') {
        await this.contract.forfeitBattle(SYSTEM_IDENTITY, battle.battleId, outcome.loserId, reason, {
          idemKey: `${battle.battleId}-forfeit`,
        });
      } else {
        await this.contract.submitBattleResult(SYSTEM_IDENTITY, battle.battleId, winnerId, resultHash, serverSig, {
          idemKey: `${battle.battleId}-result`,
        });
        this.armSettleFallback(battle.battleId);
      }
    } catch (err) {
      this.logger.error(`finalize chain calls failed for ${battle.battleId}: ${(err as Error).message}`);
    }

    try {
      await this.battleLogs.save(
        this.battleLogs.create({
          battleId: battle.battleId,
          turnsJson: battle.engine.log as unknown as unknown[],
          resultHash,
          serverSig,
        }),
      );
    } catch (err) {
      this.logger.warn(`battle log persist failed for ${battle.battleId}: ${(err as Error).message}`);
    }
    await this.redis.del(`battle:seed:${battle.battleId}`).catch(() => undefined);

    this.events.emit('end', battle.battleId, { winnerId, resultHash, serverSig, reason });
    this.active.delete(battle.battleId);
  }

  private armSettleFallback(battleId: string): void {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const chain = await this.contract.getBattle(battleId);
          if (chain.status === 'RESULT_SUBMITTED') {
            await this.contract.settleBattle(SYSTEM_IDENTITY, battleId, { idemKey: `${battleId}-settle-fallback` });
            this.logger.log(`settle fallback executed for ${battleId}`);
          }
        } catch (err) {
          this.logger.warn(`settle fallback failed for ${battleId}: ${(err as Error).message}`);
        }
      })();
    }, this.settleFallbackMs);
    timer.unref?.();
  }

  /**
   * 对账结算：本地引擎已丢失（后端重启/崩溃）时的链上收尾，供房间对账调用。
   * 链码没有 abort 交易，只能走受支持的路径：
   *   CREATED → ActivateBattle；ACTIVE → SubmitResult(DRAW)；RESULT_SUBMITTED → 直接 SettleBattle。
   * DRAW 把双方 escrow 与锁定资产原路退回——服务端已无法证明胜负时唯一公平的结果。
   * `note`（如 server-restart）写进 resultHash 前缀：链上 result 没有备注字段，
   * 这样在任何复核里都能认出这不是引擎产出的对局结果。幂等，可重复调用。
   */
  async settleAbandoned(battleId: string, note: string): Promise<BattleState | null> {
    const chain = await this.contract.getBattle(battleId).catch(() => null);
    if (!chain) return null;
    if (chain.status === 'SETTLED' || chain.status === 'REFUNDED') return chain;
    if (chain.status === 'DISPUTED') return chain; // 仲裁流程接管，资产保持冻结
    if (chain.status === 'CREATED') {
      await this.contract.activateBattle(SYSTEM_IDENTITY, battleId, { idemKey: `${battleId}-reconcile-activate` });
    } else if (chain.status !== 'ACTIVE' && chain.status !== 'RESULT_SUBMITTED') {
      return chain;
    }
    if (chain.status !== 'RESULT_SUBMITTED') {
      const resultHash = sha256hex(`${note}|${battleId}`);
      const serverSig = this.signing.signResultHash(resultHash);
      await this.contract.submitBattleResult(SYSTEM_IDENTITY, battleId, 'DRAW', resultHash, serverSig, {
        idemKey: `${battleId}-reconcile-result`,
      });
    }
    return this.contract.settleBattle(SYSTEM_IDENTITY, battleId, { idemKey: `${battleId}-reconcile-settle` });
  }

  private clearTurnTimer(battle: ActiveBattle): void {
    if (battle.turnTimer) {
      clearTimeout(battle.turnTimer);
      battle.turnTimer = undefined;
    }
  }

  private clearEntryTimer(battle: ActiveBattle): void {
    if (battle.entryTimer) {
      clearTimeout(battle.entryTimer);
      battle.entryTimer = undefined;
    }
  }

  private mustBattle(battleId: string): ActiveBattle {
    const battle = this.active.get(battleId);
    if (!battle) throw new Error('BATTLE_NOT_LIVE: battle is not live on this server');
    return battle;
  }

  /** test helper */
  activeCount(): number {
    return this.active.size;
  }
}
