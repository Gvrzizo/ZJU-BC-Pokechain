import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const FALLBACK_KEY = createHash('sha256').update('pokechain-dev-cert-key', 'utf8').digest();

function keyFrom(hexKey: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(hexKey)) return Buffer.from(hexKey, 'hex');
  return FALLBACK_KEY;
}

/** AES-256-GCM at-rest encryption for enrolled Fabric private keys (course setup). */
export function encryptSecret(plain: string, hexKey: string): string {
  const key = keyFrom(hexKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(stored: string, hexKey: string): string {
  const key = keyFrom(hexKey);
  const buf = Buffer.from(stored, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
