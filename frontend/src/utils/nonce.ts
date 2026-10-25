/**
 * 一次性 nonce（H18）：X-Nonce 防重放头用。
 *
 * `crypto.randomUUID` 只在安全上下文（https / localhost）可用；课程演示若从内网 IP
 * 以 http 访问，部分浏览器会直接没有这个方法，拦截器会抛错导致**所有变更请求失败**。
 * 退回 `getRandomValues`（16 字节 hex），再退回时间戳 + Math.random（仅最后兜底）。
 */
export function createNonce(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoObj?.randomUUID === 'function') return cryptoObj.randomUUID();
  if (typeof cryptoObj?.getRandomValues === 'function') {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
