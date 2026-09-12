export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/pokechain',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-only-secret-change-me',
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtlSec: parseInt(process.env.JWT_REFRESH_TTL_SEC ?? `${7 * 24 * 3600}`, 10),
  },
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:8080')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  fabric: {
    mock: (process.env.FABRIC_MOCK ?? 'true') === 'true',
    channel: process.env.FABRIC_CHANNEL ?? 'gamechannel',
    chaincode: process.env.FABRIC_CHAINCODE ?? 'pokemoncc',
    connectionProfile:
      process.env.FABRIC_CONNECTION_PROFILE ??
      '../network/organizations/connection-org1.json',
    peerEndpoint: process.env.FABRIC_PEER_ENDPOINT ?? 'localhost:7051',
    peerHostAlias: process.env.FABRIC_PEER_HOST_ALIAS ?? 'peer0.org1.example.com',
    peerTlsCertPath:
      process.env.FABRIC_PEER_TLS_CERT_PATH ??
      '../network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt',
    caUrl: process.env.FABRIC_CA_URL ?? 'https://localhost:7054',
    caName: process.env.FABRIC_CA_NAME ?? 'ca-org1',
    caTlsCertPath:
      process.env.FABRIC_CA_TLS_CERT_PATH ??
      '../network/organizations/peerOrganizations/org1.example.com/ca/ca.org1.example.com-cert.pem',
    caAdminEnrollId: process.env.FABRIC_CA_ADMIN_ID ?? 'admin',
    caAdminEnrollSecret: process.env.FABRIC_CA_ADMIN_SECRET ?? 'adminpw',
    systemUser: process.env.FABRIC_SYSTEM_USER ?? 'system',
    systemMspId: process.env.FABRIC_SYSTEM_MSP_ID ?? 'Org1MSP',
    certStoreDir: process.env.FABRIC_CERT_STORE_DIR ?? '.fabric-certs',
  },
  // AES-256-GCM key (32 bytes hex) used to encrypt enrolled user private keys at rest.
  certEncKey: process.env.CERT_ENC_KEY ?? '',
  minio: {
    mock: (process.env.MINIO_MOCK ?? (process.env.FABRIC_MOCK ?? 'true')) === 'true',
    endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
    port: parseInt(process.env.MINIO_PORT ?? '9000', 10),
    useSSL: (process.env.MINIO_USE_SSL ?? 'false') === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
    bucket: process.env.MINIO_BUCKET ?? 'pokechain-assets',
    publicBaseUrl: process.env.MINIO_PUBLIC_BASE_URL ?? '',
  },
  battle: {
    turnTimeoutMs: parseInt(process.env.BATTLE_TURN_TIMEOUT_MS ?? '30000', 10),
    disconnectTimeoutMs: parseInt(process.env.BATTLE_DISCONNECT_TIMEOUT_MS ?? '60000', 10),
    // both players get this long to reach the battle screen after activation
    entryGraceMs: parseInt(process.env.BATTLE_ENTRY_GRACE_MS ?? '90000', 10),
    // RESULT_SUBMITTED 后等不到双方确认时的兜底结算（默认 2 分钟）
    settleFallbackMs: parseInt(process.env.BATTLE_SETTLE_FALLBACK_MS ?? '120000', 10),
    // ACTIVE 房间没有对应引擎且超过该时长 → 视为重启残留，隐藏并后台对账
    reconcileStaleMs: parseInt(process.env.BATTLE_RECONCILE_STALE_MS ?? '600000', 10),
  },
  // secp256k1 PKCS8 PEM for signing battle results; generated at boot when empty.
  serverSigningKey: process.env.SERVER_SIGNING_KEY ?? '',
});
