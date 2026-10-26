import {
  AssetOffer,
  BreedArgs,
  BattleState,
  BreedingConfigState,
  ChainEventListener,
  ChainHistoryEntry,
  ChainHistoryResult,
  ChainIdentity,
  GrowthPatch,
  LineageState,
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
import { canonicalize, sha256hex } from '../common/utils/crypto.util';
import { CodedError } from '../common/utils/errors';

export interface TxMeta {
  nowISO?: string;
  idemKey?: string;
}

/**
 * One method per chaincode transaction/query (docs/chaincode-api.md §2).
 * Implemented by FabricChainAdapter (real network) and MockChainAdapter (in-memory).
 * All mutating methods honour idemKey: replaying a key returns the first result
 * without re-applying state changes.
 */
export abstract class ChainAdapter {
  // ---- PlayerContract ----
  abstract registerPlayer(
    as: ChainIdentity,
    args: { playerId: string; nickname: string } & TxMeta,
  ): Promise<PlayerState>;
  abstract grantRole(
    as: ChainIdentity,
    args: { playerId: string; role: string } & TxMeta,
  ): Promise<PlayerState>;
  abstract getPlayer(playerId: string): Promise<PlayerState>;
  abstract addPoints(
    as: ChainIdentity,
    args: { playerId: string; delta: number; reason: string } & TxMeta,
  ): Promise<PlayerState>;
  /** PlayerContract.ClearTransferLock：仅 admin/system，解除 72h 转账锁（H10）。 */
  abstract clearTransferLock(
    as: ChainIdentity,
    args: { playerId: string } & TxMeta,
  ): Promise<PlayerState>;
  /** PlayerContract.UpdateRating：仅 system，0-99999（chaincode-api.md §2.1）。 */
  abstract updateRating(
    as: ChainIdentity,
    args: { playerId: string; newRating: number; reason: string } & TxMeta,
  ): Promise<PlayerState>;
  abstract transferPoints(
    as: ChainIdentity,
    args: { fromId: string; toId: string; amount: number } & TxMeta,
  ): Promise<{ fromId: string; toId: string; amount: number }>;

  // ---- RandomContract ----
  abstract commitRandom(
    as: ChainIdentity,
    args: {
      eventId: string;
      purpose: 'capture' | 'battle' | 'mint';
      playerId: string;
      commitHash: string;
      clientSeed: string;
      /** 链下上下文备注（≤256 字节 UTF-8），随 Commit 上链留痕。 */
      meta?: string;
    } & TxMeta,
  ): Promise<RandomCommitState>;
  abstract revealAndVerify(
    as: ChainIdentity,
    args: { eventId: string; serverSeed: string } & TxMeta,
  ): Promise<RandomCommitState>;
  abstract getRandom(eventId: string): Promise<RandomCommitState>;

  // ---- PokemonContract ----
  abstract mintFromCapture(
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
  ): Promise<PokemonState>;
  abstract transferPokemon(
    as: ChainIdentity,
    args: { id: string; toId: string } & TxMeta,
  ): Promise<PokemonState>;
  abstract applyGrowth(
    as: ChainIdentity,
    args: { id: string; growth: GrowthPatch } & TxMeta,
  ): Promise<PokemonState>;
  abstract releasePokemon(as: ChainIdentity, args: { id: string } & TxMeta): Promise<PokemonState>;
  /** PokemonContract.BondUp：仅 system，每只 +=delta（1-50），上限 255 截断（chaincode-api.md §2.3）。 */
  abstract bondUp(
    as: ChainIdentity,
    args: { pokemonIds: string[]; delta: number; reason: string } & TxMeta,
  ): Promise<PokemonState[]>;
  abstract getPokemon(id: string): Promise<PokemonState>;
  abstract queryPokemonByOwner(ownerId: string): Promise<PokemonState[]>;
  abstract queryPokedex(selector: Record<string, unknown>): Promise<PokemonState[]>;
  // --- [FEAT:history] begin ---
  /** 账本历史（只读查询；真链走 HistoryContract:GetPokemonHistory）。 */
  abstract getPokemonHistory(id: string, maxEntries?: number): Promise<ChainHistoryResult>;
  // --- [FEAT:history] end ---
  // --- [FEAT:breeding] begin ---
  abstract breed(as: ChainIdentity, args: BreedArgs & TxMeta): Promise<PokemonState>;
  abstract getLineage(id: string): Promise<LineageState>;
  abstract getBreedingConfig(): Promise<BreedingConfigState>;
  // --- [FEAT:breeding] end ---

  // ---- ItemContract ----
  abstract mintItem(
    as: ChainIdentity,
    args: {
      id: string;
      playerId: string;
      typeId: string;
      quantity: number;
      uri: string;
      metadataHash: string;
    } & TxMeta,
  ): Promise<ItemState>;
  abstract transferItem(
    as: ChainIdentity,
    args: { id: string; toId: string } & TxMeta,
  ): Promise<ItemState>;
  abstract consumeItem(
    as: ChainIdentity,
    args: { id: string; quantity: number; reason: string } & TxMeta,
  ): Promise<ItemState>;
  abstract getItem(id: string): Promise<ItemState>;
  abstract queryItemsByOwner(ownerId: string): Promise<ItemState[]>;
  /** ItemContract.MergeStacks：合并同一 owner+typeId 的全部 IDLE 堆叠（owner 或 system）。 */
  abstract mergeStacks(
    as: ChainIdentity,
    args: { ownerId: string; typeId: string } & TxMeta,
  ): Promise<ItemState | null>;

  // ---- TradeContract ----
  abstract createTrade(
    as: ChainIdentity,
    args: {
      id: string;
      fromId: string;
      toId: string;
      offer: AssetOffer;
      request: AssetOffer;
      expiresAt: string;
    } & TxMeta,
  ): Promise<TradeState>;
  abstract confirmTrade(
    as: ChainIdentity,
    args: { id: string; playerId: string } & TxMeta,
  ): Promise<TradeState>;
  abstract cancelTrade(
    as: ChainIdentity,
    args: { id: string; playerId: string } & TxMeta,
  ): Promise<TradeState>;
  abstract expireTrade(as: ChainIdentity, args: { id: string } & TxMeta): Promise<TradeState>;
  abstract getTrade(id: string): Promise<TradeState>;
  abstract queryTradesByPlayer(playerId: string): Promise<TradeState[]>;

  // ---- BattleContract ----
  abstract createBattle(
    as: ChainIdentity,
    args: {
      id: string;
      playerA: string;
      playerB: string;
      wagerA: WagerInput;
      wagerB: WagerInput;
      wagerHash: string;
    } & TxMeta,
  ): Promise<BattleState>;
  abstract activateBattle(as: ChainIdentity, args: { id: string } & TxMeta): Promise<BattleState>;
  abstract submitBattleResult(
    as: ChainIdentity,
    args: { id: string; winnerId: string; resultHash: string; serverSig: string } & TxMeta,
  ): Promise<BattleState>;
  abstract confirmBattleResult(
    as: ChainIdentity,
    args: { id: string; playerId: string } & TxMeta,
  ): Promise<BattleState>;
  abstract settleBattle(as: ChainIdentity, args: { id: string } & TxMeta): Promise<BattleState>;
  /** H5：取消尚未激活（CREATED）的对局并全额退款；system only。 */
  abstract cancelBattle(
    as: ChainIdentity,
    args: { id: string; reason: string } & TxMeta,
  ): Promise<BattleState>;
  abstract forfeitBattle(
    as: ChainIdentity,
    args: { id: string; loserId: string; reason: string } & TxMeta,
  ): Promise<BattleState>;
  abstract disputeBattle(
    as: ChainIdentity,
    args: { id: string; playerId: string; reason: string } & TxMeta,
  ): Promise<BattleState>;
  abstract arbitrateBattle(
    as: ChainIdentity,
    args: { id: string; outcome: string; arbiterNote: string } & TxMeta,
  ): Promise<BattleState>;
  abstract getBattle(id: string): Promise<BattleState>;
  abstract queryBattlesByPlayer(playerId: string): Promise<BattleState[]>;

  // ---- events ----
  abstract onChainEvent(listener: ChainEventListener): void;
}

/** 子堆叠 id 规则：`<parentId>#w<battleId>`（部分数量押注拆分，chaincode-api.md §1 Item）。 */
export function childStackId(parentId: string, battleId: string): string {
  return `${parentId}#w${battleId}`;
}

/** 子堆叠 id → 原堆叠 id；非子堆叠返回 ''。 */
export function parentStackIdOf(childId: string): string {
  const idx = childId.lastIndexOf('#w');
  return idx > 0 ? childId.slice(0, idx) : '';
}

/**
 * 归一押注输入，镜像链码 parseWagerBundle（chaincode-api.md §1 Battle）：
 * `items:[{id,qty}]` 保留；旧 `itemIds:[...]` 归一为整堆 `qty=0`；两者不可混用。
 * 计算 wagerHash 前必须先归一，否则与链上校验不一致。
 */
export function normalizeWagerBundle(input: WagerInput): WagerBundle {
  const usesItems = input.items !== undefined;
  const legacyIds = input.itemIds ?? [];
  // `items` 与空 `itemIds: []` 并存按 items 处理（DTO 默认值常见形态）；都非空才视为歧义
  if (usesItems && legacyIds.length > 0) {
    throw new CodedError('INVALID_PARAM', 'wager must not mix items[] with the legacy itemIds[]');
  }
  if (usesItems && !Array.isArray(input.items)) {
    throw new CodedError('INVALID_PARAM', 'wager items must be an array of {id, qty}');
  }
  const items: ItemStackRef[] = usesItems
    ? (input.items as ItemStackRef[]).map((ref) => {
        if (!ref || typeof ref.id !== 'string' || ref.id.length === 0) {
          throw new CodedError('INVALID_PARAM', 'wager items entries need a non-empty id');
        }
        if (!Number.isSafeInteger(ref.qty) || ref.qty < 1) {
          throw new CodedError('INVALID_PARAM', `wager items[].qty must be a safe integer >= 1, got ${ref.qty}`);
        }
        return { id: ref.id, qty: ref.qty };
      })
    : legacyIds.map((id) => ({ id, qty: 0 }));
  const pokemonIds = [...(input.pokemonIds ?? [])];
  const duplicates = [...pokemonIds, ...items.map((i) => i.id)];
  if (new Set(duplicates).size !== duplicates.length) {
    throw new CodedError('INVALID_PARAM', 'wager contains duplicate asset ids');
  }
  const points = input.points ?? 0;
  if (!Number.isSafeInteger(points) || points < 0) {
    throw new CodedError('INVALID_PARAM', `wager points must be a safe integer >= 0, got ${points}`);
  }
  return { pokemonIds, items, points };
}

/** Compute the wagerHash exactly like the chaincode does (chaincode-api.md §1 Battle). */
export function computeWagerHash(
  playerA: string,
  playerB: string,
  wagerA: WagerInput,
  wagerB: WagerInput,
): string {
  return sha256hex(
    canonicalize({
      playerA,
      playerB,
      wagerA: normalizeWagerBundle(wagerA),
      wagerB: normalizeWagerBundle(wagerB),
    }),
  );
}
