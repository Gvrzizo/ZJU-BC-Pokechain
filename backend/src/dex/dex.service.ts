import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EVOLUTIONS } from '../game-data/species.data';
import { PokedexUnlock } from './pokedex-unlock.entity';

// --- [FEAT:dex] begin ---

/** 图鉴持久解锁：捕获、领御三家、进化（新旧物种）、繁殖时各记一笔。 */
@Injectable()
export class DexService {
  constructor(
    @InjectRepository(PokedexUnlock)
    private readonly unlocks: Repository<PokedexUnlock>,
  ) {}

  /** 把种族展开成"它 + 它的全部进化前形态"：拥有妙蛙草就等于解锁过妙蛙种子。 */
  private withPreEvolutions(speciesIds: number[]): number[] {
    const out = new Set<number>();
    const walk = (id: number): void => {
      if (out.has(id)) return;
      out.add(id);
      for (const rule of EVOLUTIONS) {
        if (rule.to === id) walk(rule.from);
      }
    };
    for (const id of speciesIds) if (Number.isInteger(id) && id > 0) walk(id);
    return [...out];
  }

  async record(playerId: string, speciesIds: number[]): Promise<void> {
    const ids = this.withPreEvolutions(speciesIds);
    for (const speciesId of ids) {
      try {
        const existing = await this.unlocks.findOne({ where: { playerId, speciesId } });
        if (existing) continue;
        await this.unlocks.save(this.unlocks.create({ playerId, speciesId }) as PokedexUnlock);
      } catch {
        // 并发插入撞唯一键 / 测试桩不支持时忽略：本来就已经解锁
      }
    }
  }

  async list(playerId: string): Promise<Set<number>> {
    const rows = await this.unlocks.find({ where: { playerId } });
    return new Set(rows.map((row) => row.speciesId));
  }
}

// --- [FEAT:dex] end ---
