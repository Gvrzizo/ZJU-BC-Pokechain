import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ChainAdapter, TxMeta } from './chain.adapter';
import {
  AssetOffer,
  BattleState,
  ChainIdentity,
  GrowthPatch,
  ItemState,
  PlayerState,
  PokemonIvs,
  PokemonState,
  RandomCommitState,
  TradeState,
  WagerInput,
} from './chain.types';

/**
 * Typed facade over the active ChainAdapter (docs/backend-api.md §8):
 * every mutating call gets a fresh idemKey (crypto.randomUUID()) and nowISO
 * unless the caller overrides them (capture flow passes deterministic keys).
 */
@Injectable()
export class ContractService {
  constructor(private readonly chain: ChainAdapter) {}

  private meta(m?: TxMeta): Required<TxMeta> {
    return { nowISO: m?.nowISO ?? new Date().toISOString(), idemKey: m?.idemKey ?? randomUUID() };
  }

  registerPlayer(as: ChainIdentity, playerId: string, nickname: string, m?: TxMeta): Promise<PlayerState> {
    return this.chain.registerPlayer(as, { playerId, nickname, ...this.meta(m) });
  }
  grantRole(as: ChainIdentity, playerId: string, role: string, m?: TxMeta): Promise<PlayerState> {
    return this.chain.grantRole(as, { playerId, role, ...this.meta(m) });
  }
  getPlayer(playerId: string): Promise<PlayerState> {
    return this.chain.getPlayer(playerId);
  }
  addPoints(as: ChainIdentity, playerId: string, delta: number, reason: string, m?: TxMeta): Promise<PlayerState> {
    return this.chain.addPoints(as, { playerId, delta, reason, ...this.meta(m) });
  }
  updateRating(as: ChainIdentity, playerId: string, newRating: number, reason: string, m?: TxMeta): Promise<PlayerState> {
    return this.chain.updateRating(as, { playerId, newRating, reason, ...this.meta(m) });
  }
  transferPoints(as: ChainIdentity, fromId: string, toId: string, amount: number, m?: TxMeta) {
    return this.chain.transferPoints(as, { fromId, toId, amount, ...this.meta(m) });
  }

  commitRandom(
    as: ChainIdentity,
    args: {
      eventId: string;
      purpose: 'capture' | 'battle' | 'mint';
      playerId: string;
      commitHash: string;
      clientSeed: string;
      /** 链下上下文备注（≤256 字节 UTF-8），随 Commit 上链留痕。 */
      meta?: string;
    },
    m?: TxMeta,
  ): Promise<RandomCommitState> {
    return this.chain.commitRandom(as, { ...args, ...this.meta(m) });
  }
  revealAndVerify(as: ChainIdentity, eventId: string, serverSeed: string, m?: TxMeta): Promise<RandomCommitState> {
    return this.chain.revealAndVerify(as, { eventId, serverSeed, ...this.meta(m) });
  }
  getRandom(eventId: string): Promise<RandomCommitState> {
    return this.chain.getRandom(eventId);
  }

  mintFromCapture(
    as: ChainIdentity,
    args: {
      id: string; playerId: string; speciesId: number; name: string; ivs: PokemonIvs;
      nature: string; ability: string; shiny: boolean; moves: string[]; dnaHash: string; eventId: string;
    },
    m?: TxMeta,
  ): Promise<PokemonState> {
    return this.chain.mintFromCapture(as, { ...args, ...this.meta(m) });
  }
  transferPokemon(as: ChainIdentity, id: string, toId: string, m?: TxMeta): Promise<PokemonState> {
    return this.chain.transferPokemon(as, { id, toId, ...this.meta(m) });
  }
  applyGrowth(as: ChainIdentity, id: string, growth: GrowthPatch, m?: TxMeta): Promise<PokemonState> {
    return this.chain.applyGrowth(as, { id, growth, ...this.meta(m) });
  }
  releasePokemon(as: ChainIdentity, id: string, m?: TxMeta): Promise<PokemonState> {
    return this.chain.releasePokemon(as, { id, ...this.meta(m) });
  }
  bondUp(as: ChainIdentity, pokemonIds: string[], delta: number, reason: string, m?: TxMeta): Promise<PokemonState[]> {
    return this.chain.bondUp(as, { pokemonIds, delta, reason, ...this.meta(m) });
  }
  getPokemon(id: string): Promise<PokemonState> {
    return this.chain.getPokemon(id);
  }
  queryPokemonByOwner(ownerId: string): Promise<PokemonState[]> {
    return this.chain.queryPokemonByOwner(ownerId);
  }
  queryPokedex(selector: Record<string, unknown>): Promise<PokemonState[]> {
    return this.chain.queryPokedex(selector);
  }

  mintItem(
    as: ChainIdentity,
    args: { id: string; playerId: string; typeId: string; quantity: number; uri: string; metadataHash: string },
    m?: TxMeta,
  ): Promise<ItemState> {
    return this.chain.mintItem(as, { ...args, ...this.meta(m) });
  }
  transferItem(as: ChainIdentity, id: string, toId: string, m?: TxMeta): Promise<ItemState> {
    return this.chain.transferItem(as, { id, toId, ...this.meta(m) });
  }
  consumeItem(as: ChainIdentity, id: string, quantity: number, reason: string, m?: TxMeta): Promise<ItemState> {
    return this.chain.consumeItem(as, { id, quantity, reason, ...this.meta(m) });
  }
  getItem(id: string): Promise<ItemState> {
    return this.chain.getItem(id);
  }
  queryItemsByOwner(ownerId: string): Promise<ItemState[]> {
    return this.chain.queryItemsByOwner(ownerId);
  }
  mergeStacks(as: ChainIdentity, ownerId: string, typeId: string, m?: TxMeta): Promise<ItemState | null> {
    return this.chain.mergeStacks(as, { ownerId, typeId, ...this.meta(m) });
  }

  createTrade(
    as: ChainIdentity,
    args: { id: string; fromId: string; toId: string; offer: AssetOffer; request: AssetOffer; expiresAt: string },
    m?: TxMeta,
  ): Promise<TradeState> {
    return this.chain.createTrade(as, { ...args, ...this.meta(m) });
  }
  confirmTrade(as: ChainIdentity, id: string, playerId: string, m?: TxMeta): Promise<TradeState> {
    return this.chain.confirmTrade(as, { id, playerId, ...this.meta(m) });
  }
  cancelTrade(as: ChainIdentity, id: string, playerId: string, m?: TxMeta): Promise<TradeState> {
    return this.chain.cancelTrade(as, { id, playerId, ...this.meta(m) });
  }
  expireTrade(as: ChainIdentity, id: string, m?: TxMeta): Promise<TradeState> {
    return this.chain.expireTrade(as, { id, ...this.meta(m) });
  }
  getTrade(id: string): Promise<TradeState> {
    return this.chain.getTrade(id);
  }
  queryTradesByPlayer(playerId: string): Promise<TradeState[]> {
    return this.chain.queryTradesByPlayer(playerId);
  }

  createBattle(
    as: ChainIdentity,
    args: { id: string; playerA: string; playerB: string; wagerA: WagerInput; wagerB: WagerInput; wagerHash: string },
    m?: TxMeta,
  ): Promise<BattleState> {
    return this.chain.createBattle(as, { ...args, ...this.meta(m) });
  }
  activateBattle(as: ChainIdentity, id: string, m?: TxMeta): Promise<BattleState> {
    return this.chain.activateBattle(as, { id, ...this.meta(m) });
  }
  submitBattleResult(as: ChainIdentity, id: string, winnerId: string, resultHash: string, serverSig: string, m?: TxMeta): Promise<BattleState> {
    return this.chain.submitBattleResult(as, { id, winnerId, resultHash, serverSig, ...this.meta(m) });
  }
  confirmBattleResult(as: ChainIdentity, id: string, playerId: string, m?: TxMeta): Promise<BattleState> {
    return this.chain.confirmBattleResult(as, { id, playerId, ...this.meta(m) });
  }
  settleBattle(as: ChainIdentity, id: string, m?: TxMeta): Promise<BattleState> {
    return this.chain.settleBattle(as, { id, ...this.meta(m) });
  }
  forfeitBattle(as: ChainIdentity, id: string, loserId: string, reason: string, m?: TxMeta): Promise<BattleState> {
    return this.chain.forfeitBattle(as, { id, loserId, reason, ...this.meta(m) });
  }
  disputeBattle(as: ChainIdentity, id: string, playerId: string, reason: string, m?: TxMeta): Promise<BattleState> {
    return this.chain.disputeBattle(as, { id, playerId, reason, ...this.meta(m) });
  }
  arbitrateBattle(as: ChainIdentity, id: string, outcome: string, arbiterNote: string, m?: TxMeta): Promise<BattleState> {
    return this.chain.arbitrateBattle(as, { id, outcome, arbiterNote, ...this.meta(m) });
  }
  getBattle(id: string): Promise<BattleState> {
    return this.chain.getBattle(id);
  }
  queryBattlesByPlayer(playerId: string): Promise<BattleState[]> {
    return this.chain.queryBattlesByPlayer(playerId);
  }
}
