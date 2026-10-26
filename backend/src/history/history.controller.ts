import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { HistoryService } from './history.service';

// --- [FEAT:history] begin ---

const DEFAULT_MAX = 200;
const HARD_MAX = 500;

/**
 * 独立 controller，挂在与 PokemonController 相同的 `pokemon` 前缀下，
 * 避免修改现有 controller（卸载时删目录即可）。
 */
@Controller('pokemon')
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get(':id/history')
  async getHistory(@Param('id') id: string, @Query('max') max?: string) {
    const parsed = max === undefined || max === '' ? DEFAULT_MAX : Number(max);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > HARD_MAX) {
      throw new BadRequestException(`INVALID_PARAM: max must be an integer between 1 and ${HARD_MAX}`);
    }
    return this.history.getPokemonHistory(id, parsed);
  }
}

// --- [FEAT:history] end ---
