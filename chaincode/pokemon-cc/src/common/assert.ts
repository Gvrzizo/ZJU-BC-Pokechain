export function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

export function requireNonEmpty(value: string, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('INVALID_PARAM', `${name} must be a non-empty string`);
  }
  return value;
}

export function parseJSON<T = unknown>(raw: string, name: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('INVALID_JSON', `${name} is not valid JSON`);
  }
  return parsed as T;
}

export interface SafeIntOptions {
  min?: number;
  max?: number;
}

/** 数量/积分/经验一律非负整数（可用 min<0 允许负数，如 AddPoints 的 delta）。 */
export function safeInt(raw: string | number, name: string, opts: SafeIntOptions = {}): number {
  const min = opts.min ?? 0;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (raw === '' || raw === null || raw === undefined || !Number.isSafeInteger(n)) {
    fail('INVALID_PARAM', `${name} must be a safe integer, got "${raw}"`);
  }
  if (n < min) {
    fail('INVALID_PARAM', `${name} must be >= ${min}, got ${n}`);
  }
  if (opts.max !== undefined && n > opts.max) {
    fail('INVALID_PARAM', `${name} must be <= ${opts.max}, got ${n}`);
  }
  return n;
}

/** 运算结果必须仍是非负 safe integer（溢出/负值检查）。 */
export function checkedAmount(value: number, name: string): number {
  if (!Number.isSafeInteger(value)) {
    fail('OVERFLOW', `${name} overflows safe integer range`);
  }
  if (value < 0) {
    fail('INSUFFICIENT_POINTS', `${name} would become negative`);
  }
  return value;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

export function requireHex64(value: string, name: string): string {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    fail('INVALID_HASH', `${name} must be 64 hex chars (sha256)`);
  }
  return value.toLowerCase();
}

const HEX = /^[0-9a-fA-F]+$/;

export function requireHex(value: string, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || !HEX.test(value)) {
    fail('INVALID_PARAM', `${name} must be a non-empty hex string`);
  }
  return value;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

export function assertISO(value: string, name: string): string {
  if (typeof value !== 'string' || !ISO_RE.test(value)) {
    fail('INVALID_TIME', `${name} must be an ISO-8601 timestamp string`);
  }
  return value;
}

/** 锁定状态拒绝转移/消耗/再锁定（docs/chaincode-api.md §0.4）。 */
export function assertIdle(status: string, kind: string, id: string): void {
  if (status !== 'IDLE') {
    fail('ASSET_LOCKED', `${kind} ${id} is not IDLE (status=${status})`);
  }
}

export function parseStringArray(raw: unknown, name: string, maxLen: number): string[] {
  if (!Array.isArray(raw)) {
    fail('INVALID_PARAM', `${name} must be an array of strings`);
  }
  if (raw.length > maxLen) {
    fail('INVALID_PARAM', `${name} must have at most ${maxLen} entries, got ${raw.length}`);
  }
  for (const v of raw) {
    if (typeof v !== 'string' || v.length === 0) {
      fail('INVALID_PARAM', `${name} entries must be non-empty strings`);
    }
  }
  return raw as string[];
}

/** 可选链下上下文备注（RandomContract.Commit 的 meta）：字符串，UTF-8 字节数 ≤maxBytes，缺省为空串。 */
export function optionalMeta(raw: string | undefined | null, name: string, maxBytes = 256): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    fail('INVALID_PARAM', `${name} must be a string`);
  }
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    fail('INVALID_PARAM', `${name} must be at most ${maxBytes} bytes (UTF-8), got ${Buffer.byteLength(raw, 'utf8')}`);
  }
  return raw;
}

export function parseBoolean(raw: string, name: string): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail('INVALID_PARAM', `${name} must be "true" or "false"`);
}
