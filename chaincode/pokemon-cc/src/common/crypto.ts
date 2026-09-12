import { createHash, createHmac } from 'node:crypto';

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** canonical(obj)：键排序后的 JSON.stringify（嵌套对象递归排序，数组保序）。 */
export function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortValue(obj));
}

export function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function hmacSha256hex(key: string, message: string): string {
  return createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

/**
 * 可验证随机流派生（链上/链下一致，见 docs/chaincode-api.md §2.2）：
 * 第 n 个随机值（n 从 0 起）= HMAC-SHA256(key=serverSeed, message=clientSeed|eventId|n)
 * 取前 8 字节为大端整数 / 2^64 得 [0,1) 浮点。
 */
export function deriveRandom(serverSeed: string, clientSeed: string, eventId: string, n: number): number {
  const digest = createHmac('sha256', serverSeed).update(`${clientSeed}|${eventId}|${n}`, 'utf8').digest();
  return Number(digest.readBigUInt64BE(0)) / 2 ** 64;
}

/** resultHash = sha256(serverSeed + "|" + clientSeed + "|" + eventId) */
export function computeResultHash(serverSeed: string, clientSeed: string, eventId: string): string {
  return sha256hex(`${serverSeed}|${clientSeed}|${eventId}`);
}
