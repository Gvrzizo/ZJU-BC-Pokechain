// Web Crypto SHA-256 工具：BootScene 校验 vendor 资源、Fairness 页面重算哈希共用

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes =
    typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data instanceof Uint8Array ? data : data);
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function fetchSha256(url: string): Promise<{ hash: string; bytes: number }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  const buf = await res.arrayBuffer();
  return { hash: await sha256Hex(buf), bytes: buf.byteLength };
}
