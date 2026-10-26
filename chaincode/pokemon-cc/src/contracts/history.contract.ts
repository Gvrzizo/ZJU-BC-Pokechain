import { Context, Contract, Returns, Transaction } from 'fabric-contract-api';
import { fail, requireNonEmpty } from '../common/assert';
import { keyOf } from '../common/keys';

/**
 * 宝可梦履历（[FEAT:history]）。
 *
 * 只读查询：从账本历史里取 `pokemon:<id>` 的每个版本，投影成摘要返回。
 * 为什么必须 @Transaction(false)：getHistoryForKey 的结果在不同 peer 上可能不同，
 * 放进需要背书的写交易会导致读写集不一致。
 *
 * 为什么只返回摘要：完整状态每个版本 1-2KB，一页履历只看归属/等级/物种/羁绊/状态，
 * 裁剪后体积降到约 1/10，且不把 IV/EV 等明细带到这个接口（详情接口有自己的权限口径）。
 */

const DEFAULT_MAX = 200;
const HARD_MAX = 500;

export interface HistorySummary {
  txId: string;
  /** 区块时间（ISO）。业务时间请读状态里的 createdAt。 */
  at: string;
  ownerId: string;
  /** 昵称：改名会产生新版本，履历需要识别这类变化。 */
  name: string;
  level: number;
  speciesId: number;
  bond: number;
  status: string;
}

function timestampToISO(timestamp: unknown): string {
  const ts = (timestamp ?? {}) as { seconds?: unknown; nanos?: unknown };
  const seconds = Number((ts.seconds as { toString?: () => string })?.toString?.() ?? ts.seconds ?? 0);
  const nanos = Number((ts.nanos as { toString?: () => string })?.toString?.() ?? ts.nanos ?? 0);
  return new Date(seconds * 1000 + Math.floor(nanos / 1e6)).toISOString();
}

function summarize(value: Buffer): Omit<HistorySummary, 'txId' | 'at'> {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(value.toString('utf8')) as Record<string, unknown>;
  } catch {
    fail('BAD_STATE', 'history entry is not valid JSON');
  }
  return {
    ownerId: typeof doc.ownerId === 'string' ? doc.ownerId : '',
    name: typeof doc.name === 'string' ? doc.name : '',
    level: typeof doc.level === 'number' ? doc.level : 0,
    speciesId: typeof doc.speciesId === 'number' ? doc.speciesId : 0,
    bond: typeof doc.bond === 'number' ? doc.bond : 0,
    status: typeof doc.status === 'string' ? doc.status : '',
  };
}

function parseMax(raw?: string): number {
  if (raw === undefined || raw === '') return DEFAULT_MAX;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    fail('INVALID_PARAM', `maxEntries must be a positive integer, got "${raw}"`);
  }
  return Math.min(value, HARD_MAX);
}

export class HistoryContract extends Contract {
  constructor() {
    super('HistoryContract');
  }

  /**
   * 倒序返回（最新在前）。键从未存在过时抛 POKEMON_NOT_FOUND；
   * 已被放生的资产记录仍在，历史可查（status=RELEASED）。
   */
  /**
   * 返回 `{ summary, entries }`：
   * - summary 在**完整历史**上统计（不受 maxEntries 影响），保证初训家与转手次数永远准确；
   * - entries 只返回最新 maxEntries 条（最新在前），用于时间线展示。
   *
   * 假定 getHistoryForKey 按"旧 → 新"返回（Fabric historydb 的按块高升序语义）。
   * 该假定需要在真实网络上验证一次，见 docs/feature-pokemon-history.md §7。
   */
  @Transaction(false)
  @Returns('string')
  public async GetPokemonHistory(ctx: Context, pokemonId: string, maxEntries?: string): Promise<string> {
    requireNonEmpty(pokemonId, 'pokemonId');
    const max = parseMax(maxEntries);

    const all: HistorySummary[] = [];
    const iterator = await ctx.stub.getHistoryForKey(keyOf('pokemon', pokemonId));
    try {
      let result = await iterator.next();
      while (!result.done) {
        const modification = result.value;
        const at = timestampToISO(modification.timestamp);
        if (modification.isDelete) {
          // 本项目资产不删除（放生是改状态），此处仅为完整性保留
          all.push({ txId: modification.txId, at, ownerId: '', name: '', level: 0, speciesId: 0, bond: 0, status: 'DELETED' });
        } else {
          all.push({ txId: modification.txId, at, ...summarize(Buffer.from(modification.value)) });
        }
        result = await iterator.next();
      }
    } finally {
      await iterator.close();
    }

    if (all.length === 0) {
      fail('POKEMON_NOT_FOUND', `pokemon ${pokemonId} has no ledger history`);
    }

    // 顺序归一：不同 peer 版本的 getHistoryForKey 返回方向不一致（本项目 2.5.16 实测为「新→旧」）。
    // 用首尾时间戳判断，统一整理成「新→旧」再做摘要与截断，不依赖单一版本的实现细节。
    const ordered =
      all.length < 2 || all[0].at >= all[all.length - 1].at ? all : [...all].reverse();

    // 摘要基于完整历史计算
    let transfers = 0;
    for (let i = 1; i < ordered.length; i += 1) {
      if (ordered[i].ownerId !== ordered[i - 1].ownerId) transfers += 1;
    }
    const summary = {
      firstOwner: ordered[ordered.length - 1].ownerId,
      currentOwner: ordered[0].ownerId,
      transfers,
      versions: ordered.length,
      truncated: ordered.length > max,
    };

    const entries = ordered.slice(0, max); // 已是「新→旧」
    return JSON.stringify({ summary, entries });
  }
}
