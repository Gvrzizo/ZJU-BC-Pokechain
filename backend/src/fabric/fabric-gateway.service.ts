import { createPrivateKey, createPublicKey, sign as cryptoSign } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChainIdentity } from './chain.types';

/**
 * Lazily builds fabric-gateway connections for the system identity and for
 * per-user managed certificates (certs enrolled via FabricCaService and kept
 * AES-256-GCM-encrypted in the users table — course setup, see README for the
 * HSM/KMS caveat). Only used when FABRIC_MOCK=false.
 */
@Injectable()
export class FabricGatewayService {
  private readonly logger = new Logger(FabricGatewayService.name);
  private systemGateway: import('@hyperledger/fabric-gateway').Gateway | null = null;
  private systemClient: import('@grpc/grpc-js').Client | null = null;

  constructor(private readonly config: ConfigService) {}

  private get channel(): string {
    return this.config.get<string>('fabric.channel') ?? 'gamechannel';
  }

  private get chaincode(): string {
    return this.config.get<string>('fabric.chaincode') ?? 'pokemoncc';
  }

  private resolve(p: string): string {
    return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  }

  private async newGrpcClient(): Promise<import('@grpc/grpc-js').Client> {
    const grpc = await import('@grpc/grpc-js');
    const endpoint = this.config.get<string>('fabric.peerEndpoint') ?? 'localhost:7051';
    const tlsCertPath = this.resolve(this.config.get<string>('fabric.peerTlsCertPath') ?? '');
    const hostAlias = this.config.get<string>('fabric.peerHostAlias') ?? '';
    const tlsRootCert = fs.readFileSync(tlsCertPath);
    const creds = grpc.credentials.createSsl(tlsRootCert);
    return new grpc.Client(endpoint, creds, hostAlias ? { 'grpc.ssl_target_name_override': hostAlias } : {});
  }

  private async connectWithCert(certPem: string, keyPem: string, mspId: string) {
    const { connect, signers, hash } = await import('@hyperledger/fabric-gateway');
    const client = await this.newGrpcClient();
    const privateKey = createPrivateKey(keyPem);
    const gateway = connect({
      client,
      identity: { mspId, credentials: Buffer.from(certPem, 'utf8') },
      signer: signers.newPrivateKeySigner(privateKey),
      hash: hash.sha256,
      evaluateOptions: () => ({ deadline: Date.now() + 5000 }),
      endorseOptions: () => ({ deadline: Date.now() + 15000 }),
      submitOptions: () => ({ deadline: Date.now() + 5000 }),
      commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
    });
    return { gateway, client };
  }

  /** System service identity (enrolled 'system' user with CA attr role=system). */
  async getSystemNetwork() {
    if (!this.systemGateway) {
      const dir = this.resolve(this.config.get<string>('fabric.certStoreDir') ?? '.fabric-certs');
      const cert = fs.readFileSync(path.join(dir, 'system-cert.pem'), 'utf8');
      const key = fs.readFileSync(path.join(dir, 'system-key.pem'), 'utf8');
      const mspId = this.config.get<string>('fabric.systemMspId') ?? 'Org1MSP';
      const { gateway, client } = await this.connectWithCert(cert, key, mspId);
      this.systemGateway = gateway;
      this.systemClient = client;
    }
    return this.systemGateway.getNetwork(this.channel);
  }

  /** System service identity contract handle. */
  async getSystemContract() {
    const network = await this.getSystemNetwork();
    return network.getContract(this.chaincode);
  }

  /** Per-user contract: signs with the user's managed (enrolled) certificate. */
  async getUserContract(identity: ChainIdentity, certPem: string, keyPem: string) {
    const { gateway, client } = await this.connectWithCert(certPem, keyPem, identity.mspId);
    const contract = gateway.getNetwork(this.channel).getContract(this.chaincode);
    return {
      contract,
      close: () => {
        gateway.close();
        client.close();
      },
    };
  }

  /** Detached server signature helper (secp256k1) for battle results. */
  signDigest(privateKeyPem: string, digestHex: string): string {
    const key = createPrivateKey(privateKeyPem);
    return cryptoSign('sha256', Buffer.from(digestHex, 'hex'), key).toString('hex');
  }

  publicKeyFromPrivate(privateKeyPem: string): string {
    return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString();
  }

  async close(): Promise<void> {
    this.systemGateway?.close();
    this.systemClient?.close();
    this.systemGateway = null;
    this.systemClient = null;
  }
}
