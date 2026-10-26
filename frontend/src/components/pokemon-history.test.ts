import { describe, expect, it } from 'vitest';
import { eventDetail, formatBlockTime, summaryParts } from './pokemon-history';
import type { PokemonHistoryEvent } from '@/api/pokemon';

// --- [FEAT:history] begin ---

const species = (id: number): string => ({ 1: '妙蛙种子', 2: '妙蛙草', 25: '皮卡丘' })[id] ?? `No.${id}`;
const ev = (over: Partial<PokemonHistoryEvent> = {}): PokemonHistoryEvent => ({
  type: 'capture',
  at: '2026-10-26T04:13:22.348Z',
  txId: 'tx1',
  ...over,
});

describe('履历时间线（纯函数）', () => {
  it('区块时间按 UTC 切分，不依赖本地时区', () => {
    expect(formatBlockTime('2026-10-26T04:13:22.348Z')).toBe('2026-10-26 04:13');
    expect(formatBlockTime('')).toBe('—');
  });

  it('收服只显示归属；改名与进化显示前后值', () => {
    expect(eventDetail(ev({ type: 'capture', to: 'ash' }), species)).toBe('→ ash');
    expect(eventDetail(ev({ type: 'rename', from: 'bulbasaur', to: '履历一号' }), species)).toBe(
      'bulbasaur → 履历一号',
    );
    expect(eventDetail(ev({ type: 'evolve', from: 1, to: 2 }), species)).toBe('妙蛙种子 → 妙蛙草');
  });

  it('易主显示 from → to，放生时 to 为空显示占位', () => {
    expect(eventDetail(ev({ type: 'transfer', from: 'ash', to: 'gary' }), species)).toBe('ash → gary');
    expect(eventDetail(ev({ type: 'transfer', from: 'ash', to: '' }), species)).toBe('ash → —');
  });

  it('升级与羁绊显示数值变化，放生/删除没有细节', () => {
    expect(eventDetail(ev({ type: 'level', from: 5, to: 6 }), species)).toBe('Lv5 → Lv6');
    expect(eventDetail(ev({ type: 'bond', from: 50, to: 30 }), species)).toBe('50 → 30');
    expect(eventDetail(ev({ type: 'release' }), species)).toBe('');
    expect(eventDetail(ev({ type: 'delete' }), species)).toBe('');
  });

  it('摘要使用完整历史的统计值（空初训家显示占位）', () => {
    expect(summaryParts({ firstOwner: 'ash', transfers: 2, versions: 9 })).toEqual([
      { label: 'firstOwner', value: 'ash' },
      { label: 'transfers', value: '2' },
      { label: 'versions', value: '9' },
    ]);
    expect(summaryParts({ firstOwner: '', transfers: 0, versions: 1 })[0].value).toBe('—');
  });
});

// --- [FEAT:history] end ---
