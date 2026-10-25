import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { decryptSecret } from '../common/utils/secret-box.util';
import { splitCodedMessage } from '../common/utils/errors';
import { ChainAdapter, normalizeWagerBundle, TxMeta } from './chain.adapter';
import {
  AssetOffer,
  BattleState,
  ChainEventListener,
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
import { FabricGatewayService } from './fabric-gateway.service';

/**
 * ChainAdapter backed by a real Fabric network via @hyperledger/fabric-gateway.
 * User-context transactions are signed with the user's managed certificate
 * (AES-256-GCM encrypted at rest, decrypted just-in-time); system/admin
 * transactions use the shared system identity.
 */
@Injectable()
export class FabricChainAdapter extends ChainAdapter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FabricChainAdapter.name);
  private readonly listeners: ChainEventListener[] = [];
  private eventStop: (() => void) | null = null;
  private readonly mock: boolean;

  constructor(
    private readonly gateway: FabricGatewayService,
    private readonly config: ConfigService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {
    super();
    this.mock = config.get<boolean>('fabric.mock') ?? true;
  }

  onChainEvent(listener: ChainEventListener): void {
    this.listeners.push(listener);
  }

  async onModuleInit(): Promise<void> {
    if (this.mock) return;
    // Fire-and-forget resilient event listener.
    void this.listenLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.eventStop?.();
    await this.gateway.close();
  }

  private async listenLoop(): Promise<void> {
    for (;;) {
      try {
        const network = await this.gateway.getSystemNetwork();
        const events = await network.getChaincodeEvents(
          this.config.get<string>('fabric.chaincode') ?? 'pokemoncc',
        );
        this.eventStop = () => events.close();
        for await (const event of events) {
          const payload = JSON.parse(Buffer.from(event.payload).toString('utf8'));
          for (const l of this.listeners) l(event.eventName, payload);
        }
      } catch (err) {
        this.logger.warn(`chaincode event stream interrupted: ${(err as Error).message}; retrying in 5s`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async contractFor(as: ChainIdentity) {
    if (as.role === 'system' || as.role === 'admin') {
      const contract = await this.gateway.getSystemContract();
      return { contract, close: () => undefined };
    }
    const user = await this.users.findOne({ where: { username: as.userId } });
    if (!user || !user.fabricCertEnc || !user.fabricKeyEnc) {
      throw new Error(`NO_FABRIC_CERT: no managed certificate for user ${as.userId}`);
    }
    const cert = decryptSecret(user.fabricCertEnc, this.config.get<string>('certEncKey') ?? '');
    const key = decryptSecret(user.fabricKeyEnc, this.config.get<string>('certEncKey') ?? '');
    return this.gateway.getUserContract(as, cert, key);
  }

  private unwrap(err: unknown): never {
    const raw = err instanceof Error ? err.message : String(err);
    const { code, message } = splitCodedMessage(raw);
    const e = new Error(`${code}: ${message}`) as Error & { code?: string };
    e.code = code;
    throw e;
  }

  private async submit<T>(as: ChainIdentity, tx: string, args: string[]): Promise<T> {
    const { contract, close } = await this.contractFor(as);
    try {
      const result = await contract.submitTransaction(tx, ...args);
      const text = Buffer.from(result).toString('utf8');
      return (text ? JSON.parse(text) : null) as T;
    } catch (err) {
      this.unwrap(err);
    } finally {
      close();
    }
  }

  private async evaluate<T>(tx: string, args: string[]): Promise<T> {
    try {
      const contract = await this.gateway.getSystemContract();
      const result = await contract.evaluateTransaction(tx, ...args);
      const text = Buffer.from(result).toString('utf8');
      return (text ? JSON.parse(text) : null) as T;
    } catch (err) {
      this.unwrap(err);
    }
  }

  private meta(m: TxMeta): { nowISO: string; idemKey: string } {
    return { nowISO: m.nowISO ?? new Date().toISOString(), idemKey: m.idemKey ?? randomUUID() };
  }

  // ---------------------------------------------------------------- PlayerContract
  async registerPlayer(as: ChainIdentity, args: { playerId: string; nickname: string } & TxMeta): Promise<PlayerState> {
    const m = this.meta(args);
    return this.submit(as, 'PlayerContract:RegisterPlayer', [args.playerId, args.nickname, m.nowISO, m.idemKey]);
  }
  async grantRole(as: ChainIdentity, args: { playerId: string; role: string } & TxMeta): Promise<PlayerState> {
    const m = this.meta(args);
    return this.submit(as, 'PlayerContract:GrantRole', [args.playerId, args.role, m.nowISO, m.idemKey]);
  }
  async getPlayer(playerId: string): Promise<PlayerState> {
    return this.evaluate('PlayerContract:GetPlayer', [playerId]);
  }
  async addPoints(as: ChainIdentity, args: { playerId: string; delta: number; reason: string } & TxMeta): Promise<PlayerState> {
    const m = this.meta(args);
    return this.submit(as, 'PlayerContract:AddPoints', [args.playerId, String(args.delta), args.reason, m.nowISO, m.idemKey]);
  }
  async updateRating(as: ChainIdentity, args: { playerId: string; newRating: number; reason: string } & TxMeta): Promise<PlayerState> {
    const m = this.meta(args);
    return this.submit(as, 'PlayerContract:UpdateRating', [args.playerId, String(args.newRating), args.reason, m.nowISO, m.idemKey]);
  }
  async transferPoints(as: ChainIdentity, args: { fromId: string; toId: string; amount: number } & TxMeta): Promise<{ fromId: string; toId: string; amount: number }> {
    const m = this.meta(args);
    return this.submit(as, 'PlayerContract:TransferPoints', [args.fromId, args.toId, String(args.amount), m.nowISO, m.idemKey]);
  }

  // ---------------------------------------------------------------- RandomContract
  async commitRandom(as: ChainIdentity, args: { eventId: string; purpose: 'capture' | 'battle' | 'mint'; playerId: string; commitHash: string; clientSeed: string; meta?: string } & TxMeta): Promise<RandomCommitState> {
    const m = this.meta(args);
    return this.submit(as, 'RandomContract:Commit', [args.eventId, args.purpose, args.playerId, args.commitHash, args.clientSeed, m.nowISO, m.idemKey, args.meta ?? '']);
  }
  async revealAndVerify(as: ChainIdentity, args: { eventId: string; serverSeed: string } & TxMeta): Promise<RandomCommitState> {
    const m = this.meta(args);
    return this.submit(as, 'RandomContract:RevealAndVerify', [args.eventId, args.serverSeed, m.nowISO, m.idemKey]);
  }
  async getRandom(eventId: string): Promise<RandomCommitState> {
    return this.evaluate('RandomContract:GetRandom', [eventId]);
  }

  // ---------------------------------------------------------------- PokemonContract
  async mintFromCapture(as: ChainIdentity, args: { id: string; playerId: string; speciesId: number; name: string; ivs: PokemonIvs; nature: string; ability: string; shiny: boolean; moves: string[]; dnaHash: string; eventId: string } & TxMeta): Promise<PokemonState> {
    const m = this.meta(args);
    return this.submit(as, 'PokemonContract:MintFromCapture', [
      args.id, args.playerId, String(args.speciesId), args.name, JSON.stringify(args.ivs),
      args.nature, args.ability, String(args.shiny), JSON.stringify(args.moves), args.dnaHash, args.eventId, m.nowISO, m.idemKey,
    ]);
  }
  async transferPokemon(as: ChainIdentity, args: { id: string; toId: string } & TxMeta): Promise<PokemonState> {
    const m = this.meta(args);
    return this.submit(as, 'PokemonContract:Transfer', [args.id, args.toId, m.nowISO, m.idemKey]);
  }
  async applyGrowth(as: ChainIdentity, args: { id: string; growth: GrowthPatch } & TxMeta): Promise<PokemonState> {
    const m = this.meta(args);
    return this.submit(as, 'PokemonContract:ApplyGrowth', [args.id, JSON.stringify(args.growth), m.nowISO, m.idemKey]);
  }
  async releasePokemon(as: ChainIdentity, args: { id: string } & TxMeta): Promise<PokemonState> {
    const m = this.meta(args);
    return this.submit(as, 'PokemonContract:Release', [args.id, m.nowISO, m.idemKey]);
  }
  async bondUp(as: ChainIdentity, args: { pokemonIds: string[]; delta: number; reason: string } & TxMeta): Promise<PokemonState[]> {
    const m = this.meta(args);
    return this.submit(as, 'PokemonContract:BondUp', [
      JSON.stringify(args.pokemonIds), String(args.delta), args.reason, m.nowISO, m.idemKey,
    ]);
  }
  async getPokemon(id: string): Promise<PokemonState> {
    return this.evaluate('PokemonContract:GetPokemon', [id]);
  }
  async queryPokemonByOwner(ownerId: string): Promise<PokemonState[]> {
    return this.evaluate('PokemonContract:QueryByOwner', [ownerId]);
  }
  async queryPokedex(selector: Record<string, unknown>): Promise<PokemonState[]> {
    return this.evaluate('PokemonContract:QueryPokedex', [JSON.stringify(selector)]);
  }

  // ---------------------------------------------------------------- ItemContract
  async mintItem(as: ChainIdentity, args: { id: string; playerId: string; typeId: string; quantity: number; uri: string; metadataHash: string } & TxMeta): Promise<ItemState> {
    const m = this.meta(args);
    return this.submit(as, 'ItemContract:MintItem', [args.id, args.playerId, args.typeId, String(args.quantity), args.uri, args.metadataHash, m.nowISO, m.idemKey]);
  }
  async transferItem(as: ChainIdentity, args: { id: string; toId: string } & TxMeta): Promise<ItemState> {
    const m = this.meta(args);
    return this.submit(as, 'ItemContract:TransferItem', [args.id, args.toId, m.nowISO, m.idemKey]);
  }
  async consumeItem(as: ChainIdentity, args: { id: string; quantity: number; reason: string } & TxMeta): Promise<ItemState> {
    const m = this.meta(args);
    return this.submit(as, 'ItemContract:ConsumeItem', [args.id, String(args.quantity), args.reason, m.nowISO, m.idemKey]);
  }
  async getItem(id: string): Promise<ItemState> {
    return this.evaluate('ItemContract:GetItem', [id]);
  }
  async queryItemsByOwner(ownerId: string): Promise<ItemState[]> {
    return this.evaluate('ItemContract:QueryByOwner', [ownerId]);
  }
  async mergeStacks(as: ChainIdentity, args: { ownerId: string; typeId: string } & TxMeta): Promise<ItemState | null> {
    const m = this.meta(args);
    return this.submit(as, 'ItemContract:MergeStacks', [args.ownerId, args.typeId, m.nowISO, m.idemKey]);
  }

  // ---------------------------------------------------------------- TradeContract
  async createTrade(as: ChainIdentity, args: { id: string; fromId: string; toId: string; offer: AssetOffer; request: AssetOffer; expiresAt: string } & TxMeta): Promise<TradeState> {
    const m = this.meta(args);
    return this.submit(as, 'TradeContract:CreateTrade', [args.id, args.fromId, args.toId, JSON.stringify(args.offer), JSON.stringify(args.request), args.expiresAt, m.nowISO, m.idemKey]);
  }
  async confirmTrade(as: ChainIdentity, args: { id: string; playerId: string } & TxMeta): Promise<TradeState> {
    const m = this.meta(args);
    return this.submit(as, 'TradeContract:ConfirmTrade', [args.id, args.playerId, m.nowISO, m.idemKey]);
  }
  async cancelTrade(as: ChainIdentity, args: { id: string; playerId: string } & TxMeta): Promise<TradeState> {
    const m = this.meta(args);
    return this.submit(as, 'TradeContract:CancelTrade', [args.id, args.playerId, m.nowISO, m.idemKey]);
  }
  async expireTrade(as: ChainIdentity, args: { id: string } & TxMeta): Promise<TradeState> {
    const m = this.meta(args);
    return this.submit(as, 'TradeContract:ExpireTrade', [args.id, m.nowISO, m.idemKey]);
  }
  async getTrade(id: string): Promise<TradeState> {
    return this.evaluate('TradeContract:GetTrade', [id]);
  }
  async queryTradesByPlayer(playerId: string): Promise<TradeState[]> {
    return this.evaluate('TradeContract:QueryByPlayer', [playerId]);
  }

  // ---------------------------------------------------------------- BattleContract
  async createBattle(as: ChainIdentity, args: { id: string; playerA: string; playerB: string; wagerA: WagerInput; wagerB: WagerInput; wagerHash: string } & TxMeta): Promise<BattleState> {
    const m = this.meta(args);
    // 归一后上链：链下 hash 与链上解析结果一致（chaincode-api.md §1 Battle）
    const wagerA = normalizeWagerBundle(args.wagerA);
    const wagerB = normalizeWagerBundle(args.wagerB);
    return this.submit(as, 'BattleContract:CreateBattle', [args.id, args.playerA, args.playerB, JSON.stringify(wagerA), JSON.stringify(wagerB), args.wagerHash, m.nowISO, m.idemKey]);
  }
  async activateBattle(as: ChainIdentity, args: { id: string } & TxMeta): Promise<BattleState> {
    const m = this.meta(args);
    return this.submit(as, 'BattleContract:ActivateBattle', [args.id, m.nowISO, m.idemKey]);
  }
  async submitBattleResult(as: ChainIdentity, args: { id: string; winnerId: string; resultHash: string; serverSig: string } & TxMeta): Promise<BattleState> {
    const m = this.meta(args);
    return this.submit(as, 'BattleContract:SubmitResult', [args.id, args.winnerId, args.resultHash, args.serverSig, m.nowISO, m.idemKey]);
  }
  async confirmBattleResult(as: ChainIdentity, args: { id: string; playerId: string } & TxMeta): Promise<BattleState> {
    const m = this.meta(args);
    return this.submit(as, 'BattleContract:ConfirmResult', [args.id, args.playerId, m.nowISO, m.idemKey]);
  }
  async settleBattle(as: ChainIdentity, args: { id: string } & TxMeta): Promise<BattleState> {
    const m = this.meta(args);
    return this.submit(as, 'BattleContract:SettleBattle', [args.id, m.nowISO, m.idemKey]);
  }
  async cancelBattle(as: ChainIdentity, args: { id: string; reason: string } & TxMeta): Promise<BattleState> {
    const m = this.meta(args);
    return this.submit(as, 'BattleContract:CancelBattle', [args.id, args.reason, m.nowISO, m.idemKey]);
  }
  async forfeitBattle(as: ChainIdentity, args: { id: string; loserId: string; reason: string } & TxMeta): Promise<BattleState> {
    const m = this.meta(args);
    return this.submit(as, 'BattleContract:Forfeit', [args.id, args.loserId, args.reason, m.nowISO, m.idemKey]);
  }
  async disputeBattle(as: ChainIdentity, args: { id: string; playerId: string; reason: string } & TxMeta): Promise<BattleState> {
    const m = this.meta(args);
    return this.submit(as, 'BattleContract:Dispute', [args.id, args.playerId, args.reason, m.nowISO, m.idemKey]);
  }
  async arbitrateBattle(as: ChainIdentity, args: { id: string; outcome: string; arbiterNote: string } & TxMeta): Promise<BattleState> {
    const m = this.meta(args);
    return this.submit(as, 'BattleContract:Arbitrate', [args.id, args.outcome, args.arbiterNote, m.nowISO, m.idemKey]);
  }
  async getBattle(id: string): Promise<BattleState> {
    return this.evaluate('BattleContract:GetBattle', [id]);
  }
  async queryBattlesByPlayer(playerId: string): Promise<BattleState[]> {
    return this.evaluate('BattleContract:QueryByPlayer', [playerId]);
  }
}
