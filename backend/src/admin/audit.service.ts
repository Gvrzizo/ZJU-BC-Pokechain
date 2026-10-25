import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';

/** AuditLog repository boundary shared by admin/assets (and other) feature services. */
@Injectable()
export class AuditService {
  constructor(@InjectRepository(AuditLog) private readonly audits: Repository<AuditLog>) {}

  async record(actor: string, action: string, target: string, detail: Record<string, unknown>): Promise<void> {
    await this.audits.save(this.audits.create({ actor, action, target, detail }));
  }

  logs(limit = 100) {
    return this.audits.find({ order: { createdAt: 'DESC' }, take: Math.min(limit, 500) });
  }
}
