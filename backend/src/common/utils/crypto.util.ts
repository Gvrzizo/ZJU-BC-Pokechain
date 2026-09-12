import { createHash, createHmac } from 'crypto';

/**
 * Canonical JSON: object keys sorted recursively, then JSON.stringify.
 * Must stay byte-identical with the chaincode implementation (chaincode-api.md §0.6).
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) as string;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export function sha256hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export function hmacSha256(key: string, message: string): Buffer {
  return createHmac('sha256', key).update(message, 'utf8').digest();
}

const TWO_POW_64 = 18446744073709551616; // 2^64

/**
 * Deterministic random stream shared by backend and chaincode (chaincode-api.md §2.2):
 * the n-th value (0-based) = HMAC-SHA256(key=serverSeed, msg=`clientSeed|eventId|n`),
 * first 8 bytes as big-endian uint64 / 2^64 -> [0,1).
 */
export class DeriveStream {
  private cursor = 0;

  constructor(
    private readonly serverSeed: string,
    private readonly clientSeed: string,
    private readonly eventId: string,
  ) {}

  at(n: number): number {
    const digest = hmacSha256(this.serverSeed, `${this.clientSeed}|${this.eventId}|${n}`);
    const value = digest.readBigUInt64BE(0);
    return Number(value) / TWO_POW_64;
  }

  next(): number {
    return this.at(this.cursor++);
  }
}
