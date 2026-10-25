import { Injectable, Logger } from '@nestjs/common';
import { canonicalize, sha256hex } from '../common/utils/crypto.util';
import { CodedError } from '../common/utils/errors';
import {
  ChainAdapter,
  childStackId,
  normalizeWagerBundle,
  parentStackIdOf,
  TxMeta,
} from './chain.adapter';
import {
  AssetOffer,
  BattleState,
  ChainEventListener,
  ChainEventPayload,
  ChainIdentity,
  GrowthPatch,
  ItemStackRef,
  ItemState,
  PlayerState,
  PokemonIvs,
  PokemonState,
  RandomCommitState,
  TradeState,
  WagerBundle,
  WagerInput,
} from './chain.types';
import { MockChainDelta, MockChainSnapshot, MockChainStore } from './mock-chain.store';

const EV_KEYS = ['hp', 'atk', 'def', 'spatk', 'spdef', 'speed'] as const;
const EV_MAX_PER_STAT = 255;
const EV_MAX_TOTAL = 510;
const IV_MAX = 31;
const BOND_DEFAULT = 50;
const BOND_RESET_ON_TRANSFER = 30;
const BOND_MAX = 255;
const BOND_MIN_DELTA = 1;
const BOND_MAX_DELTA = 50;
const BOND_UP_MAX_IDS = 100;
const RATING_DEFAULT = 1000;
const RATING_MAX = 99999;

type StatKey = (typeof EV_KEYS)[number];

function zeroEvs(): PokemonIvs {
  return { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 };
}

/** Mirrors chaincode model.assertEvs: each stat 0-255, total ≤510. */
function assertEvs(evs: unknown, field: string): PokemonIvs {
  const record = (evs ?? {}) as Record<string, unknown>;
  const out = zeroEvs();
  let total = 0;
  for (const key of EV_KEYS) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > EV_MAX_PER_STAT) {
      throw new CodedError('INVALID_PARAM', `${field}.${key} must be a safe integer 0-${EV_MAX_PER_STAT}`);
    }
    out[key] = value;
    total += value;
  }
  if (total > EV_MAX_TOTAL) {
    throw new CodedError('INVALID_PARAM', `${field} total ${total} exceeds ${EV_MAX_TOTAL}`);
  }
  return out;
}

/** evs/bond 字段上线前的旧记录按默认值读回（镜像链码 loadPokemon 的兼容处理）。 */
function withPokemonDefaults(pokemon: PokemonState): PokemonState {
  if (!pokemon.evs) pokemon.evs = zeroEvs();
  if (typeof pokemon.bond !== 'number') pokemon.bond = BOND_DEFAULT;
  return pokemon;
}

/** rating 字段上线前的旧记录按默认值读回（镜像链码 loadPlayer 的兼容处理）。 */
function withPlayerDefaults(player: PlayerState): PlayerState {
  if (typeof player.rating !== 'number') player.rating = RATING_DEFAULT;
  return player;
}

/** 镜像链码 model.applyIvsPatch：IV 子集、每维 0-31、只能升不能降（违反抛 IV_DECREASE）。 */
function applyIvsPatch(patch: unknown, current: PokemonIvs, field: string): PokemonIvs {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new CodedError('INVALID_PARAM', `${field} must be a JSON object`);
  }
  const record = patch as Record<string, unknown>;
  const next: PokemonIvs = { ...current };
  for (const key of Object.keys(record)) {
    if (!(EV_KEYS as readonly string[]).includes(key)) {
      throw new CodedError('INVALID_PARAM', `${field}.${key} is not an IV stat`);
    }
    const stat = key as StatKey;
    const value = record[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > IV_MAX) {
      throw new CodedError('INVALID_PARAM', `${field}.${key} must be a safe integer 0-${IV_MAX}`);
    }
    if (value < current[stat]) {
      throw new CodedError('IV_DECREASE', `${field}.${key} cannot decrease (${current[stat]} -> ${value})`);
    }
    next[stat] = value;
  }
  return next;
}

/** 兼容 items 字段上线前存入的旧 battle（`itemIds` → 整堆 qty=0），镜像链码 wagerItemRefs。 */
function wagerItemsOf(wager: WagerBundle): ItemStackRef[] {
  if (Array.isArray(wager.items)) return wager.items;
  const legacy = (wager as unknown as { itemIds?: string[] }).itemIds ?? [];
  return legacy.map((id) => ({ id, qty: 0 }));
}

/** ChainAdapter methods that read/write world state; each one is a transaction boundary. */
export const PERSISTED_METHODS = [
  // PlayerContract
  'registerPlayer',
  'grantRole',
  'getPlayer',
  'addPoints',
  'transferPoints',
  'updateRating',
  // RandomContract
  'commitRandom',
  'revealAndVerify',
  'getRandom',
  // PokemonContract
  'mintFromCapture',
  'transferPokemon',
  'applyGrowth',
  'releasePokemon',
  'bondUp',
  'getPokemon',
  'queryPokemonByOwner',
  'queryPokedex',
  // ItemContract
  'mintItem',
  'transferItem',
  'consumeItem',
  'getItem',
  'queryItemsByOwner',
  'mergeStacks',
  // TradeContract
  'createTrade',
  'confirmTrade',
  'cancelTrade',
  'expireTrade',
  'getTrade',
  'queryTradesByPlayer',
  // BattleContract
  'createBattle',
  'activateBattle',
  'submitBattleResult',
  'confirmBattleResult',
  'settleBattle',
  'forfeitBattle',
  'disputeBattle',
  'arbitrateBattle',
  'getBattle',
  'queryBattlesByPlayer',
] as const;

/**
 * Implementation of the pokemoncc chaincode semantics (docs/chaincode-api.md):
 * state machine, locking, escrow, idempotency and the commit-reveal scheme with
 * real sha256/HMAC derivations. Enabled with FABRIC_MOCK=true so the backend
 * runs without a Fabric network.
 *
 * The world state is kept in process memory inside a transaction and synced to
 * an optional MockChainStore (Redis) around it: every transaction first loads
 * the shared snapshot, then flushes its own delta, so the API process, the
 * seed process and reruns all observe one chain. Without a store the adapter
 * behaves exactly as before (unit tests, pure in-memory demo).
 */
@Injectable()
export class MockChainAdapter extends ChainAdapter {
  private readonly logger = new Logger(MockChainAdapter.name);
  private state = new Map<string, Record<string, unknown>>();
  private idem = new Map<string, string>();
  private readonly listeners: ChainEventListener[] = [];
  private readonly store?: MockChainStore;
  /** Snapshot as last loaded from the store; the flush diff is computed against it. */
  private loaded: MockChainSnapshot | null = null;
  /** Serializes persisted transactions so concurrent calls cannot interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(store?: MockChainStore) {
    super();
    if (store) {
      this.store = store;
      const target = this as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      for (const name of PERSISTED_METHODS) {
        const original = target[name];
        if (typeof original !== 'function') {
          throw new Error(`MockChainAdapter.${name} is missing — update PERSISTED_METHODS`);
        }
        target[name] = (...args: unknown[]) =>
          this.runPersisted(() => original.apply(this, args) as Promise<unknown>);
      }
    }
  }

  private runPersisted<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(
      () => this.withStore(fn),
      () => this.withStore(fn),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Load the shared snapshot, run the (synchronous) transaction body, flush the delta. */
  private async withStore<T>(fn: () => Promise<T>): Promise<T> {
    await this.loadRemote();
    const result = await fn();
    await this.flushRemote();
    return result;
  }

  private async loadRemote(): Promise<void> {
    if (!this.store) return;
    const remote = await this.store.load();
    this.loaded = remote;
    this.state = new Map();
    for (const [key, json] of remote.state) {
      this.state.set(key, JSON.parse(json) as Record<string, unknown>);
    }
    this.idem = new Map(remote.idem);
  }

  private async flushRemote(): Promise<void> {
    if (!this.store || !this.loaded) return;
    const delta: MockChainDelta = {
      state: { set: new Map(), del: [] },
      idem: { set: new Map(), del: [] },
    };
    for (const [key, value] of this.state) {
      const json = JSON.stringify(value);
      if (this.loaded.state.get(key) !== json) delta.state.set.set(key, json);
    }
    for (const key of this.loaded.state.keys()) {
      if (!this.state.has(key)) delta.state.del.push(key);
    }
    for (const [key, value] of this.idem) {
      if (this.loaded.idem.get(key) !== value) delta.idem.set.set(key, value);
    }
    for (const key of this.loaded.idem.keys()) {
      if (!this.idem.has(key)) delta.idem.del.push(key);
    }
    this.loaded = null;
    if (delta.state.set.size > 0 || delta.state.del.length > 0 || delta.idem.set.size > 0 || delta.idem.del.length > 0) {
      await this.store.apply(delta);
    }
  }

  onChainEvent(listener: ChainEventListener): void {
    this.listeners.push(listener);
  }

  private emit(name: string, payload: ChainEventPayload): void {
    for (const l of this.listeners) {
      try {
        l(name, payload);
      } catch (err) {
        this.logger.warn(`chain event listener failed: ${(err as Error).message}`);
      }
    }
  }

  private meta(m: TxMeta): { nowISO: string; idemKey: string } {
    return {
      nowISO: m.nowISO ?? new Date().toISOString(),
      idemKey: m.idemKey ?? `auto-${this.idem.size}-${Math.random().toString(36).slice(2, 10)}`,
    };
  }

  /** Idempotency wrapper: replaying idemKey returns the stored first result. */
  private async idempotent<T>(idemKey: string, nowISO: string, fn: () => Promise<T> | T): Promise<T> {
    const key = `IDEMP:${idemKey}`;
    const hit = this.idem.get(key);
    if (hit !== undefined) {
      return JSON.parse(hit) as T;
    }
    const result = await fn();
    this.idem.set(key, JSON.stringify(result ?? null));
    return result;
  }

  private get<T>(key: string, code = 'NOT_FOUND'): T | undefined {
    const raw = this.state.get(key);
    return raw ? (JSON.parse(JSON.stringify(raw)) as T) : undefined;
  }

  private mustGet<T>(key: string, code = 'NOT_FOUND', what = key): T {
    const v = this.get<T>(key, code);
    if (v === undefined) throw new CodedError(code, `${what} does not exist`);
    return v;
  }

  private put(key: string, value: unknown): void {
    this.state.set(key, JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
  }

  private assertSafeInt(n: number, field: string): void {
    if (!Number.isSafeInteger(n)) {
      throw new CodedError('INVALID_AMOUNT', `${field} must be a safe integer, got ${n}`);
    }
  }

  // ---------------------------------------------------------------- PlayerContract
  async registerPlayer(
    as: ChainIdentity,
    args: { playerId: string; nickname: string } & TxMeta,
  ): Promise<PlayerState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      // 链上 RegisterPlayer 仅 admin/system（防抢注 username；后端注册走 ADMIN_IDENTITY）
      if (as.role !== 'admin' && as.role !== 'system') {
        throw new CodedError('FORBIDDEN', 'RegisterPlayer requires role admin or system');
      }
      const key = `player:${args.playerId}`;
      const existing = this.get<PlayerState>(key);
      if (existing) return existing;
      const player: PlayerState = {
        docType: 'player',
        playerId: args.playerId,
        mspId: as.mspId,
        nickname: args.nickname,
        role: 'player',
        points: 1000,
        wins: 0,
        losses: 0,
        rating: RATING_DEFAULT,
        createdAt: nowISO,
      };
      this.put(key, player);
      this.emit('PlayerRegistered', { playerId: player.playerId, nickname: player.nickname });
      return player;
    });
  }

  async grantRole(
    as: ChainIdentity,
    args: { playerId: string; role: string } & TxMeta,
  ): Promise<PlayerState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      if (as.role !== 'admin') {
        throw new CodedError('NOT_ADMIN', 'only admin can grant roles');
      }
      const player = this.mustGet<PlayerState>(`player:${args.playerId}`, 'PLAYER_NOT_FOUND', `player ${args.playerId}`);
      player.role = args.role as PlayerState['role'];
      this.put(`player:${args.playerId}`, player);
      this.emit('RoleGranted', { playerId: args.playerId, role: args.role });
      return player;
    });
  }

  async getPlayer(playerId: string): Promise<PlayerState> {
    return withPlayerDefaults(this.mustGet<PlayerState>(`player:${playerId}`, 'PLAYER_NOT_FOUND', `player ${playerId}`));
  }

  /** 排位分：仅 system、0-99999（chaincode-api.md §2.1 PlayerContract.UpdateRating）。 */
  async updateRating(
    as: ChainIdentity,
    args: { playerId: string; newRating: number; reason: string } & TxMeta,
  ): Promise<PlayerState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      if (as.role !== 'system') {
        throw new CodedError('NOT_AUTHORIZED', 'only system can update the rating');
      }
      if (!Number.isSafeInteger(args.newRating) || args.newRating < 0 || args.newRating > RATING_MAX) {
        throw new CodedError('INVALID_PARAM', `newRating must be a safe integer 0-${RATING_MAX}, got ${args.newRating}`);
      }
      const player = withPlayerDefaults(
        this.mustGet<PlayerState>(`player:${args.playerId}`, 'PLAYER_NOT_FOUND', `player ${args.playerId}`),
      );
      const previous = player.rating;
      player.rating = args.newRating;
      this.put(`player:${args.playerId}`, player);
      this.emit('RatingChanged', { playerId: args.playerId, rating: player.rating, previous, reason: args.reason });
      return player;
    });
  }

  private changePoints(playerId: string, delta: number, reason: string): PlayerState {
    this.assertSafeInt(delta, 'delta');
    const player = this.mustGet<PlayerState>(`player:${playerId}`, 'PLAYER_NOT_FOUND', `player ${playerId}`);
    const next = player.points + delta;
    if (next < 0) {
      throw new CodedError('INSUFFICIENT_POINTS', `player ${playerId} balance ${player.points} cannot cover ${-delta}`);
    }
    player.points = next;
    this.put(`player:${playerId}`, player);
    this.emit('PointsChanged', { playerId, delta, reason, points: next });
    return player;
  }

  async addPoints(
    as: ChainIdentity,
    args: { playerId: string; delta: number; reason: string } & TxMeta,
  ): Promise<PlayerState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      if (as.role !== 'admin' && as.role !== 'system') {
        throw new CodedError('NOT_AUTHORIZED', 'only admin/system can add points');
      }
      return this.changePoints(args.playerId, args.delta, args.reason);
    });
  }

  async transferPoints(
    as: ChainIdentity,
    args: { fromId: string; toId: string; amount: number } & TxMeta,
  ): Promise<{ fromId: string; toId: string; amount: number }> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      if (as.userId !== args.fromId) {
        throw new CodedError('NOT_OWNER', 'caller must be the sender');
      }
      if (!Number.isSafeInteger(args.amount) || args.amount <= 0) {
        throw new CodedError('INVALID_AMOUNT', 'amount must be a positive integer');
      }
      this.mustGet<PlayerState>(`player:${args.toId}`, 'PLAYER_NOT_FOUND', `player ${args.toId}`);
      this.changePoints(args.fromId, -args.amount, 'transfer-out');
      this.changePoints(args.toId, args.amount, 'transfer-in');
      return { fromId: args.fromId, toId: args.toId, amount: args.amount };
    });
  }

  // ---------------------------------------------------------------- RandomContract
  async commitRandom(
    _as: ChainIdentity,
    args: {
      eventId: string;
      purpose: 'capture' | 'battle' | 'mint';
      playerId: string;
      commitHash: string;
      clientSeed: string;
      meta?: string;
    } & TxMeta,
  ): Promise<RandomCommitState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      const key = `rand:${args.eventId}`;
      if (this.state.has(key)) {
        throw new CodedError('EVENT_EXISTS', `random event ${args.eventId} already exists`);
      }
      if (!/^[0-9a-f]{64}$/.test(args.commitHash)) {
        throw new CodedError('INVALID_COMMIT_HASH', 'commitHash must be 64 lowercase hex chars');
      }
      const meta = args.meta ?? '';
      if (Buffer.byteLength(meta, 'utf8') > 256) {
        throw new CodedError('INVALID_PARAM', 'meta must be at most 256 bytes (UTF-8)');
      }
      const commit: RandomCommitState = {
        docType: 'rand',
        eventId: args.eventId,
        purpose: args.purpose,
        playerId: args.playerId,
        commitHash: args.commitHash,
        clientSeed: args.clientSeed,
        serverSeed: '',
        resultHash: '',
        status: 'COMMITTED',
        createdAt: nowISO,
        meta,
      };
      this.put(key, commit);
      this.emit('RandomCommitted', { eventId: args.eventId, purpose: args.purpose, playerId: args.playerId, meta });
      return commit;
    });
  }

  async revealAndVerify(
    as: ChainIdentity,
    args: { eventId: string; serverSeed: string } & TxMeta,
  ): Promise<RandomCommitState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      // 链上 RevealAndVerify 仅 system（serverSeed 只在服务端）
      if (as.role !== 'system') {
        throw new CodedError('NOT_AUTHORIZED', 'only system can reveal a random event');
      }
      const commit = this.mustGet<RandomCommitState>(`rand:${args.eventId}`, 'EVENT_NOT_FOUND', `random event ${args.eventId}`);
      if (commit.status !== 'COMMITTED') {
        throw new CodedError('INVALID_RANDOM_STATE', `random event ${args.eventId} is ${commit.status}, expected COMMITTED`);
      }
      if (sha256hex(args.serverSeed) !== commit.commitHash) {
        throw new CodedError('SEED_MISMATCH', 'sha256(serverSeed) does not match commitHash');
      }
      commit.serverSeed = args.serverSeed;
      commit.resultHash = sha256hex(`${args.serverSeed}|${commit.clientSeed}|${args.eventId}`);
      commit.status = 'REVEALED';
      this.put(`rand:${args.eventId}`, commit);
      this.emit('RandomRevealed', { eventId: args.eventId, resultHash: commit.resultHash });
      return commit;
    });
  }

  async getRandom(eventId: string): Promise<RandomCommitState> {
    const commit = this.mustGet<RandomCommitState>(`rand:${eventId}`, 'EVENT_NOT_FOUND', `random event ${eventId}`);
    if (commit.meta === undefined) commit.meta = ''; // meta 字段上线前的旧记录
    return commit;
  }

  /** Internal: mirrors RandomContract.consumeRandom in the chaincode. */
  private consumeRandom(eventId: string, purpose: string, playerId: string): string {
    const commit = this.mustGet<RandomCommitState>(`rand:${eventId}`, 'EVENT_NOT_FOUND', `random event ${eventId}`);
    if (commit.status !== 'REVEALED') {
      throw new CodedError('RANDOM_NOT_REVEALED', `random event ${eventId} is ${commit.status}, expected REVEALED`);
    }
    if (commit.purpose !== purpose) {
      throw new CodedError('PURPOSE_MISMATCH', `random event purpose ${commit.purpose} != ${purpose}`);
    }
    if (commit.playerId !== playerId) {
      throw new CodedError('PLAYER_MISMATCH', `random event belongs to ${commit.playerId}, not ${playerId}`);
    }
    commit.status = 'CONSUMED';
    this.put(`rand:${eventId}`, commit);
    return commit.resultHash;
  }

  // ---------------------------------------------------------------- PokemonContract
  async mintFromCapture(
    as: ChainIdentity,
    args: {
      id: string;
      playerId: string;
      speciesId: number;
      name: string;
      ivs: PokemonIvs;
      nature: string;
      ability: string;
      shiny: boolean;
      moves: string[];
      dnaHash: string;
      eventId: string;
    } & TxMeta,
  ): Promise<PokemonState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      // 链上 MintFromCapture 仅 system（铸造属性由后端从已验证随机流派生）
      if (as.role !== 'system') {
        throw new CodedError('NOT_AUTHORIZED', 'only system can mint from a capture');
      }
      if (this.state.has(`pokemon:${args.id}`)) {
        throw new CodedError('POKEMON_EXISTS', `pokemon ${args.id} already exists`);
      }
      for (const [k, v] of Object.entries(args.ivs)) {
        if (!Number.isInteger(v) || v < 0 || v > 31) {
          throw new CodedError('INVALID_IV', `iv ${k}=${v} out of range 0-31`);
        }
      }
      if (args.moves.length > 4) {
        throw new CodedError('TOO_MANY_MOVES', 'a pokemon can know at most 4 moves');
      }
      this.consumeRandom(args.eventId, 'capture', args.playerId);
      this.mustGet<PlayerState>(`player:${args.playerId}`, 'PLAYER_NOT_FOUND', `player ${args.playerId}`);
      const pokemon: PokemonState = {
        docType: 'pokemon',
        id: args.id,
        speciesId: args.speciesId,
        name: args.name,
        dnaHash: args.dnaHash,
        ivs: { ...args.ivs },
        evs: zeroEvs(),
        nature: args.nature,
        ability: args.ability,
        shiny: args.shiny,
        level: 5,
        exp: 0,
        moves: [...args.moves],
        ownerId: args.playerId,
        status: 'IDLE',
        lockRef: '',
        captureEventId: args.eventId,
        createdAt: nowISO,
        bond: BOND_DEFAULT,
      };
      this.put(`pokemon:${args.id}`, pokemon);
      this.emit('PokemonMinted', { id: pokemon.id, ownerId: pokemon.ownerId, speciesId: pokemon.speciesId });
      return pokemon;
    });
  }

  async transferPokemon(
    as: ChainIdentity,
    args: { id: string; toId: string } & TxMeta,
  ): Promise<PokemonState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      const pokemon = withPokemonDefaults(this.mustGet<PokemonState>(`pokemon:${args.id}`, 'POKEMON_NOT_FOUND', `pokemon ${args.id}`));
      if (pokemon.ownerId !== as.userId) {
        throw new CodedError('NOT_OWNER', `caller ${as.userId} does not own pokemon ${args.id}`);
      }
      if (pokemon.status !== 'IDLE') {
        throw new CodedError('ASSET_LOCKED', `pokemon ${args.id} is ${pokemon.status}`);
      }
      this.mustGet<PlayerState>(`player:${args.toId}`, 'PLAYER_NOT_FOUND', `player ${args.toId}`);
      // 易主即归零：bond 重置为 30（转给自己不算易主）
      if (pokemon.ownerId !== args.toId) {
        pokemon.bond = BOND_RESET_ON_TRANSFER;
      }
      pokemon.ownerId = args.toId;
      this.put(`pokemon:${args.id}`, pokemon);
      this.emit('PokemonTransferred', { id: args.id, fromId: as.userId, toId: args.toId, bond: pokemon.bond });
      return pokemon;
    });
  }

  async applyGrowth(
    as: ChainIdentity,
    args: { id: string; growth: GrowthPatch } & TxMeta,
  ): Promise<PokemonState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      // 链上 ApplyGrowth 仅 system：等级/EV/IV/物种/昵称都由后端校验成本后以 system 身份代签
      if (as.role !== 'system') {
        throw new CodedError('NOT_AUTHORIZED', 'only system can apply growth');
      }
      const pokemon = withPokemonDefaults(this.mustGet<PokemonState>(`pokemon:${args.id}`, 'POKEMON_NOT_FOUND', `pokemon ${args.id}`));
      if (pokemon.status !== 'IDLE') {
        throw new CodedError('ASSET_LOCKED', `pokemon ${args.id} is ${pokemon.status}`);
      }
      const g = args.growth;
      if (g.level !== undefined) {
        if (!Number.isInteger(g.level) || g.level < 1 || g.level > 100) {
          throw new CodedError('INVALID_LEVEL', 'level must be an integer 1-100');
        }
        if (g.level < pokemon.level) {
          throw new CodedError('LEVEL_REGRESSION', `level cannot decrease (${pokemon.level} -> ${g.level})`);
        }
        pokemon.level = g.level;
      }
      if (g.exp !== undefined) {
        this.assertSafeInt(g.exp, 'exp');
        if (g.exp < 0) throw new CodedError('INVALID_EXP', 'exp must be non-negative');
        pokemon.exp = g.exp;
      }
      if (g.moves !== undefined) {
        if (g.moves.length > 4) throw new CodedError('TOO_MANY_MOVES', 'a pokemon can know at most 4 moves');
        pokemon.moves = [...g.moves];
      }
      if (g.evs !== undefined) {
        pokemon.evs = assertEvs(g.evs, 'growth.evs');
      }
      if (g.ivs !== undefined) {
        pokemon.ivs = applyIvsPatch(g.ivs, pokemon.ivs, 'growth.ivs');
      }
      if (g.speciesId !== undefined) pokemon.speciesId = g.speciesId;
      if (g.name !== undefined) pokemon.name = g.name;
      this.put(`pokemon:${args.id}`, pokemon);
      this.emit('PokemonGrowth', { id: args.id, growth: g as unknown as ChainEventPayload });
      return pokemon;
    });
  }

  async releasePokemon(as: ChainIdentity, args: { id: string } & TxMeta): Promise<PokemonState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      const pokemon = withPokemonDefaults(this.mustGet<PokemonState>(`pokemon:${args.id}`, 'POKEMON_NOT_FOUND', `pokemon ${args.id}`));
      if (pokemon.ownerId !== as.userId) {
        throw new CodedError('NOT_OWNER', `caller ${as.userId} does not own pokemon ${args.id}`);
      }
      if (pokemon.status !== 'IDLE') {
        throw new CodedError('ASSET_LOCKED', `pokemon ${args.id} is ${pokemon.status}`);
      }
      pokemon.status = 'RELEASED';
      pokemon.ownerId = '';
      this.put(`pokemon:${args.id}`, pokemon);
      this.emit('PokemonReleased', { id: args.id, ownerId: as.userId });
      return pokemon;
    });
  }

  /** 羁绊值提升：仅 system、每只 +delta（1-50）、上限 255 截断（chaincode-api.md §2.3）。 */
  async bondUp(
    as: ChainIdentity,
    args: { pokemonIds: string[]; delta: number; reason: string } & TxMeta,
  ): Promise<PokemonState[]> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      if (as.role !== 'system') {
        throw new CodedError('NOT_AUTHORIZED', 'only system can raise bond');
      }
      if (!Array.isArray(args.pokemonIds) || args.pokemonIds.length === 0) {
        throw new CodedError('INVALID_PARAM', 'pokemonIds must be a non-empty array');
      }
      if (args.pokemonIds.length > BOND_UP_MAX_IDS) {
        throw new CodedError('INVALID_PARAM', `pokemonIds must have at most ${BOND_UP_MAX_IDS} entries`);
      }
      if (new Set(args.pokemonIds).size !== args.pokemonIds.length) {
        throw new CodedError('INVALID_PARAM', 'pokemonIds must not contain duplicates');
      }
      if (!Number.isSafeInteger(args.delta) || args.delta < BOND_MIN_DELTA || args.delta > BOND_MAX_DELTA) {
        throw new CodedError('INVALID_PARAM', `delta must be a safe integer ${BOND_MIN_DELTA}-${BOND_MAX_DELTA}, got ${args.delta}`);
      }
      const updated: PokemonState[] = [];
      for (const id of args.pokemonIds) {
        const pokemon = withPokemonDefaults(this.mustGet<PokemonState>(`pokemon:${id}`, 'POKEMON_NOT_FOUND', `pokemon ${id}`));
        if (pokemon.status === 'RELEASED') {
          throw new CodedError('BAD_STATE', `pokemon ${id} is RELEASED`);
        }
        pokemon.bond = Math.min(BOND_MAX, pokemon.bond + args.delta);
        this.put(`pokemon:${id}`, pokemon);
        this.emit('BondChanged', { id, ownerId: pokemon.ownerId, bond: pokemon.bond, delta: args.delta, reason: args.reason });
        updated.push(pokemon);
      }
      return updated;
    });
  }

  async getPokemon(id: string): Promise<PokemonState> {
    return withPokemonDefaults(this.mustGet<PokemonState>(`pokemon:${id}`, 'POKEMON_NOT_FOUND', `pokemon ${id}`));
  }

  async queryPokemonByOwner(ownerId: string): Promise<PokemonState[]> {
    return this.queryAll<PokemonState>('pokemon', (p) => p.ownerId === ownerId).map(withPokemonDefaults);
  }

  async queryPokedex(selector: Record<string, unknown>): Promise<PokemonState[]> {
    return this.queryAll<PokemonState>('pokemon', (p) => this.matchSelector(p, selector)).map(withPokemonDefaults);
  }

  // ---------------------------------------------------------------- ItemContract
  /** 堆叠归一排序键：createdAt 升序（缺失视为 ''，最旧），同刻按 id 字典序。 */
  private stackOrder(a: ItemState, b: ItemState): number {
    const at = a.createdAt ?? '';
    const bt = b.createdAt ?? '';
    if (at !== bt) return at < bt ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  }

  /**
   * Mirrors chaincode mergeIdleStacks (chaincode-api.md §2.4): merge every IDLE stack of
   * (ownerId, typeId) into the oldest one (createdAt, then id), delete the rest. extraIds
   * cover stacks written earlier in this transaction (the chaincode needs them because its
   * CouchDB query only sees committed state; the mock applies the same call shape).
   */
  private mergeIdleStacks(ownerId: string, typeId: string, extraIds: string[] = []): ItemState | null {
    const live: ItemState[] = [];
    for (const raw of this.state.values()) {
      const item = raw as unknown as ItemState;
      if (item.docType !== 'item' || item.ownerId !== ownerId || item.typeId !== typeId || item.status !== 'IDLE') continue;
      live.push(JSON.parse(JSON.stringify(item)) as ItemState);
    }
    for (const id of extraIds) {
      if (live.some((i) => i.id === id)) continue;
      const extra = this.get<ItemState>(`item:${id}`);
      if (extra && extra.docType === 'item' && extra.ownerId === ownerId && extra.typeId === typeId && extra.status === 'IDLE') {
        live.push(extra);
      }
    }
    if (live.length === 0) return null;
    live.sort((a, b) => this.stackOrder(a, b));
    const survivor = live[0];
    if (live.length === 1) return survivor;
    let total = survivor.quantity;
    const merged: Array<{ id: string; quantity: number }> = [];
    for (const item of live.slice(1)) {
      total += item.quantity;
      this.assertSafeInt(total, `merged quantity of ${typeId}`);
      merged.push({ id: item.id, quantity: item.quantity });
      this.state.delete(`item:${item.id}`);
    }
    survivor.quantity = total;
    this.put(`item:${survivor.id}`, survivor);
    this.emit('ItemMerged', { ownerId, typeId, id: survivor.id, quantity: total, merged });
    return survivor;
  }

  async mintItem(
    as: ChainIdentity,
    args: {
      id: string;
      playerId: string;
      typeId: string;
      quantity: number;
      uri: string;
      metadataHash: string;
    } & TxMeta,
  ): Promise<ItemState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      if (as.role !== 'admin' && as.role !== 'system') {
        throw new CodedError('NOT_AUTHORIZED', 'only admin/system can mint items');
      }
      if (this.state.has(`item:${args.id}`)) {
        throw new CodedError('ITEM_EXISTS', `item ${args.id} already exists`);
      }
      this.assertSafeInt(args.quantity, 'quantity');
      if (args.quantity < 0) throw new CodedError('INVALID_AMOUNT', 'quantity must be non-negative');
      this.mustGet<PlayerState>(`player:${args.playerId}`, 'PLAYER_NOT_FOUND', `player ${args.playerId}`);
      const item: ItemState = {
        docType: 'item',
        id: args.id,
        typeId: args.typeId,
        ownerId: args.playerId,
        quantity: args.quantity,
        uri: args.uri,
        metadataHash: args.metadataHash,
        status: 'IDLE',
        lockRef: '',
        createdAt: nowISO,
      };
      this.put(`item:${args.id}`, item);
      this.emit('ItemMinted', { id: item.id, ownerId: item.ownerId, typeId: item.typeId, quantity: item.quantity });
      // mint 后自动归一（与链码一致）：返回合并后的幸存堆叠
      return this.mergeIdleStacks(args.playerId, args.typeId, [args.id]) ?? item;
    });
  }

  /** ItemContract.MergeStacks: owner 本人或 system 可调用；无可合并堆叠时返回 null。 */
  async mergeStacks(as: ChainIdentity, args: { ownerId: string; typeId: string } & TxMeta): Promise<ItemState | null> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      const owner = this.mustGet<PlayerState>(`player:${args.ownerId}`, 'PLAYER_NOT_FOUND', `player ${args.ownerId}`);
      if (as.role !== 'system' && as.userId !== owner.playerId) {
        throw new CodedError('NOT_OWNER', `caller ${as.userId} is not the owner of ${args.ownerId} items`);
      }
      return this.mergeIdleStacks(args.ownerId, args.typeId);
    });
  }

  async transferItem(as: ChainIdentity, args: { id: string; toId: string } & TxMeta): Promise<ItemState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      const item = this.mustGet<ItemState>(`item:${args.id}`, 'ITEM_NOT_FOUND', `item ${args.id}`);
      if (item.ownerId !== as.userId) {
        throw new CodedError('NOT_OWNER', `caller ${as.userId} does not own item ${args.id}`);
      }
      if (item.status !== 'IDLE') {
        throw new CodedError('ASSET_LOCKED', `item ${args.id} is ${item.status}`);
      }
      this.mustGet<PlayerState>(`player:${args.toId}`, 'PLAYER_NOT_FOUND', `player ${args.toId}`);
      item.ownerId = args.toId;
      this.put(`item:${args.id}`, item);
      this.emit('ItemTransferred', { id: args.id, fromId: as.userId, toId: args.toId });
      return item;
    });
  }

  async consumeItem(
    as: ChainIdentity,
    args: { id: string; quantity: number; reason: string } & TxMeta,
  ): Promise<ItemState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      const item = this.mustGet<ItemState>(`item:${args.id}`, 'ITEM_NOT_FOUND', `item ${args.id}`);
      if (item.ownerId !== as.userId && as.role !== 'system') {
        throw new CodedError('NOT_OWNER', 'only the owner or system can consume an item');
      }
      if (item.status !== 'IDLE') {
        throw new CodedError('ASSET_LOCKED', `item ${args.id} is ${item.status}`);
      }
      if (!Number.isSafeInteger(args.quantity) || args.quantity <= 0) {
        throw new CodedError('INVALID_AMOUNT', 'quantity must be a positive integer');
      }
      if (item.quantity < args.quantity) {
        throw new CodedError('INSUFFICIENT_QUANTITY', `item ${args.id} has ${item.quantity}, need ${args.quantity}`);
      }
      item.quantity -= args.quantity;
      this.put(`item:${args.id}`, item);
      this.emit('ItemConsumed', { id: args.id, ownerId: item.ownerId, quantity: args.quantity, reason: args.reason });
      return item;
    });
  }

  async getItem(id: string): Promise<ItemState> {
    return this.mustGet<ItemState>(`item:${id}`, 'ITEM_NOT_FOUND', `item ${id}`);
  }

  async queryItemsByOwner(ownerId: string): Promise<ItemState[]> {
    return this.queryAll<ItemState>('item', (i) => i.ownerId === ownerId);
  }

  // ---------------------------------------------------------------- TradeContract
  private lockPokemon(id: string, expectedOwner: string, lockRef: string, lockStatus: 'LOCKED_TRADE' | 'LOCKED_BATTLE'): PokemonState {
    const pokemon = withPokemonDefaults(this.mustGet<PokemonState>(`pokemon:${id}`, 'POKEMON_NOT_FOUND', `pokemon ${id}`));
    if (pokemon.ownerId !== expectedOwner) {
      throw new CodedError('NOT_OWNER', `pokemon ${id} is owned by ${pokemon.ownerId}, not ${expectedOwner}`);
    }
    if (pokemon.status !== 'IDLE') {
      throw new CodedError('ASSET_LOCKED', `pokemon ${id} is ${pokemon.status}`);
    }
    pokemon.status = lockStatus;
    pokemon.lockRef = lockRef;
    this.put(`pokemon:${id}`, pokemon);
    return pokemon;
  }

  private lockItem(id: string, expectedOwner: string, lockRef: string, lockStatus: 'LOCKED_TRADE' | 'LOCKED_BATTLE'): ItemState {
    const item = this.mustGet<ItemState>(`item:${id}`, 'ITEM_NOT_FOUND', `item ${id}`);
    if (item.ownerId !== expectedOwner) {
      throw new CodedError('NOT_OWNER', `item ${id} is owned by ${item.ownerId}, not ${expectedOwner}`);
    }
    if (item.status !== 'IDLE') {
      throw new CodedError('ASSET_LOCKED', `item ${id} is ${item.status}`);
    }
    item.status = lockStatus;
    item.lockRef = lockRef;
    this.put(`item:${id}`, item);
    return item;
  }

  private unlockTradeAssets(trade: TradeState): void {
    for (const id of [...trade.offer.pokemonIds, ...trade.request.pokemonIds]) {
      const p = this.get<PokemonState>(`pokemon:${id}`);
      if (p && p.status === 'LOCKED_TRADE' && p.lockRef === trade.id) {
        p.status = 'IDLE';
        p.lockRef = '';
        this.put(`pokemon:${id}`, p);
      }
    }
    for (const id of [...trade.offer.itemIds, ...trade.request.itemIds]) {
      const i = this.get<ItemState>(`item:${id}`);
      if (i && i.status === 'LOCKED_TRADE' && i.lockRef === trade.id) {
        i.status = 'IDLE';
        i.lockRef = '';
        this.put(`item:${id}`, i);
      }
    }
  }

  async createTrade(
    as: ChainIdentity,
    args: {
      id: string;
      fromId: string;
      toId: string;
      offer: AssetOffer;
      request: AssetOffer;
      expiresAt: string;
    } & TxMeta,
  ): Promise<TradeState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      if (as.userId !== args.fromId) {
        throw new CodedError('NOT_OWNER', 'caller must be the trade creator (fromId)');
      }
      if (this.state.has(`trade:${args.id}`)) {
        throw new CodedError('TRADE_EXISTS', `trade ${args.id} already exists`);
      }
      this.mustGet<PlayerState>(`player:${args.fromId}`, 'PLAYER_NOT_FOUND', `player ${args.fromId}`);
      this.mustGet<PlayerState>(`player:${args.toId}`, 'PLAYER_NOT_FOUND', `player ${args.toId}`);
      for (const id of args.offer.pokemonIds) this.lockPokemon(id, args.fromId, args.id, 'LOCKED_TRADE');
      for (const id of args.request.pokemonIds) this.lockPokemon(id, args.toId, args.id, 'LOCKED_TRADE');
      for (const id of args.offer.itemIds) this.lockItem(id, args.fromId, args.id, 'LOCKED_TRADE');
      for (const id of args.request.itemIds) this.lockItem(id, args.toId, args.id, 'LOCKED_TRADE');
      for (const [who, pts] of [
        ['from', args.offer.points],
        ['to', args.request.points],
      ] as const) {
        this.assertSafeInt(pts, `${who}.points`);
        if (pts < 0) throw new CodedError('INVALID_AMOUNT', 'points must be non-negative');
        const holder = who === 'from' ? args.fromId : args.toId;
        const player = this.mustGet<PlayerState>(`player:${holder}`);
        if (player.points < pts) {
          throw new CodedError('INSUFFICIENT_POINTS', `player ${holder} balance ${player.points} cannot cover ${pts}`);
        }
      }
      const trade: TradeState = {
        docType: 'trade',
        id: args.id,
        fromId: args.fromId,
        toId: args.toId,
        offer: structuredClone(args.offer),
        request: structuredClone(args.request),
        manifestHash: sha256hex(
          canonicalize({ offer: args.offer, request: args.request, fromId: args.fromId, toId: args.toId }),
        ),
        confirmations: { from: false, to: false },
        status: 'OPEN',
        createdAt: nowISO,
        expiresAt: args.expiresAt,
      };
      this.put(`trade:${args.id}`, trade);
      this.emit('TradeCreated', { id: trade.id, fromId: trade.fromId, toId: trade.toId, manifestHash: trade.manifestHash });
      return trade;
    });
  }

  async confirmTrade(
    as: ChainIdentity,
    args: { id: string; playerId: string } & TxMeta,
  ): Promise<TradeState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      const trade = this.mustGet<TradeState>(`trade:${args.id}`, 'TRADE_NOT_FOUND', `trade ${args.id}`);
      if (args.playerId !== trade.fromId && args.playerId !== trade.toId) {
        throw new CodedError('NOT_PARTY', 'only trade parties can confirm');
      }
      if (as.userId !== args.playerId) {
        throw new CodedError('NOT_PARTY', 'caller must equal playerId');
      }
      if (trade.status !== 'OPEN') {
        throw new CodedError('TRADE_NOT_OPEN', `trade ${args.id} is ${trade.status}`);
      }
      if (nowISO >= trade.expiresAt) {
        this.unlockTradeAssets(trade);
        trade.status = 'EXPIRED';
        this.put(`trade:${trade.id}`, trade);
        this.emit('TradeExpired', { id: trade.id });
        throw new CodedError('TRADE_EXPIRED', `trade ${args.id} has expired`);
      }
      if (args.playerId === trade.fromId) trade.confirmations.from = true;
      else trade.confirmations.to = true;
      this.emit('TradeConfirmed', { id: trade.id, playerId: args.playerId });

      if (trade.confirmations.from && trade.confirmations.to) {
        this.executeTrade(trade);
      } else {
        this.put(`trade:${trade.id}`, trade);
      }
      return this.mustGet<TradeState>(`trade:${trade.id}`);
    });
  }

  /** Atomic execution: every check failure throws and rolls the whole transaction back. */
  private executeTrade(trade: TradeState): void {
    const snapshot = new Map(this.state);
    try {
      const from = this.mustGet<PlayerState>(`player:${trade.fromId}`);
      const to = this.mustGet<PlayerState>(`player:${trade.toId}`);
      if (trade.offer.points > 0 && from.points < trade.offer.points) {
        throw new CodedError('INSUFFICIENT_POINTS', `from ${trade.fromId} cannot cover offer points`);
      }
      if (trade.request.points > 0 && to.points < trade.request.points) {
        throw new CodedError('INSUFFICIENT_POINTS', `to ${trade.toId} cannot cover request points`);
      }
      from.points = from.points - trade.offer.points + trade.request.points;
      to.points = to.points - trade.request.points + trade.offer.points;
      this.put(`player:${trade.fromId}`, from);
      this.put(`player:${trade.toId}`, to);

      for (const id of trade.offer.pokemonIds) {
        const p = withPokemonDefaults(this.mustGet<PokemonState>(`pokemon:${id}`));
        if (p.ownerId !== trade.toId) p.bond = BOND_RESET_ON_TRANSFER;
        p.ownerId = trade.toId;
        p.status = 'IDLE';
        p.lockRef = '';
        this.put(`pokemon:${id}`, p);
      }
      for (const id of trade.request.pokemonIds) {
        const p = withPokemonDefaults(this.mustGet<PokemonState>(`pokemon:${id}`));
        if (p.ownerId !== trade.fromId) p.bond = BOND_RESET_ON_TRANSFER;
        p.ownerId = trade.fromId;
        p.status = 'IDLE';
        p.lockRef = '';
        this.put(`pokemon:${id}`, p);
      }
      for (const id of trade.offer.itemIds) {
        const i = this.mustGet<ItemState>(`item:${id}`);
        i.ownerId = trade.toId;
        i.status = 'IDLE';
        i.lockRef = '';
        this.put(`item:${id}`, i);
      }
      for (const id of trade.request.itemIds) {
        const i = this.mustGet<ItemState>(`item:${id}`);
        i.ownerId = trade.fromId;
        i.status = 'IDLE';
        i.lockRef = '';
        this.put(`item:${id}`, i);
      }
      trade.status = 'EXECUTED';
      this.put(`trade:${trade.id}`, trade);
      this.emit('TradeExecuted', { id: trade.id, fromId: trade.fromId, toId: trade.toId });
      this.emit('PointsChanged', { playerId: trade.fromId, delta: trade.request.points - trade.offer.points, reason: 'trade', points: from.points });
      this.emit('PointsChanged', { playerId: trade.toId, delta: trade.offer.points - trade.request.points, reason: 'trade', points: to.points });
    } catch (err) {
      this.state.clear();
      for (const [k, v] of snapshot) this.state.set(k, v);
      throw err;
    }
  }

  async cancelTrade(
    as: ChainIdentity,
    args: { id: string; playerId: string } & TxMeta,
  ): Promise<TradeState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      const trade = this.mustGet<TradeState>(`trade:${args.id}`, 'TRADE_NOT_FOUND', `trade ${args.id}`);
      if (args.playerId !== trade.fromId && args.playerId !== trade.toId) {
        throw new CodedError('NOT_PARTY', 'only trade parties can cancel');
      }
      if (as.userId !== args.playerId) {
        throw new CodedError('NOT_PARTY', 'caller must equal playerId');
      }
      if (trade.status !== 'OPEN') {
        throw new CodedError('TRADE_NOT_OPEN', `trade ${args.id} is ${trade.status}`);
      }
      this.unlockTradeAssets(trade);
      trade.status = 'CANCELLED';
      this.put(`trade:${trade.id}`, trade);
      this.emit('TradeCancelled', { id: trade.id, playerId: args.playerId });
      return trade;
    });
  }

  async expireTrade(_as: ChainIdentity, args: { id: string } & TxMeta): Promise<TradeState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      const trade = this.mustGet<TradeState>(`trade:${args.id}`, 'TRADE_NOT_FOUND', `trade ${args.id}`);
      if (trade.status !== 'OPEN') {
        throw new CodedError('TRADE_NOT_OPEN', `trade ${args.id} is ${trade.status}`);
      }
      if (nowISO < trade.expiresAt) {
        throw new CodedError('TRADE_NOT_EXPIRED', `trade ${args.id} expires at ${trade.expiresAt}`);
      }
      this.unlockTradeAssets(trade);
      trade.status = 'EXPIRED';
      this.put(`trade:${trade.id}`, trade);
      this.emit('TradeExpired', { id: trade.id });
      return trade;
    });
  }

  async getTrade(id: string): Promise<TradeState> {
    return this.mustGet<TradeState>(`trade:${id}`, 'TRADE_NOT_FOUND', `trade ${id}`);
  }

  async queryTradesByPlayer(playerId: string): Promise<TradeState[]> {
    return this.queryAll<TradeState>('trade', (t) => t.fromId === playerId || t.toId === playerId);
  }

  // ---------------------------------------------------------------- BattleContract
  private lockWager(battleId: string, owner: string, wager: WagerBundle, nowISO: string): void {
    for (const id of wager.pokemonIds) this.lockPokemon(id, owner, battleId, 'LOCKED_BATTLE');
    for (const ref of wagerItemsOf(wager)) this.lockWagerItem(ref, owner, battleId, nowISO);
  }

  /** 部分数量押注：整堆→LOCKED_BATTLE；部分→原堆叠减量保持 IDLE + 确定性 id 子堆叠锁定（chaincode-api.md §2.6）。 */
  private lockWagerItem(ref: ItemStackRef, owner: string, battleId: string, nowISO: string): ItemState {
    const parent = this.mustGet<ItemState>(`item:${ref.id}`, 'ITEM_NOT_FOUND', `item ${ref.id}`);
    if (parent.ownerId !== owner) {
      throw new CodedError('NOT_OWNER', `item ${ref.id} is owned by ${parent.ownerId}, not ${owner}`);
    }
    if (parent.status !== 'IDLE') {
      throw new CodedError('ASSET_LOCKED', `item ${ref.id} is ${parent.status}`);
    }
    if (ref.qty === 0 || ref.qty === parent.quantity) {
      parent.status = 'LOCKED_BATTLE';
      parent.lockRef = battleId;
      this.put(`item:${parent.id}`, parent);
      return parent;
    }
    if (ref.qty > parent.quantity) {
      throw new CodedError('INSUFFICIENT_QUANTITY', `item ${ref.id} has ${parent.quantity}, cannot wager ${ref.qty}`);
    }
    parent.quantity -= ref.qty;
    this.put(`item:${parent.id}`, parent);
    const childId = childStackId(parent.id, battleId);
    if (this.state.has(`item:${childId}`)) {
      throw new CodedError('ITEM_EXISTS', `split stack id ${childId} already exists`);
    }
    const child: ItemState = {
      ...parent,
      id: childId,
      quantity: ref.qty,
      status: 'LOCKED_BATTLE',
      lockRef: battleId,
      createdAt: nowISO,
    };
    this.put(`item:${child.id}`, child);
    return child;
  }

  /** 结算时定位 wager 引用实际锁定的堆叠：整堆锁→原堆叠，拆分锁→子堆叠。 */
  private lockedWagerItem(ref: ItemStackRef, battleId: string): ItemState {
    const parent = this.get<ItemState>(`item:${ref.id}`);
    if (parent && parent.status === 'LOCKED_BATTLE' && parent.lockRef === battleId) return parent;
    const child = this.get<ItemState>(`item:${childStackId(ref.id, battleId)}`);
    if (child && child.status === 'LOCKED_BATTLE' && child.lockRef === battleId) return child;
    throw new CodedError('BAD_STATE', `item ${ref.id} is not locked by battle ${battleId}`);
  }

  async createBattle(
    as: ChainIdentity,
    args: {
      id: string;
      playerA: string;
      playerB: string;
      wagerA: WagerInput;
      wagerB: WagerInput;
      wagerHash: string;
    } & TxMeta,
  ): Promise<BattleState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      const isParty = as.userId === args.playerA || as.userId === args.playerB;
      if (as.role !== 'system' && !isParty) {
        throw new CodedError('NOT_AUTHORIZED', 'only system or a battle party can create the battle');
      }
      if (args.playerA === args.playerB) {
        throw new CodedError('SAME_PLAYER', 'playerA and playerB must differ');
      }
      // 旧 itemIds 格式在解析层归一为 items:[{id,qty:0}]，wagerHash 覆盖归一后的对象
      const wagerA = normalizeWagerBundle(args.wagerA);
      const wagerB = normalizeWagerBundle(args.wagerB);
      const allAssets = [
        ...wagerA.pokemonIds,
        ...wagerB.pokemonIds,
        ...wagerItemsOf(wagerA).map((r) => r.id),
        ...wagerItemsOf(wagerB).map((r) => r.id),
      ];
      if (new Set(allAssets).size !== allAssets.length) {
        throw new CodedError('INVALID_PARAM', 'the same asset cannot appear in both wagers');
      }
      const expected = sha256hex(canonicalize({ playerA: args.playerA, playerB: args.playerB, wagerA, wagerB }));
      if (args.wagerHash !== expected) {
        throw new CodedError('WAGER_HASH_MISMATCH', 'wagerHash does not match canonical wager payload');
      }
      if (this.state.has(`battle:${args.id}`)) {
        throw new CodedError('BATTLE_EXISTS', `battle ${args.id} already exists`);
      }
      const a = this.mustGet<PlayerState>(`player:${args.playerA}`);
      const b = this.mustGet<PlayerState>(`player:${args.playerB}`);
      if (a.points < wagerA.points) {
        throw new CodedError('INSUFFICIENT_POINTS', `player ${args.playerA} cannot cover wager`);
      }
      if (b.points < wagerB.points) {
        throw new CodedError('INSUFFICIENT_POINTS', `player ${args.playerB} cannot cover wager`);
      }
      this.lockWager(args.id, args.playerA, wagerA, nowISO);
      this.lockWager(args.id, args.playerB, wagerB, nowISO);
      a.points -= wagerA.points;
      b.points -= wagerB.points;
      this.put(`player:${args.playerA}`, a);
      this.put(`player:${args.playerB}`, b);

      const battle: BattleState = {
        docType: 'battle',
        id: args.id,
        playerA: args.playerA,
        playerB: args.playerB,
        wagerA,
        wagerB,
        wagerHash: args.wagerHash,
        status: 'CREATED',
        escrow: { pointsA: wagerA.points, pointsB: wagerB.points },
        result: { winnerId: '', resultHash: '', serverSig: '', serverSubmitted: false, confirmations: { A: false, B: false } },
        disputeReason: '',
        arbiterNote: '',
        createdAt: nowISO,
        settledAt: '',
      };
      this.put(`battle:${args.id}`, battle);
      this.emit('BattleCreated', { id: battle.id, playerA: battle.playerA, playerB: battle.playerB });
      this.emit('PointsChanged', { playerId: args.playerA, delta: -wagerA.points, reason: 'battle-escrow', points: a.points });
      this.emit('PointsChanged', { playerId: args.playerB, delta: -wagerB.points, reason: 'battle-escrow', points: b.points });
      return battle;
    });
  }

  async activateBattle(as: ChainIdentity, args: { id: string } & TxMeta): Promise<BattleState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      if (as.role !== 'system') throw new CodedError('NOT_AUTHORIZED', 'only system can activate a battle');
      const battle = this.mustGet<BattleState>(`battle:${args.id}`, 'BATTLE_NOT_FOUND', `battle ${args.id}`);
      if (battle.status !== 'CREATED') {
        throw new CodedError('INVALID_BATTLE_STATE', `battle ${args.id} is ${battle.status}, expected CREATED`);
      }
      battle.status = 'ACTIVE';
      this.put(`battle:${battle.id}`, battle);
      this.emit('BattleActivated', { id: battle.id });
      return battle;
    });
  }

  async submitBattleResult(
    as: ChainIdentity,
    args: { id: string; winnerId: string; resultHash: string; serverSig: string } & TxMeta,
  ): Promise<BattleState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      if (as.role !== 'system') throw new CodedError('NOT_AUTHORIZED', 'only system can submit a result');
      const battle = this.mustGet<BattleState>(`battle:${args.id}`, 'BATTLE_NOT_FOUND', `battle ${args.id}`);
      if (battle.status !== 'ACTIVE') {
        throw new CodedError('INVALID_BATTLE_STATE', `battle ${args.id} is ${battle.status}, expected ACTIVE`);
      }
      if (args.winnerId !== 'DRAW' && args.winnerId !== battle.playerA && args.winnerId !== battle.playerB) {
        throw new CodedError('INVALID_WINNER', 'winnerId must be a party or DRAW');
      }
      battle.result.winnerId = args.winnerId;
      battle.result.resultHash = args.resultHash;
      battle.result.serverSig = args.serverSig;
      battle.result.serverSubmitted = true;
      battle.status = 'RESULT_SUBMITTED';
      this.put(`battle:${battle.id}`, battle);
      this.emit('BattleResultSubmitted', { id: battle.id, winnerId: args.winnerId, resultHash: args.resultHash });
      return battle;
    });
  }

  async confirmBattleResult(
    as: ChainIdentity,
    args: { id: string; playerId: string } & TxMeta,
  ): Promise<BattleState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      const battle = this.mustGet<BattleState>(`battle:${args.id}`, 'BATTLE_NOT_FOUND', `battle ${args.id}`);
      if (args.playerId !== battle.playerA && args.playerId !== battle.playerB) {
        throw new CodedError('NOT_PARTY', 'only battle parties can confirm the result');
      }
      if (as.userId !== args.playerId) {
        throw new CodedError('NOT_PARTY', 'caller must equal playerId');
      }
      if (battle.status !== 'RESULT_SUBMITTED') {
        throw new CodedError('INVALID_BATTLE_STATE', `battle ${args.id} is ${battle.status}, expected RESULT_SUBMITTED`);
      }
      if (args.playerId === battle.playerA) battle.result.confirmations.A = true;
      else battle.result.confirmations.B = true;
      this.put(`battle:${battle.id}`, battle);
      this.emit('BattleConfirmed', { id: battle.id, playerId: args.playerId });
      if (battle.result.confirmations.A && battle.result.confirmations.B) {
        return this.settleInternal(battle, battle.result.winnerId, nowISO, 'SETTLED');
      }
      return battle;
    });
  }

  async settleBattle(as: ChainIdentity, args: { id: string } & TxMeta): Promise<BattleState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      if (as.role !== 'system') throw new CodedError('NOT_AUTHORIZED', 'only system can settle a battle');
      const battle = this.mustGet<BattleState>(`battle:${args.id}`, 'BATTLE_NOT_FOUND', `battle ${args.id}`);
      if (battle.status === 'SETTLED' || battle.status === 'REFUNDED') return battle;
      if (battle.status !== 'RESULT_SUBMITTED') {
        throw new CodedError('INVALID_BATTLE_STATE', `battle ${args.id} is ${battle.status}, expected RESULT_SUBMITTED`);
      }
      return this.settleInternal(battle, battle.result.winnerId, nowISO, 'SETTLED');
    });
  }

  async forfeitBattle(
    as: ChainIdentity,
    args: { id: string; loserId: string; reason: string } & TxMeta,
  ): Promise<BattleState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      if (as.role !== 'system') throw new CodedError('NOT_AUTHORIZED', 'only system can forfeit a battle');
      const battle = this.mustGet<BattleState>(`battle:${args.id}`, 'BATTLE_NOT_FOUND', `battle ${args.id}`);
      if (battle.status !== 'ACTIVE' && battle.status !== 'RESULT_SUBMITTED') {
        throw new CodedError('INVALID_BATTLE_STATE', `battle ${args.id} is ${battle.status}`);
      }
      if (args.loserId !== battle.playerA && args.loserId !== battle.playerB) {
        throw new CodedError('NOT_PARTY', 'loserId must be a battle party');
      }
      const winner = args.loserId === battle.playerA ? battle.playerB : battle.playerA;
      battle.result.winnerId = winner;
      if (!battle.result.serverSubmitted) {
        battle.result.resultHash = sha256hex(`forfeit|${battle.id}|${args.loserId}|${args.reason}`);
        battle.result.serverSubmitted = true;
      }
      this.emit('BattleForfeited', { id: battle.id, loserId: args.loserId, reason: args.reason });
      return this.settleInternal(battle, winner, nowISO, 'SETTLED');
    });
  }

  async disputeBattle(
    as: ChainIdentity,
    args: { id: string; playerId: string; reason: string } & TxMeta,
  ): Promise<BattleState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      const battle = this.mustGet<BattleState>(`battle:${args.id}`, 'BATTLE_NOT_FOUND', `battle ${args.id}`);
      if (args.playerId !== battle.playerA && args.playerId !== battle.playerB) {
        throw new CodedError('NOT_PARTY', 'only battle parties can dispute');
      }
      if (as.userId !== args.playerId) {
        throw new CodedError('NOT_PARTY', 'caller must equal playerId');
      }
      if (battle.status === 'SETTLED' || battle.status === 'REFUNDED') {
        throw new CodedError('INVALID_BATTLE_STATE', `battle ${args.id} already settled`);
      }
      battle.status = 'DISPUTED';
      battle.disputeReason = args.reason;
      this.put(`battle:${battle.id}`, battle);
      this.emit('BattleDisputed', { id: battle.id, playerId: args.playerId, reason: args.reason });
      return battle;
    });
  }

  async arbitrateBattle(
    as: ChainIdentity,
    args: { id: string; outcome: string; arbiterNote: string } & TxMeta,
  ): Promise<BattleState> {
    const { nowISO, idemKey } = this.meta(args);
    return this.idempotent(idemKey, nowISO, () => {
      if (as.mspId !== 'Org2MSP' || as.role !== 'arbitrator') {
        throw new CodedError('NOT_ARBITRATOR', 'only an Org2 arbitrator can arbitrate');
      }
      const battle = this.mustGet<BattleState>(`battle:${args.id}`, 'BATTLE_NOT_FOUND', `battle ${args.id}`);
      if (battle.status !== 'DISPUTED') {
        throw new CodedError('INVALID_BATTLE_STATE', `battle ${args.id} is ${battle.status}, expected DISPUTED`);
      }
      battle.arbiterNote = args.arbiterNote;
      this.emit('BattleArbitrated', { id: battle.id, outcome: args.outcome, arbiter: as.userId });
      if (args.outcome === 'DRAW') {
        return this.settleInternal(battle, 'DRAW', nowISO, 'SETTLED');
      }
      if (args.outcome === 'REFUND') {
        return this.settleInternal(battle, 'REFUND', nowISO, 'REFUNDED');
      }
      if (args.outcome !== battle.playerA && args.outcome !== battle.playerB) {
        throw new CodedError('INVALID_OUTCOME', 'outcome must be a winnerId, DRAW or REFUND');
      }
      battle.result.winnerId = args.outcome;
      return this.settleInternal(battle, args.outcome, nowISO, 'SETTLED');
    });
  }

  /** Single settle path for every outcome (chaincode-api.md §2.6 settle rules). */
  private settleInternal(
    battle: BattleState,
    outcome: string,
    nowISO: string,
    finalStatus: 'SETTLED' | 'REFUNDED',
  ): BattleState {
    const snapshot = new Map(this.state);
    try {
      const a = this.mustGet<PlayerState>(`player:${battle.playerA}`);
      const b = this.mustGet<PlayerState>(`player:${battle.playerB}`);
      const escrowTotal = battle.escrow.pointsA + battle.escrow.pointsB;
      const wagers: Array<{ wager: WagerBundle; owner: string }> = [
        { wager: battle.wagerA, owner: battle.playerA },
        { wager: battle.wagerB, owner: battle.playerB },
      ];
      const lockedItems = wagers.flatMap(({ wager }) => wagerItemsOf(wager).map((ref) => this.lockedWagerItem(ref, battle.id)));

      const givePokemon = (wager: WagerBundle, toOwner: string) => {
        for (const id of wager.pokemonIds) {
          const p = withPokemonDefaults(this.mustGet<PokemonState>(`pokemon:${id}`));
          // 易主即归零：押注宝可梦被对手赢走时 bond 重置为 30（赢家自有宝可梦保持）
          if (p.ownerId !== toOwner) p.bond = BOND_RESET_ON_TRANSFER;
          p.ownerId = toOwner;
          p.status = 'IDLE';
          p.lockRef = '';
          this.put(`pokemon:${id}`, p);
        }
      };

      if (outcome === 'DRAW' || outcome === 'REFUND') {
        for (const { wager, owner } of wagers) givePokemon(wager, owner);
        // 子堆叠数量并回原堆叠（原堆叠仍存在、IDLE 且同 owner 时），否则恢复为独立 IDLE 堆叠
        for (const item of lockedItems) {
          const parentId = parentStackIdOf(item.id);
          const parent = parentId ? this.get<ItemState>(`item:${parentId}`) : undefined;
          if (parent && parent.status === 'IDLE' && parent.ownerId === item.ownerId && parent.typeId === item.typeId) {
            parent.quantity += item.quantity;
            this.assertSafeInt(parent.quantity, `merged quantity of ${parent.typeId}`);
            this.put(`item:${parent.id}`, parent);
            this.state.delete(`item:${item.id}`);
            continue;
          }
          item.status = 'IDLE';
          item.lockRef = '';
          this.put(`item:${item.id}`, item);
        }
        a.points += battle.escrow.pointsA;
        b.points += battle.escrow.pointsB;
      } else {
        const winner = outcome === battle.playerA ? a : b;
        const loser = outcome === battle.playerA ? b : a;
        const winnerWager = outcome === battle.playerA ? battle.wagerA : battle.wagerB;
        const loserWager = outcome === battle.playerA ? battle.wagerB : battle.wagerA;
        givePokemon(winnerWager, winner.playerId);
        givePokemon(loserWager, winner.playerId);
        for (const item of lockedItems) {
          item.ownerId = winner.playerId;
          item.status = 'IDLE';
          item.lockRef = '';
          this.put(`item:${item.id}`, item);
        }
        // 赢家收到的堆叠与同 typeId 的 IDLE 堆叠归一（含本交易改写的堆叠）
        for (const typeId of [...new Set(lockedItems.map((i) => i.typeId))].sort()) {
          this.mergeIdleStacks(
            winner.playerId,
            typeId,
            lockedItems.filter((i) => i.typeId === typeId).map((i) => i.id),
          );
        }
        winner.points += escrowTotal;
        winner.wins += 1;
        loser.losses += 1;
      }
      this.put(`player:${a.playerId}`, a);
      this.put(`player:${b.playerId}`, b);

      battle.escrow = { pointsA: 0, pointsB: 0 };
      battle.status = finalStatus;
      battle.settledAt = nowISO;
      this.put(`battle:${battle.id}`, battle);
      this.emit('BattleSettled', {
        id: battle.id,
        winnerId: outcome === 'DRAW' || outcome === 'REFUND' ? '' : outcome,
        outcome,
        playerA: battle.playerA,
        playerB: battle.playerB,
        pointsA: a.points,
        pointsB: b.points,
      });
      return this.mustGet<BattleState>(`battle:${battle.id}`);
    } catch (err) {
      this.state.clear();
      for (const [k, v] of snapshot) this.state.set(k, v);
      throw err;
    }
  }

  async getBattle(id: string): Promise<BattleState> {
    return this.mustGet<BattleState>(`battle:${id}`, 'BATTLE_NOT_FOUND', `battle ${id}`);
  }

  async queryBattlesByPlayer(playerId: string): Promise<BattleState[]> {
    return this.queryAll<BattleState>('battle', (x) => x.playerA === playerId || x.playerB === playerId);
  }

  // ---------------------------------------------------------------- helpers
  private queryAll<T extends { docType: string }>(docType: string, pred: (v: T) => boolean): T[] {
    const out: T[] = [];
    for (const raw of this.state.values()) {
      if ((raw as { docType?: string }).docType === docType) {
        const v = JSON.parse(JSON.stringify(raw)) as T;
        if (pred(v)) out.push(v);
      }
    }
    return out;
  }

  private matchSelector(doc: unknown, selector: Record<string, unknown>): boolean {
    const record = doc as Record<string, unknown>;
    for (const [k, v] of Object.entries(selector)) {
      if (record[k] !== v) return false;
    }
    return true;
  }

  /** Test/demo helper: wipe all state (shared store included). */
  async resetAll(): Promise<void> {
    this.state.clear();
    this.idem.clear();
    this.loaded = null;
    await this.store?.clear();
  }
}
