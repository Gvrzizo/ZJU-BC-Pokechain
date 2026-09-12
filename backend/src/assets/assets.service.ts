import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Asset } from './entities/asset.entity';

export interface ManifestEntry {
  uri: string;
  sha256: string;
  size: number;
}

const STATIC_MANIFEST: ManifestEntry[] = [
  { uri: 'minio://assets/sprites/3.png', sha256: '', size: 0 },
  { uri: 'minio://assets/sprites/6.png', sha256: '', size: 0 },
  { uri: 'minio://assets/sprites/9.png', sha256: '', size: 0 },
  { uri: 'minio://assets/sprites/25.png', sha256: '', size: 0 },
  { uri: 'minio://assets/sprites/94.png', sha256: '', size: 0 },
  { uri: 'minio://assets/sprites/133.png', sha256: '', size: 0 },
  { uri: 'minio://assets/sprites/143.png', sha256: '', size: 0 },
  { uri: 'minio://assets/sprites/149.png', sha256: '', size: 0 },
  { uri: 'minio://assets/items/poke-ball.png', sha256: '', size: 0 },
  { uri: 'minio://assets/items/great-ball.png', sha256: '', size: 0 },
  { uri: 'minio://assets/items/ultra-ball.png', sha256: '', size: 0 },
];

/** Asset manifest + presigned URLs via MinIO (static manifest when MINIO_MOCK=true). */
@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);
  private minioClient: import('minio').Client | null = null;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(Asset) private readonly assets: Repository<Asset>,
  ) {}

  private get mock(): boolean {
    return this.config.get<boolean>('minio.mock') ?? true;
  }

  private async client(): Promise<import('minio').Client> {
    if (!this.minioClient) {
      const Minio = await import('minio');
      this.minioClient = new Minio.Client({
        endPoint: this.config.get<string>('minio.endPoint') ?? 'localhost',
        port: this.config.get<number>('minio.port') ?? 9000,
        useSSL: this.config.get<boolean>('minio.useSSL') ?? false,
        accessKey: this.config.get<string>('minio.accessKey') ?? 'minioadmin',
        secretKey: this.config.get<string>('minio.secretKey') ?? 'minioadmin',
      });
    }
    return this.minioClient;
  }

  async manifest(): Promise<ManifestEntry[]> {
    if (this.mock) {
      const registered = await this.assets.find().catch(() => [] as Asset[]);
      return [...STATIC_MANIFEST, ...registered.map((a) => ({ uri: a.uri, sha256: a.sha256, size: a.size }))];
    }
    const client = await this.client();
    const bucket = this.config.get<string>('minio.bucket') ?? 'pokechain-assets';
    const base = this.config.get<string>('minio.publicBaseUrl') ?? '';
    const registered = await this.assets.find();
    const out: ManifestEntry[] = [];
    for (const asset of registered) {
      const objectName = asset.uri.replace(/^minio:\/\/[^/]+\//, '');
      let url = asset.uri;
      try {
        url = base
          ? `${base.replace(/\/$/, '')}/${bucket}/${objectName}`
          : await client.presignedGetObject(bucket, objectName, 3600);
      } catch (err) {
        this.logger.warn(`presign failed for ${asset.uri}: ${(err as Error).message}`);
      }
      out.push({ uri: url, sha256: asset.sha256, size: asset.size });
    }
    return out;
  }

  async register(uri: string, sha256: string, size: number, registeredBy: string): Promise<Asset> {
    const existing = await this.assets.findOne({ where: { uri } });
    if (existing) {
      existing.sha256 = sha256;
      existing.size = size;
      existing.registeredBy = registeredBy;
      return this.assets.save(existing);
    }
    return this.assets.save(this.assets.create({ uri, sha256, size, registeredBy }));
  }
}
