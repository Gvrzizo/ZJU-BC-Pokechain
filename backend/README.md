# PokeChain Backend (NestJS 10)

REST + WebSocket API bridging the `pokemoncc` Fabric chaincode
(`../docs/backend-api.md`, `../docs/chaincode-api.md`).

## Quick start (mock mode, no Fabric network)

```bash
cp .env.example .env          # FABRIC_MOCK=true by default
# start Postgres + Redis locally, e.g.:
#   docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=pokechain postgres:16
#   docker run -d -p 6379:6379 redis:7
npm install
npm run seed                  # demo users ash/gary/arbiter/admin, password demo1234
npm run start:dev             # http://localhost:3000/api/v1
```

In mock mode the whole chaincode state machine (locking / escrow / idempotency /
commit-reveal with real sha256 + HMAC derivation) runs against a Redis-backed
shared world state (`mockchain:*`, see `src/fabric/mock-chain.store.ts`), so the
full demo — capture, trades, wagers, battles, arbitration — works without any
Fabric network, and the `npm run seed` process, the API process and reruns all
see the same ledger state.

## Scripts

| script | purpose |
|---|---|
| `npm run build` | `nest build` -> `dist/` |
| `npm run start:dev` | watch-mode dev server |
| `npm run start:prod` | `node dist/main.js` |
| `npm run seed` | demo accounts + items + pokemon (runs `dist/scripts/seed.js` — requires `npm run build` first) |
| `npm run seed:dev` | same seed via ts-node (`tsconfig.seed.json`), no build needed |
| `npm test` | jest unit tests (no external services needed) |

Seed is fully idempotent: existing accounts are skipped, on-chain `RegisterPlayer`
dedups via idemKey, and items/pokemon use deterministic ids + fixed idemKeys
(`seed-v1-*`), so reruns replay the first result instead of duplicating assets.

## 图鉴数据（#1–386，第三世代全量）

`src/game-data/species.data.ts` 收录全国图鉴 **#1–386**：前 12 条是手调条目（原有演示种族，
数值/技能原样保留），其余由 `tools/` 下的一次性脚本从 **PokeAPI** 生成
（`node tools/fetch-pokedex.mjs` → `node tools/gen-pokedex.mjs` → `node tools/fetch-sprites.mjs`，
抓取结果缓存在 `/tmp/pokeapi-data.json`，重跑不重复打接口）：

| 字段 | 来源 / 口径 |
|---|---|
| `base` 种族值、`catchRate`、`ability` | `GET /pokemon/<id>`（stats / abilities）与 `GET /pokemon-species/<id>`（capture_rate） |
| `type` | `/pokemon/<id>` 第一属性（slot 1）；本作是单属性模型，双属性只保留主属性 |
| `name` / `nameZh` | species 的英文 slug / `zh-hans` 官方译名（#1–151 沿用 `frontend/src/locales/zh.ts`） |
| `defaultMoves` | `moves.data.ts` 里属性匹配的技能按威力升序取 4 个（主/副属性混合，不足用一般属性补齐） |
| `inWild` | 传说 / 幻之 = `false`（21 个）；手调的 4 个进化型（#26/#134/#135/#136）保持 `false`；其余 = `true`（野生池 361） |
| `EVOLUTIONS` | `GET /evolution-chain/<n>` 的进化边，两端都在 #1–386 内即收录；`minLevel` 取官方升级等级，非等级进化（亲密度/通信交换/其他石头）给保守默认值（交换 30 / 道具 20），只有本作三种石头写成 `stoneTypeId` |

- 战斗侧的属性克制表（`type-chart.ts` 的 `TYPE_CHART`）**未随图鉴扩充**：仍是 fire/water/grass/electric/psychic/dark 六系，
  其余属性（含 normal/dragon 与第三世代新增的飞行/虫/冰等）双向中立，口径见 `docs/randomness.md`。
- 已知简化：不模拟双属性、蓄力/冰冻/畏缩等（新增技能一律映射到现有 `MoveEffect` 四种效果之一）。
- 前端配套：`frontend/src/locales/{zh,en}.ts` 补 #152–386 译名与 17 个新技能名；sprite/叫声在
  `frontend/public/assets/vendor/`（正面/背面 #1–386，叫声 361 个野生种族），BootScene 预载清单见 `frontend/src/game/mon-assets.ts`。

## Environment variables (`.env.example`)

- `PORT` (3000), `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_ACCESS_TTL=15m`,
  `JWT_REFRESH_TTL_SEC=604800` (7d), `CORS_ORIGINS` (default `http://localhost:8080`)
- `FABRIC_MOCK=true|false` — switch between `MockChainAdapter` and
  `FabricChainAdapter` (@hyperledger/fabric-gateway)
- Fabric network: `FABRIC_CHANNEL=gamechannel`, `FABRIC_CHAINCODE=pokemoncc`,
  `FABRIC_PEER_ENDPOINT` / `FABRIC_PEER_TLS_CERT_PATH` / `FABRIC_PEER_HOST_ALIAS`
  (direct peer connection via fabric-gateway; `FABRIC_CONNECTION_PROFILE`
  exists in config but is not consumed), `FABRIC_CA_*` (register/enroll via
  fabric-ca-client), `FABRIC_CERT_STORE_DIR`
- `CERT_ENC_KEY` — 64-hex AES-256-GCM key protecting enrolled user private keys
  in the `users` table (course setup — production should use HSM/KMS)
- `MINIO_*` — asset manifest / presigned URLs (`MINIO_MOCK=true` returns a
  static manifest)
- `BATTLE_TURN_TIMEOUT_MS=30000`, `BATTLE_DISCONNECT_TIMEOUT_MS=60000`,
  `BATTLE_SETTLE_FALLBACK_MS=300000`
- `SERVER_SIGNING_KEY` — secp256k1 PKCS8 PEM for battle `serverSig`
  (ephemeral key generated at boot when unset)

## Architecture

```
src/
  fabric/            ChainAdapter (1 method per chaincode tx) + two implementations
    mock-chain.adapter.ts     in-memory chaincode semantics (FABRIC_MOCK=true)
    fabric-chain.adapter.ts   real network via fabric-gateway; per-user managed certs
    fabric-ca.service.ts      fabric-ca-client register/enroll (skipped in mock)
    contract.service.ts       typed facade; injects nowISO + idemKey=randomUUID()
    chain-events.service.ts   chain event fan-out (mock: direct, fabric: event listener)
  auth/ users/ social/ pokemon/ items/ trades/
  battles/           rooms + wager double-confirm, Socket.IO /battle namespace,
    engine/          server-authoritative turn engine (12 species — 8 wild +
                     4 evolution-only, 6-type chart, 24 moves, 30s turn
                     timeout, 60s disconnect forfeit)
  fairness/ assets/ admin/ leaderboard/
  common/            JWT/roles guards, rate-limit guard, anti-replay interceptor,
                     unified error filter {statusCode, code, message}
```

### Security baseline

helmet, CORS whitelist, global `ValidationPipe(whitelist, transform)`, TypeORM
parameterized queries, argon2 password hashing, short-lived JWT + Redis refresh
whitelist with rotation, anti-replay (`X-Nonce` + `X-Timestamp`, Redis
`SET NX EX 300`, 409 on reuse), sliding-window rate limits (100/min per user,
10/min per IP on login/register), no logging of passwords/keys/unrevealed seeds.

### Determinism & fairness

- Capture: server commits `sha256(serverSeed)` on-chain **before** deriving the
  encounter; `attempt` consumes the ball, reveals, judges via the documented
  HMAC stream, and mints through `MintFromCapture` (which consumes the random).
  Stream layout is documented at `GET /fairness/:eventId` (one event covers
  encounter + all attempts, so the doc's `rand(0..8)` indices are offset into
  per-attempt blocks of 10 — see `src/pokemon/capture-derive.ts`).
- Battles: hit/crit/damage rolls come from a battle-scoped RandomCommit
  (revealed at the end); `resultHash = sha256(canonical(turnLog))`,
  `serverSig = secp256k1/SHA-256(resultHash)`; verify with the public key from
  the fairness endpoint.

### Database

`TypeORM synchronize=true` — **course environment only**, no migrations. Tables:
`users, friendships, blacklists, battle_logs, audit_logs, assets, chat_messages`.

### Tests

`npm test` covers: engine math (damage formula, type chart, hit/crit, speed
order, must-switch), turn timeout / disconnect / forfeit, capture formula and
the HMAC derivation (golden vector + SEED_MISMATCH), trade lifecycle
(lock/confirm/cancel/expire/double-spend/idempotent replay), and wager
settlement incl. escrow, DRAW refund, settle fallback, dispute->arbitrate and
role enforcement. All tests run against the in-memory mock chain, ioredis-mock
and stub repositories — no Postgres/Redis/Fabric needed.
