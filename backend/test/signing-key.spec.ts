import { generateKeyPairSync } from 'crypto';
import { SigningService } from '../src/battles/signing.service';
import { makeConfig } from './helpers';

/** H19：SERVER_SIGNING_KEY 固定后，重启/多实例必须得到同一把公钥与 keyId。 */
describe('SigningService 持久化密钥（H19）', () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const hash = 'ab'.repeat(32);

  it('固定 SERVER_SIGNING_KEY：两个实例 keyId/公钥一致，签名可互验', () => {
    const first = new SigningService(makeConfig({ serverSigningKey: pem }));
    const second = new SigningService(makeConfig({ serverSigningKey: pem }));
    expect(first.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(second.keyId).toBe(first.keyId);
    expect(second.publicKeyPem).toBe(first.publicKeyPem);

    const sig = first.signResultHash(hash);
    expect(second.verifyResultHash(hash, sig)).toBe(true);
    expect(second.verifyResultHash('cd'.repeat(32), sig)).toBe(false);
  });

  it('空值：临时钥可签名/验签，但 keyId 每次启动不同（重启后旧 serverSig 不可验证）', () => {
    const first = new SigningService(makeConfig({ serverSigningKey: '' }));
    const second = new SigningService(makeConfig({ serverSigningKey: '' }));
    expect(first.keyId).not.toBe(second.keyId);

    const sig = first.signResultHash(hash);
    expect(first.verifyResultHash(hash, sig)).toBe(true);
    expect(second.verifyResultHash(hash, sig)).toBe(false);
  });
});
