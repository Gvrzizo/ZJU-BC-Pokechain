import { Context } from 'fabric-contract-api';
import { requireNonEmpty } from './assert';
import { keyOf } from './keys';
import { IdempotencyRecord } from './model';

/**
 * 幂等助手：所有变更交易接受 idemKey；若 idemp:<idemKey> 已存在，
 * 直接返回首次结果，不重复变更（docs/chaincode-api.md §0.3）。
 */
export async function withIdempotency(
  ctx: Context,
  idemKey: string,
  nowISO: string,
  fn: () => Promise<string>,
): Promise<string> {
  requireNonEmpty(idemKey, 'idemKey');
  const key = keyOf('idemp', idemKey);
  const existing = await ctx.stub.getState(key);
  if (existing && existing.length > 0) {
    const record = JSON.parse(existing.toString()) as IdempotencyRecord;
    return record.result;
  }
  const result = await fn();
  const record: IdempotencyRecord = { docType: 'idemp', key: idemKey, result, createdAt: nowISO };
  await ctx.stub.putState(key, Buffer.from(JSON.stringify(record)));
  return result;
}
