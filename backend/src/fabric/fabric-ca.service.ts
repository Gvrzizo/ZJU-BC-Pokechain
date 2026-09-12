import * as fs from 'fs';
import * as path from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Fabric CA integration (fabric-ca-client): registers/enrolls the system
 * identity at bootstrap and player identities at signup. Only used when
 * FABRIC_MOCK=false; all network calls are lazy so importing this module never
 * touches the network.
 */
@Injectable()
export class FabricCaService {
  private readonly logger = new Logger(FabricCaService.name);

  constructor(private readonly config: ConfigService) {}

  private resolve(p: string): string {
    return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  }

  private async newCa() {
    const { default: FabricCAServices } = await import('fabric-ca-client');
    const caUrl = this.config.get<string>('fabric.caUrl') ?? 'https://localhost:7054';
    const caName = this.config.get<string>('fabric.caName') ?? 'ca-org1';
    const configured = this.config.get<string>('fabric.caTlsCertPath') ?? '';
    const tlsCertPath = configured ? this.resolve(configured) : '';
    const hasTls = !!tlsCertPath && fs.existsSync(tlsCertPath) && fs.statSync(tlsCertPath).isFile();
    const tlsOptions = hasTls
      ? { trustedRoots: fs.readFileSync(tlsCertPath) as Buffer, verify: true }
      : { trustedRoots: [] as string[], verify: false };
    return new FabricCAServices(caUrl, tlsOptions, caName);
  }

  async enroll(
    enrollmentID: string,
    enrollmentSecret: string,
  ): Promise<{ cert: string; key: string }> {
    const ca = await this.newCa();
    const enrollment = await ca.enroll({ enrollmentID, enrollmentSecret });
    return {
      cert: enrollment.certificate,
      key: enrollment.key.toBytes(),
    };
  }

  /**
   * Register + enroll a new user. `role` is written as a CA attribute so the
   * chaincode can read it via CID getAttrValue('role').
   */
  async registerAndEnroll(
    username: string,
    role: 'player' | 'arbitrator' | 'system',
  ): Promise<{ cert: string; key: string }> {
    const ca = await this.newCa();
    const adminId = this.config.get<string>('fabric.caAdminEnrollId') ?? 'admin';
    const adminSecret = this.config.get<string>('fabric.caAdminEnrollSecret') ?? 'adminpw';
    const adminEnrollment = await ca.enroll({ enrollmentID: adminId, enrollmentSecret: adminSecret });
    const { User } = await import('fabric-common');
    const mspId = this.config.get<string>('fabric.systemMspId') ?? 'Org1MSP';
    const adminUser = User.createUser(
      adminId,
      'unused-password',
      mspId,
      adminEnrollment.certificate,
      adminEnrollment.key.toBytes(),
    );

    const secret = await ca.register(
      {
        enrollmentID: username,
        affiliation: 'org1.department1',
        role: 'client',
        attrs: [
          { name: 'role', value: role, ecert: true },
          { name: 'hf.EnrollmentID', value: username, ecert: true },
        ],
        maxEnrollments: 1,
      },
      adminUser,
    );
    this.logger.log(`registered fabric identity ${username} (role=${role})`);
    return this.enroll(username, secret);
  }

  /** Enroll the shared system identity and persist it under certStoreDir. */
  async ensureSystemIdentity(): Promise<void> {
    const dir = this.resolve(this.config.get<string>('fabric.certStoreDir') ?? '.fabric-certs');
    const certPath = path.join(dir, 'system-cert.pem');
    const keyPath = path.join(dir, 'system-key.pem');
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) return;
    fs.mkdirSync(dir, { recursive: true });
    const systemUser = this.config.get<string>('fabric.systemUser') ?? 'system';
    const { cert, key } = await this.registerAndEnroll(systemUser, 'system');
    fs.writeFileSync(certPath, cert, { mode: 0o644 });
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    this.logger.log(`system fabric identity enrolled into ${dir}`);
  }
}
