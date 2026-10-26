import type { PokemonHistoryEvent } from '@/api/pokemon';

// --- [FEAT:history] begin ---

/** 区块时间（UTC，来自账本）→ `YYYY-MM-DD HH:mm`。固定按 ISO 字符串切，不依赖本地时区。 */
export function formatBlockTime(iso: string): string {
  if (!iso || iso.length < 16) return iso || '—';
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * 事件右侧的细节文案。抓不到含义时返回空串，模板里就不渲染。
 * `speciesName` 用于把进化目标 speciesId 翻成名字。
 */
export function eventDetail(
  event: PokemonHistoryEvent,
  speciesName: (speciesId: number) => string = (id) => `No.${id}`,
): string {
  switch (event.type) {
    case 'capture':
      return event.to ? `→ ${String(event.to)}` : '';
    case 'rename':
      return `${String(event.from ?? '—')} → ${String(event.to ?? '—')}`;
    case 'transfer':
      // 放生会让 to 变空串
      return `${String(event.from || '—')} → ${String(event.to || '—')}`;
    case 'evolve':
      return `${speciesName(Number(event.from))} → ${speciesName(Number(event.to))}`;
    case 'level':
      return `Lv${String(event.from)} → Lv${String(event.to)}`;
    case 'bond':
      return `${String(event.from)} → ${String(event.to)}`;
    case 'release':
    case 'delete':
      return '';
    default:
      return '';
  }
}

/** 摘要行：初训家 / 转手次数 / 版本数。由完整历史统计，不受时间线截断影响。 */
export function summaryParts(history: {
  firstOwner: string;
  transfers: number;
  versions: number;
}): Array<{ label: 'firstOwner' | 'transfers' | 'versions'; value: string }> {
  return [
    { label: 'firstOwner', value: history.firstOwner || '—' },
    { label: 'transfers', value: String(history.transfers) },
    { label: 'versions', value: String(history.versions) },
  ];
}

// --- [FEAT:history] end ---
