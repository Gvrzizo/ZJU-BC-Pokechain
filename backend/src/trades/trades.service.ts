import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ContractService } from '../fabric/contract.service';
import { ChainIdentity, SYSTEM_IDENTITY } from '../fabric/chain.types';
import { AssetOfferDto, CreateTradeDto } from './dto/trades.dto';

@Injectable()
export class TradesService {
  constructor(private readonly contract: ContractService) {}

  async create(as: ChainIdentity, dto: CreateTradeDto) {
    const id = `t_${randomUUID()}`;
    const expiresAt = new Date(Date.now() + dto.ttlSeconds * 1000).toISOString();
    return this.contract.createTrade(as, {
      id,
      fromId: as.userId,
      toId: dto.toPlayerId,
      offer: normalize(dto.offer),
      request: normalize(dto.request),
      expiresAt,
    });
  }

  confirm(as: ChainIdentity, id: string) {
    return this.contract.confirmTrade(as, id, as.userId);
  }

  cancel(as: ChainIdentity, id: string) {
    return this.contract.cancelTrade(as, id, as.userId);
  }

  async getOne(id: string) {
    const trade = await this.contract.getTrade(id);
    return this.sweepExpiry(trade);
  }

  async list(as: ChainIdentity, box?: 'in' | 'out') {
    const trades = await this.contract.queryTradesByPlayer(as.userId);
    const swept = await Promise.all(trades.map((t) => this.sweepExpiry(t)));
    if (box === 'in') return swept.filter((t) => t.toId === as.userId);
    if (box === 'out') return swept.filter((t) => t.fromId === as.userId);
    return swept;
  }

  /** Lazily expire OPEN trades past their deadline so assets get unlocked. */
  private async sweepExpiry<T extends { id: string; status: string; expiresAt: string }>(trade: T): Promise<T> {
    if (trade.status === 'OPEN' && new Date().toISOString() >= trade.expiresAt) {
      try {
        return (await this.contract.expireTrade(SYSTEM_IDENTITY, trade.id)) as unknown as T;
      } catch {
        return trade;
      }
    }
    return trade;
  }
}

function normalize(o: AssetOfferDto) {
  return {
    pokemonIds: o.pokemonIds ?? [],
    itemIds: o.itemIds ?? [],
    points: o.points ?? 0,
  };
}
