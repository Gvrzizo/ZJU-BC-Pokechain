import { randomUUID } from 'crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/utils/errors';
import { sha256hex } from '../common/utils/crypto.util';
import { ContractService } from '../fabric/contract.service';
import { ADMIN_IDENTITY, SYSTEM_IDENTITY } from '../fabric/chain.types';
import { getItemType } from '../game-data/items.data';
import { AuditService } from './audit.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly contract: ContractService,
    private readonly audits: AuditService,
  ) {}

  async mintItem(actor: string, playerId: string, typeId: string, quantity: number) {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new AppException('INVALID_AMOUNT', 'quantity must be a positive integer', HttpStatus.BAD_REQUEST);
    }
    const type = getItemType(typeId);
    if (!type) {
      throw new AppException('UNKNOWN_ITEM_TYPE', `${typeId} is not in the item catalog`, HttpStatus.BAD_REQUEST);
    }
    const item = await this.contract.mintItem(SYSTEM_IDENTITY, {
      id: `i_${randomUUID()}`,
      playerId,
      typeId,
      quantity,
      uri: type.uri,
      metadataHash: sha256hex(`${typeId}|${type.name}`),
    });
    await this.audit(actor, 'items.mint', item.id, { playerId, typeId, quantity });
    return item;
  }

  async addPoints(actor: string, playerId: string, delta: number, reason: string) {
    const player = await this.contract.addPoints(SYSTEM_IDENTITY, playerId, delta, reason);
    await this.audit(actor, 'points.add', playerId, { delta, reason });
    return player;
  }

  async grantRole(actor: string, playerId: string, role: string) {
    const player = await this.contract.grantRole(ADMIN_IDENTITY, playerId, role);
    await this.audit(actor, 'player.grantRole', playerId, { role });
    return player;
  }

  auditLogs(limit = 100) {
    return this.audits.logs(limit);
  }

  private async audit(actor: string, action: string, target: string, detail: Record<string, unknown>) {
    await this.audits.record(actor, action, target, detail);
  }
}
