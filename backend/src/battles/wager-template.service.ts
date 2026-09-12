import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppException } from '../common/utils/errors';
import { normalizeWagerBundle } from '../fabric/chain.adapter';
import { WagerBundle } from '../fabric/chain.types';
import { SaveTemplateDto, TEMPLATE_LIMIT } from './dto/room.dto';
import { WagerTemplate } from './entities/wager-template.entity';
import { sanitizeRoomText } from './room-text';

export interface WagerTemplateView {
  id: string;
  name: string;
  note: string;
  wager: WagerBundle;
  createdAt: string | null;
}

/**
 * 常用押注模板（docs/backend-api.md §5）：玩家把"名称 + 押注清单 + 备注"存进 PG
 * （`wager_templates`），最多 {@link TEMPLATE_LIMIT} 个；WagerPicker 里一键载入。
 * 模板只存清单本身——载入后创建/加入房间仍走链上权威校验，资产会随易主/消耗过期。
 */
@Injectable()
export class WagerTemplateService {
  constructor(@InjectRepository(WagerTemplate) private readonly templates: Repository<WagerTemplate>) {}

  async list(ownerId: string): Promise<WagerTemplateView[]> {
    const rows = await this.templates.find({ where: { ownerId } });
    return rows
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
      .slice(0, TEMPLATE_LIMIT)
      .map(toView);
  }

  async save(ownerId: string, dto: SaveTemplateDto): Promise<WagerTemplateView> {
    const existing = await this.templates.find({ where: { ownerId } });
    if (existing.length >= TEMPLATE_LIMIT) {
      throw new AppException(
        'TEMPLATE_LIMIT',
        `at most ${TEMPLATE_LIMIT} wager templates per player`,
        HttpStatus.CONFLICT,
      );
    }
    const name = sanitizeRoomText(dto.name);
    if (!name) throw new AppException('INVALID_PARAM', 'template name is required', HttpStatus.BAD_REQUEST);
    const saved = await this.templates.save(
      this.templates.create({
        ownerId,
        name,
        note: sanitizeRoomText(dto.note),
        // 与链上 Battle.wager 同形态：qty=0 的旧整堆语义在这里只做结构归一
        wager: normalizeWagerBundle(dto.wager),
      }),
    );
    return toView(saved);
  }

  async remove(ownerId: string, id: string): Promise<{ deleted: boolean; id: string }> {
    const row = await this.templates.findOne({ where: { id, ownerId } });
    if (!row) {
      throw new AppException('TEMPLATE_NOT_FOUND', `template ${id} does not exist`, HttpStatus.NOT_FOUND);
    }
    await this.templates.delete({ id, ownerId });
    return { deleted: true, id };
  }
}

function toView(row: WagerTemplate): WagerTemplateView {
  return {
    id: row.id,
    name: row.name,
    note: row.note ?? '',
    // 存进去的就是归一形态（qty ≥ 1；旧 itemIds 存的整堆标记 qty=0 原样保留，不再二次归一）
    wager: {
      pokemonIds: [...(row.wager?.pokemonIds ?? [])],
      items: (row.wager?.items ?? []).map((ref) => ({ ...ref })),
      points: row.wager?.points ?? 0,
    },
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  };
}
