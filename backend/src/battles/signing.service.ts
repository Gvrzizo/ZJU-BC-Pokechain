import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  KeyObject,
} from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Server secp256k1 signer for battle results (serverSig over resultHash). */
@Injectable()
export class SigningService {
  private readonly logger = new Logger(SigningService.name);
  private readonly privateKey: KeyObject;
  readonly publicKeyPem: string;

  constructor(config: ConfigService) {
    const pem = config.get<string>('serverSigningKey') ?? '';
    if (pem) {
      this.privateKey = createPrivateKey(pem);
    } else {
      this.logger.warn('SERVER_SIGNING_KEY not set; generated an ephemeral secp256k1 keypair');
      const pair = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
      this.privateKey = pair.privateKey;
    }
    this.publicKeyPem = createPublicKey(this.privateKey)
      .export({ type: 'spki', format: 'pem' })
      .toString();
  }

  /** secp256k1/SHA-256 signature over the raw resultHash bytes, DER hex. */
  signResultHash(resultHashHex: string): string {
    return cryptoSign('sha256', Buffer.from(resultHashHex, 'hex'), this.privateKey).toString('hex');
  }

  verifyResultHash(resultHashHex: string, sigHex: string): boolean {
    try {
      return cryptoVerify(
        'sha256',
        Buffer.from(resultHashHex, 'hex'),
        createPublicKey(this.privateKey),
        Buffer.from(sigHex, 'hex'),
      );
    } catch {
      return false;
    }
  }
}
