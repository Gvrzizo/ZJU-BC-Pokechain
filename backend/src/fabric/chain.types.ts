// On-chain world-state models, mirroring docs/chaincode-api.md §1.

export type ChainRole = 'player' | 'admin' | 'system' | 'arbitrator';

export interface ChainIdentity {
  mspId: string;
  role: ChainRole;
  /** playerId of the acting user; 'system'/'admin' for service identities */
  userId: string;
}

export const SYSTEM_IDENTITY: ChainIdentity = {
  mspId: 'Org1MSP',
  role: 'system',
  userId: 'system',
};

export const ADMIN_IDENTITY: ChainIdentity = {
  mspId: 'Org1MSP',
  role: 'admin',
  userId: 'admin',
};

export function identityForUser(user: {
  username: string;
  role: string;
  fabricMspId?: string | null;
}): ChainIdentity {
  const role = (['player', 'admin', 'arbitrator'].includes(user.role) ? user.role : 'player') as ChainRole;
  return {
    mspId: user.fabricMspId || 'Org1MSP',
    role,
    userId: user.username,
  };
}

export interface PlayerState {
  docType: 'player';
  playerId: string;
  mspId: string;
  nickname: string;
  role: ChainRole;
  points: number;
  wins: number;
  losses: number;
  /** 排位分：注册即 1000，仅 system 经 PlayerContract.UpdateRating 变更（0-99999）。 */
  rating: number;
  createdAt: string;
  /** ISO 时间戳：此前禁止转出积分（H10 注册 72h 锁）；缺省/空串 = 无锁（旧记录兼容）。 */
  transferLockUntil?: string;
}

export type PokemonStatus = 'IDLE' | 'LOCKED_TRADE' | 'LOCKED_BATTLE' | 'RELEASED';

export interface PokemonIvs {
  hp: number;
  atk: number;
  def: number;
  spatk: number;
  spdef: number;
  speed: number;
}

/** 努力值 EV（单项 0-255、总和 ≤510）。链上只存 IV/EV，最终能力值由 backend game-data/stats 计算。 */
export type PokemonEvs = PokemonIvs;

export interface PokemonState {
  docType: 'pokemon';
  id: string;
  speciesId: number;
  name: string;
  dnaHash: string;
  ivs: PokemonIvs;
  evs: PokemonEvs;
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
  /** 羁绊值 0-255：铸造 50、易主（转移/交易/对战押注易主）重置 30，BondUp 提升。 */
  bond: number;
  /** 链下按 game-data/stats 计算出的六项最终能力值（链上不存，API 组装时附带）。 */
  stats?: PokemonIvs;
}

export type ItemStatus = 'IDLE' | 'LOCKED_TRADE' | 'LOCKED_BATTLE';

export interface ItemState {
  docType: 'item';
  id: string;
  typeId: string;
  ownerId: string;
  quantity: number;
  uri: string;
  metadataHash: string;
  status: ItemStatus;
  lockRef: string;
  /** 铸造/拆分时间（ISO）；堆叠合并按它判定"最早创建的堆叠"，旧记录缺失视为 ''。 */
  createdAt: string;
}

/** 押注道具引用：qty=0 是旧 itemIds 格式归一后的"整堆"标记，显式 qty 必须 ≥1。 */
export interface ItemStackRef {
  id: string;
  qty: number;
}

/** 归一后的对战押注包（chaincode-api.md §1 Battle）。 */
export interface WagerBundle {
  pokemonIds: string[];
  items: ItemStackRef[];
  points: number;
}

/** 押注输入：接受归一后的 items[] 或旧 itemIds[]（不可混用）。 */
export interface WagerInput {
  pokemonIds?: string[];
  items?: ItemStackRef[];
  itemIds?: string[];
  points?: number;
}

export type RandomStatus = 'COMMITTED' | 'REVEALED' | 'CONSUMED';

export interface RandomCommitState {
  docType: 'rand';
  eventId: string;
  purpose: 'capture' | 'battle' | 'mint';
  playerId: string;
  commitHash: string;
  clientSeed: string;
  serverSeed: string;
  resultHash: string;
  status: RandomStatus;
  createdAt: string;
  /** 链下上下文备注（≤256 字节 UTF-8），Commit 时上链留痕；旧记录视为 ''。 */
  meta: string;
}

export interface AssetOffer {
  pokemonIds: string[];
  itemIds: string[];
  points: number;
}

export type TradeStatus = 'OPEN' | 'EXECUTED' | 'CANCELLED' | 'EXPIRED';

export interface TradeState {
  docType: 'trade';
  id: string;
  fromId: string;
  toId: string;
  offer: AssetOffer;
  request: AssetOffer;
  manifestHash: string;
  confirmations: { from: boolean; to: boolean };
  status: TradeStatus;
  createdAt: string;
  expiresAt: string;
}

export type BattleStatus =
  | 'CREATED'
  | 'ACTIVE'
  | 'RESULT_SUBMITTED'
  | 'SETTLED'
  | 'DISPUTED'
  | 'REFUNDED';

export interface BattleResultState {
  winnerId: string;
  resultHash: string;
  serverSig: string;
  serverSubmitted: boolean;
  confirmations: { A: boolean; B: boolean };
}

export interface BattleState {
  docType: 'battle';
  id: string;
  playerA: string;
  playerB: string;
  wagerA: WagerBundle;
  wagerB: WagerBundle;
  wagerHash: string;
  status: BattleStatus;
  escrow: { pointsA: number; pointsB: number };
  result: BattleResultState;
  disputeReason: string;
  arbiterNote: string;
  createdAt: string;
  settledAt: string;
}

export interface ChainEventPayload {
  [key: string]: unknown;
}

// ---- 已知关键事件的强类型视图（P2-2b）----
// 链码与 Mock 共用这些 payload 类型；未收录的事件仍可按 string + ChainEventPayload 订阅。
// 字段大多可选是刻意的：真链历史/Mock 旧记录可能缺字段，消费方必须容忍。

/** 积分变化：加/扣分、转账、交易、押注托管、arena 结算都会发（chaincode-api.md §2.1）。 */
export interface PointsChangedEvent extends ChainEventPayload {
  playerId?: string;
  fromId?: string;
  toId?: string;
  delta?: number;
  /** 链码字段名 balance，Mock 历史字段名 points；两个都出现时以 balance 为准。 */
  balance?: number;
  points?: number;
  amount?: number;
  reason?: string;
}

/** 对局结算（ConfirmResult 双确认、SettleBattle、Forfeit、Arbitrate、CancelBattle）。 */
export interface BattleSettledChainEvent extends ChainEventPayload {
  id: string;
  winnerId: string;
  playerA?: string;
  playerB?: string;
  outcome?: string;
  via?: string;
}

/** 道具堆叠归一（ItemContract.MergeStacks / 交易、押注结算时的自动合并）。 */
export interface ItemMergedEvent extends ChainEventPayload {
  ownerId: string;
  typeId: string;
  id: string;
  quantity: number;
  merged: string[];
}

/** 玩家注册（排行榜首次建索引依赖它）。 */
export interface PlayerRegisteredEvent extends ChainEventPayload {
  playerId: string;
  nickname?: string;
  mspId?: string;
}

export interface ChainEventMap {
  PointsChanged: PointsChangedEvent;
  BattleSettled: BattleSettledChainEvent;
  ItemMerged: ItemMergedEvent;
  PlayerRegistered: PlayerRegisteredEvent;
}

export type ChainEventName = keyof ChainEventMap;

/** 判别联合：`event.name` 收窄后 `event.payload` 自动变成对应强类型。 */
export type ChainEvent<K extends ChainEventName = ChainEventName> = { name: K; payload: ChainEventMap[K] };

export type ChainEventListener = (name: string, payload: ChainEventPayload) => void;

export interface GrowthPatch {
  level?: number;
  exp?: number;
  moves?: string[];
  evs?: PokemonEvs;
  /** IV 子集（王冠类道具）：每维 0-31 且只能升不能降，违反抛 IV_DECREASE。 */
  ivs?: Partial<PokemonIvs>;
  speciesId?: number;
  name?: string;
}
