import { fail } from './assert';

export type PokemonStatus = 'IDLE' | 'LOCKED_TRADE' | 'LOCKED_BATTLE' | 'RELEASED';
export type ItemStatus = 'IDLE' | 'LOCKED_TRADE' | 'LOCKED_BATTLE';
export type RandStatus = 'COMMITTED' | 'REVEALED' | 'CONSUMED';
export type RandPurpose = 'capture' | 'battle' | 'mint';
export type TradeStatus = 'OPEN' | 'EXECUTED' | 'CANCELLED' | 'EXPIRED';
export type BattleStatus = 'CREATED' | 'ACTIVE' | 'RESULT_SUBMITTED' | 'DISPUTED' | 'SETTLED' | 'REFUNDED';

/** 排位分：注册即 1000，仅 system 经 PlayerContract.UpdateRating 变更（0-99999）。 */
export const RATING_DEFAULT = 1000;

/**
 * 注册积分与转账锁（H10 经济重平衡）：新账号初始 400P，注册后 72h 内不能把积分转出
 * （TransferPoints，以及交易里由本人支付的 offer/request 积分）。目的是堵"多开小号→主号转账"。
 * 演示账号由 seed 以 admin 身份 `ClearTransferLock` 解锁；旧记录缺 transferLockUntil = 无锁。
 */
export const INITIAL_POINTS = 400;
export const TRANSFER_LOCK_MS = 72 * 3600 * 1000;
export const RATING_MAX = 99999;

export interface Player {
  docType: 'player';
  playerId: string;
  mspId: string;
  nickname: string;
  role: string;
  points: number;
  wins: number;
  losses: number;
  rating: number;
  createdAt: string;
  /** ISO 时间戳：此前禁止转出积分；缺省/空串 = 无锁（旧记录兼容）。 */
  transferLockUntil?: string;
}

export interface Ivs {
  hp: number;
  atk: number;
  def: number;
  spatk: number;
  spdef: number;
  speed: number;
}

export const IV_KEYS = ['hp', 'atk', 'def', 'spatk', 'spdef', 'speed'] as const;
export const IV_MAX = 31;

/** 羁绊值：铸造 50、所有权变更（易主）重置为 30、上限 255（docs/chaincode-api.md §1 Pokemon）。 */
export const BOND_DEFAULT = 50;
export const BOND_RESET_ON_TRANSFER = 30;
export const BOND_MAX = 255;
export const BOND_MIN_DELTA = 1;
export const BOND_MAX_DELTA = 50;
export const BOND_UP_MAX_IDS = 100;

/** 努力值 EV：单项 0-255、六项总和 ≤510（第三世代规则）。能力值 = f(种族值, IV, EV, 等级, 性格)，链上只存 IV/EV。 */
export type Evs = Ivs;

export const EV_KEYS = ['hp', 'atk', 'def', 'spatk', 'spdef', 'speed'] as const;
export const EV_MAX_PER_STAT = 255;
export const EV_MAX_TOTAL = 510;

export function zeroEvs(): Evs {
  return { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 };
}

/** 校验 EV 对象：六项齐全、单项 0-255、总和 ≤510。 */
export function assertEvs(evs: unknown, field: string): Evs {
  const record = (evs ?? {}) as Record<string, unknown>;
  const out = zeroEvs();
  let total = 0;
  for (const key of EV_KEYS) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > EV_MAX_PER_STAT) {
      fail('INVALID_PARAM', `${field}.${key} must be a safe integer 0-${EV_MAX_PER_STAT}, got "${String(value)}"`);
    }
    out[key] = value;
    total += value;
  }
  if (total > EV_MAX_TOTAL) {
    fail('INVALID_PARAM', `${field} total ${total} exceeds ${EV_MAX_TOTAL}`);
  }
  return out;
}

/**
 * ApplyGrowth.growth.ivs：六维子集（王冠类道具只提升单项），每维 0-31 整数且只能升不能降，
 * 降低抛 `IV_DECREASE`；未提供的项保持不变。
 */
export function applyIvsPatch(patch: unknown, current: Ivs, field: string): Ivs {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    fail('INVALID_PARAM', `${field} must be a JSON object`);
  }
  const record = patch as Record<string, unknown>;
  const next: Ivs = { ...current };
  for (const key of Object.keys(record)) {
    if (!(IV_KEYS as readonly string[]).includes(key)) {
      fail('INVALID_PARAM', `${field}.${key} is not an IV stat`);
    }
    const stat = key as (typeof IV_KEYS)[number];
    const value = record[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > IV_MAX) {
      fail('INVALID_PARAM', `${field}.${key} must be a safe integer 0-${IV_MAX}, got "${String(value)}"`);
    }
    if (value < current[stat]) {
      fail('IV_DECREASE', `${field}.${key} cannot decrease (${current[stat]} -> ${value})`);
    }
    next[stat] = value;
  }
  return next;
}

/** 羁绊值 bond：随同一位训练家成长累积，易主即重置（0-255，docs/chaincode-api.md §1）。 */
export interface Pokemon {
  docType: 'pokemon';
  id: string;
  speciesId: number;
  name: string;
  dnaHash: string;
  ivs: Ivs;
  evs: Evs;
  nature: string;
  ability: string;
  shiny: boolean;
  level: number;
  exp: number;
  moves: string[];
  ownerId: string;
  status: PokemonStatus;
  lockRef: string;
  captureEventId: string;
  createdAt: string;
  bond: number;
}

export interface Item {
  docType: 'item';
  id: string;
  typeId: string;
  ownerId: string;
  quantity: number;
  uri: string;
  metadataHash: string;
  status: ItemStatus;
  lockRef: string;
  /** 铸造/拆分时间（ISO）；自动合并按它判定"最早创建的堆叠"。旧记录缺失时视为 ''（最早）。 */
  createdAt: string;
}

/** 押注道具引用：`qty=0` 是旧 itemIds 格式归一后的"整堆"标记，显式 qty 必须 ≥1。 */
export interface ItemStackRef {
  id: string;
  qty: number;
}

/** 对战押注包：`items:[{id,qty}]` 支持部分数量（docs/chaincode-api.md §1 Battle）。 */
export interface WagerBundle {
  pokemonIds: string[];
  items: ItemStackRef[];
  points: number;
}

/** wager 输入（兼容旧 itemIds）；计算 wagerHash 前须先按 parseWagerBundle 的规则归一。 */
export interface WagerInput {
  pokemonIds?: string[];
  items?: ItemStackRef[];
  itemIds?: string[];
  points?: number;
}

export interface RandomCommit {
  docType: 'rand';
  eventId: string;
  purpose: RandPurpose;
  playerId: string;
  commitHash: string;
  clientSeed: string;
  serverSeed: string;
  resultHash: string;
  status: RandStatus;
  createdAt: string;
  /** 链下上下文备注（≤256 字节 UTF-8），随 Commit 上链留痕；旧记录缺省视为 ''。 */
  meta: string;
}

export interface AssetBundle {
  pokemonIds: string[];
  itemIds: string[];
  points: number;
}

export interface Trade {
  docType: 'trade';
  id: string;
  fromId: string;
  toId: string;
  offer: AssetBundle;
  request: AssetBundle;
  manifestHash: string;
  confirmations: { from: boolean; to: boolean };
  status: TradeStatus;
  createdAt: string;
  expiresAt: string;
}

export interface BattleResult {
  winnerId: string;
  resultHash: string;
  serverSig: string;
  serverSubmitted: boolean;
  confirmations: { A: boolean; B: boolean };
}

export interface Battle {
  docType: 'battle';
  id: string;
  playerA: string;
  playerB: string;
  /** 归一后的押注包：{pokemonIds, items:[{id,qty}], points}（qty=0 表示旧格式整堆）。 */
  wagerA: WagerBundle;
  wagerB: WagerBundle;
  wagerHash: string;
  status: BattleStatus;
  escrow: { pointsA: number; pointsB: number };
  result: BattleResult;
  disputeReason: string;
  arbiterNote: string;
  createdAt: string;
  settledAt: string;
}

export interface IdempotencyRecord {
  docType: 'idemp';
  key: string;
  result: string;
  createdAt: string;
}
