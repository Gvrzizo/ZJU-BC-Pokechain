import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { derToCompact, hexToBytes, pemToRawPublicKey, verifyResultSignature } from './verify-signature';

/** Node 生成的 secp256k1 密钥对：与后端 SigningService（OpenSSL）同一条签名路径。 */
const pair = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
const PRIVATE_KEY = pair.privateKey;
const PUBLIC_PEM = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const RESULT_HASH = createHash('sha256').update('battle-turn-log-fixture').digest('hex');

function sign(resultHashHex: string): string {
  return cryptoSign('sha256', Buffer.from(resultHashHex, 'hex'), PRIVATE_KEY).toString('hex');
}

describe('pemToRawPublicKey', () => {
  it('取出 SPKI 末尾 65 字节未压缩公钥（0x04 前缀）', () => {
    const raw = pemToRawPublicKey(PUBLIC_PEM);
    expect(raw).toHaveLength(65);
    expect(raw[0]).toBe(0x04);
    // 与 Node 导出的 SPKI DER 末尾 65 字节一致
    const der = pair.publicKey.export({ type: 'spki', format: 'der' });
    expect(Buffer.from(raw).toString('hex')).toBe(Buffer.from(der.subarray(der.length - 65)).toString('hex'));
  });

  it('非法 PEM / 非未压缩点抛出解析错误', () => {
    expect(() => pemToRawPublicKey('')).toThrow();
    expect(() => pemToRawPublicKey('-----BEGIN PUBLIC KEY-----\nnot-base64!!!\n-----END PUBLIC KEY-----')).toThrow();
  });
});

describe('derToCompact', () => {
  it('Node DER 签名转 64 字节 compact，r/s 与 noble 解析一致', () => {
    const derHex = sign(RESULT_HASH); // Node 每次签名带随机 k，只签一次再比对
    const compact = derToCompact(hexToBytes(derHex));
    expect(compact).toHaveLength(64);
    const parsed = secp256k1.Signature.fromBytes(compact);
    const derParsed = secp256k1.Signature.fromBytes(hexToBytes(derHex), 'der');
    expect(parsed.r).toBe(derParsed.r);
    expect(parsed.s).toBe(derParsed.s);
  });

  it('截断/错 tag 的 DER 抛出错误', () => {
    const der = hexToBytes(sign(RESULT_HASH));
    expect(() => derToCompact(der.slice(0, der.length - 2))).toThrow();
    expect(() => derToCompact(new Uint8Array([0x31, 0x00]))).toThrow();
    expect(() => derToCompact(new Uint8Array())).toThrow();
  });
});

describe('verifyResultSignature', () => {
  it('Node crypto.sign 的 serverSig 验签通过', async () => {
    await expect(verifyResultSignature(RESULT_HASH, sign(RESULT_HASH), PUBLIC_PEM)).resolves.toBe(true);
  });

  it('篡改签名 / resultHash / 公钥均验签失败', async () => {
    const sig = sign(RESULT_HASH);
    const tamperedSig = `${sig.slice(0, -2)}${sig.endsWith('00') ? '01' : '00'}`;
    await expect(verifyResultSignature(RESULT_HASH, tamperedSig, PUBLIC_PEM)).resolves.toBe(false);

    const otherHash = `${RESULT_HASH.slice(0, -2)}${RESULT_HASH.endsWith('00') ? '01' : '00'}`;
    await expect(verifyResultSignature(otherHash, sig, PUBLIC_PEM)).resolves.toBe(false);

    const other = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await expect(verifyResultSignature(RESULT_HASH, sig, otherPem)).resolves.toBe(false);
  });

  it('OpenSSL 的 high-S 签名也接受（lowS: false）', async () => {
    const sigDer = hexToBytes(sign(RESULT_HASH));
    const parsed = secp256k1.Signature.fromBytes(derToCompact(sigDer));
    const n = secp256k1.Point.CURVE().n;
    // OpenSSL 可能本来就给出 high-S；不是的话把 s 换成 n-s 构造一个 high-S 签名
    const high = parsed.hasHighS() ? parsed : new secp256k1.Signature(parsed.r, n - parsed.s);
    expect(high.hasHighS()).toBe(true);
    const highDer = high.toBytes('der');
    await expect(
      verifyResultSignature(RESULT_HASH, Buffer.from(highDer).toString('hex'), PUBLIC_PEM),
    ).resolves.toBe(true);
  });

  it('格式错误返回 false 而不是抛异常', async () => {
    await expect(verifyResultSignature('', '', '')).resolves.toBe(false);
    await expect(verifyResultSignature('zz', sign(RESULT_HASH), PUBLIC_PEM)).resolves.toBe(false);
    await expect(verifyResultSignature(RESULT_HASH, '3031', PUBLIC_PEM)).resolves.toBe(false);
  });
});
