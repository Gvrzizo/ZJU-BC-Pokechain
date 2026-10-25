/**
 * 与后端 `backend/src/common/utils/crypto.util.ts::canonicalize` 逐字节一致：
 * 递归按对象键排序后用 JSON.stringify 标量，数组保持原顺序。
 * 战斗 resultHash = sha256(canonical(turnLog))，前端复算必须用同一口径。
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
