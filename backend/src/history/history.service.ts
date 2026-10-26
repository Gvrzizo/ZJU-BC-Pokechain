import { Injectable } from '@nestjs/common';
import { ChainAdapter } from '../fabric/chain.adapter';
import { ChainHistoryResult } from '../fabric/chain.types';

// --- [FEAT:history] begin ---

export type HistoryEventType = 'capture' | 'rename' | 'transfer' | 'evolve' | 'level' | 'bond' | 'release' | 'delete';

export interface HistoryEvent {
  type: HistoryEventType;
  at: string;
  txId: string;
  from?: string | number;
  to?: string | number;
}

export interface PokemonHistory {
  pokemonId: string;
  /** 初训家：来自完整历史的摘要，不受 maxEntries 截断影响。 */
  firstOwner: string;
  currentOwner: string;
  /** 转手次数：同样来自完整历史摘要。 */
  transfers: number;
  /** 完整历史版本数。 */
  versions: number;
  /** true 表示只返回了最近一部分事件，早期事件未列出（摘要仍准确）。 */
  truncated: boolean;
  /** 最新在前。 */
  entries: HistoryEvent[];
}

/**
 * 宝可梦履历：把账本历史摘要投影成"事件时间线"。
 *
 * 链码在完整历史上算好 summary（初训家/转手次数/版本数），只把最新 N 条明细返回；
 * 这里基于 summary 输出档案，基于 entries 输出时间线——避免"截断导致初训家算错"。
 */
@Injectable()
export class HistoryService {
  constructor(private readonly chain: ChainAdapter) {}

  async getPokemonHistory(pokemonId: string, maxEntries = 200): Promise<PokemonHistory> {
    const result = await this.chain.getPokemonHistory(pokemonId, maxEntries);
    return projectHistory(pokemonId, result);
  }
}

/** 纯函数，便于单测。entries 为链码返回的顺序（最新在前）。 */
export function projectHistory(pokemonId: string, result: ChainHistoryResult): PokemonHistory {
  const ordered = [...result.entries].reverse(); // 旧 → 新（仅时间线窗口内）
  const timeline: HistoryEvent[] = [];

  ordered.forEach((current, index) => {
    const previous = index > 0 ? ordered[index - 1] : undefined;
    if (!previous) {
      // 窗口覆盖到创世时才算"收服"；被截断时第一条只作为后续差异的基线，
      // 不伪造事件（响应里的 truncated=true 由前端提示"更早的记录未显示"）。
      if (!result.summary.truncated) {
        timeline.push({ type: 'capture', at: current.at, txId: current.txId, to: current.ownerId });
      }
      return;
    }
    if (current.status === 'DELETED') {
      timeline.push({ type: 'delete', at: current.at, txId: current.txId });
      return;
    }
    if (current.ownerId !== previous.ownerId) {
      timeline.push({
        type: 'transfer',
        at: current.at,
        txId: current.txId,
        from: previous.ownerId,
        to: current.ownerId,
      });
    }
    if (current.name !== previous.name) {
      timeline.push({
        type: 'rename',
        at: current.at,
        txId: current.txId,
        from: previous.name,
        to: current.name,
      });
    }
    if (current.speciesId !== previous.speciesId) {
      timeline.push({
        type: 'evolve',
        at: current.at,
        txId: current.txId,
        from: previous.speciesId,
        to: current.speciesId,
      });
    }
    if (current.level > previous.level) {
      timeline.push({ type: 'level', at: current.at, txId: current.txId, from: previous.level, to: current.level });
    }
    if (current.bond !== previous.bond) {
      timeline.push({ type: 'bond', at: current.at, txId: current.txId, from: previous.bond, to: current.bond });
    }
    if (current.status === 'RELEASED' && previous.status !== 'RELEASED') {
      timeline.push({ type: 'release', at: current.at, txId: current.txId });
    }
  });

  return {
    pokemonId,
    firstOwner: result.summary.firstOwner,
    currentOwner: result.summary.currentOwner,
    transfers: result.summary.transfers,
    versions: result.summary.versions,
    truncated: result.summary.truncated,
    entries: timeline.reverse(), // 最新在前
  };
}

// --- [FEAT:history] end ---
