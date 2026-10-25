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
  private adminGateway: import('@hyperledger/fabric-gateway').Gateway | null = null;
  private adminClient: import('@grpc/grpc-js').Client | null = null;
  private warnedAdminFallback = false;

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

  /**
   * Service identity gateway (system or admin). Certificates are created by
   * `scripts/enroll-system.sh` and mounted read-only in real-chain mode (C4c).
   */
  private async getServiceGateway(
    kind: 'system' | 'admin',
  ): Promise<import('@hyperledger/fabric-gateway').Gateway> {
    if (kind === 'system' && this.systemGateway) return this.systemGateway;
    if (kind === 'admin' && this.adminGateway) return this.adminGateway;

    const dir = this.resolve(this.config.get<string>('fabric.certStoreDir') ?? '.fabric-certs');
    const prefix = kind;
    const certPath = path.join(dir, `${prefix}-cert.pem`);
    const keyPath = path.join(dir, `${prefix}-key.pem`);
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      if (kind === 'admin') {
        // H20：没有 admin 证书时退回 system（能发 AddPoints/MintItem，但链码
        // GrantRole 只认 role=admin，会失败）。提示一次，不阻断启动。
        if (!this.warnedAdminFallback) {
          this.warnedAdminFallback = true;
          this.logger.warn(
            'admin service certificate missing; falling back to the system identity ' +
              '(GrantRole will fail on a real chain). Run scripts/enroll-system.sh to enroll admin.',
          );
        }
        return this.getServiceGateway('system');
      }
      throw new Error(
        `NO_SERVICE_CERT: ${certPath} not found. Run scripts/enroll-system.sh ` +
          '(or follow docs/deployment.md §4.4) before starting FABRIC_MOCK=false.',
      );
    }
    const cert = fs.readFileSync(certPath, 'utf8');
    const key = fs.readFileSync(keyPath, 'utf8');
    const mspId = this.config.get<string>('fabric.systemMspId') ?? 'Org1MSP';
    const { gateway, client } = await this.connectWithCert(cert, key, mspId);
    if (kind === 'system') {
      this.systemGateway = gateway;
      this.systemClient = client;
    } else {
      this.adminGateway = gateway;
      this.adminClient = client;
    }
    return gateway;
  }

  /** System service identity (enrolled 'system' user with CA attr role=system). */
  async getSystemNetwork() {
    const gateway = await this.getServiceGateway('system');
    return gateway.getNetwork(this.channel);
  }

  /** System service identity contract handle. */
  async getSystemContract() {
    const network = await this.getSystemNetwork();
    return network.getContract(this.chaincode);
  }

  /** Admin service identity (enrolled 'opsadmin' user with CA attr role=admin, H20). */
  async getAdminNetwork() {
    const gateway = await this.getServiceGateway('admin');
    return gateway.getNetwork(this.channel);
  }

  /** Admin service identity contract handle (GrantRole / admin-only transactions). */
  async getAdminContract() {
    const network = await this.getAdminNetwork();
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
    this.adminGateway?.close();
    this.adminClient?.close();
    this.systemGateway = null;
    this.systemClient = null;
    this.adminGateway = null;
    this.adminClient = null;
  }
}
