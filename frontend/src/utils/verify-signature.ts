import { secp256k1 } from '@noble/curves/secp256k1.js';

/**
 * 服务端（SigningService）对战斗 resultHash 的签名验证：
 * - 公钥：SPKI PEM，末尾 65 字节是未压缩点（0x04 || X || Y）；
 * - 签名：OpenSSL 输出 DER（SEQUENCE{INTEGER r, INTEGER s}），转成 64 字节 compact；
 * - 摘要是 sha256(raw resultHash bytes)，因此 noble 验签必须 `prehash: false`；
 * - OpenSSL 默认允许 high-S，故 `lowS: false`（否则会把合法的旧 serverSig 判失败）。
 */

const FIELD_BYTES = 32;
const UNCOMPRESSED_POINT_BYTES = 65;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** hex → bytes（resultHash / serverSig 都是 hex 字符串） */
export function hexToBytes(hex: string): Uint8Array {
  const clean = (hex ?? '').trim().replace(/^0x/i, '');
  if (clean.length === 0 || clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) {
    throw new Error('INVALID_HEX');
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** SPKI PEM → 65 字节未压缩 secp256k1 公钥（末尾 0x04 || X || Y）。 */
export function pemToRawPublicKey(pem: string): Uint8Array {
  const match = /-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/.exec(pem ?? '');
  if (!match) throw new Error('INVALID_PUBLIC_KEY');
  let der: Uint8Array;
  try {
    der = base64ToBytes(match[1].replace(/\s+/g, ''));
  } catch {
    throw new Error('INVALID_PUBLIC_KEY');
  }
  if (der.length < UNCOMPRESSED_POINT_BYTES) throw new Error('INVALID_PUBLIC_KEY');
  const raw = der.slice(der.length - UNCOMPRESSED_POINT_BYTES);
  if (raw[0] !== 0x04) throw new Error('INVALID_PUBLIC_KEY');
  return raw;
}

/** ASN.1 DER ECDSA 签名 → 64 字节 compact（r/s 去前导 0、左补到 32 字节）。 */
export function derToCompact(der: Uint8Array): Uint8Array {
  let offset = 0;
  const need = (count: number) => {
    if (offset + count > der.length) throw new Error('INVALID_DER');
  };
  const readLength = (): number => {
    need(1);
    const first = der[offset++];
    if (first < 0x80) return first;
    const count = first & 0x7f;
    if (count === 0 || count > 4) throw new Error('INVALID_DER');
    need(count);
    let length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + der[offset++];
    return length;
  };
  const readInteger = (): Uint8Array => {
    need(1);
    if (der[offset++] !== 0x02) throw new Error('INVALID_DER');
    const length = readLength();
    if (length === 0) throw new Error('INVALID_DER');
    need(length);
    const end = offset + length;
    let start = offset;
    while (start < end && der[start] === 0) start += 1;
    offset = end;
    const value = der.slice(start, end);
    if (value.length === 0 || value.length > FIELD_BYTES) throw new Error('INVALID_DER');
    return value;
  };

  need(1);
  if (der[offset++] !== 0x30) throw new Error('INVALID_DER');
  const sequenceLength = readLength();
  if (offset + sequenceLength !== der.length) throw new Error('INVALID_DER');
  const r = readInteger();
  const s = readInteger();
  if (offset !== der.length) throw new Error('INVALID_DER');

  const compact = new Uint8Array(FIELD_BYTES * 2);
  compact.set(r, FIELD_BYTES - r.length);
  compact.set(s, FIELD_BYTES * 2 - s.length);
  return compact;
}

/**
 * 验签：digest = sha256(hexToBytes(resultHashHex))，secp256k1 ECDSA(DER→compact)。
 * 任何解析/曲线错误都按失败处理（公平性页只展示 pass/fail，不抛异常）。
 */
export async function verifyResultSignature(
  resultHashHex: string,
  signatureDerHex: string,
  publicKeyPem: string,
): Promise<boolean> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', hexToBytes(resultHashHex) as BufferSource);
    const signature = derToCompact(hexToBytes(signatureDerHex));
    const publicKey = pemToRawPublicKey(publicKeyPem);
    return secp256k1.verify(signature, new Uint8Array(digest), publicKey, {
      prehash: false,
      lowS: false,
    });
  } catch {
    return false;
  }
}
