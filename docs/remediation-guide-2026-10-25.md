# PokeChain 修复指导文档（执行版）

> 配套评审：[`docs/review-2026-10-25.md`](./review-2026-10-25.md)  
> 目标读者：新会话中的执行 Agent  
> 目标：按优先级修复评审中的 Critical/High 问题，保留现有架构与 Mock 演示能力，不重写项目。  
> 原则：**一次只做一个工作包；每个工作包测试全绿、文档同步、单独提交；不要在修安全问题时顺手改经济/视觉。**

---

## 0. 开始前必读

### 0.1 必读文件

1. `AGENTS.md`：仓库纪律、测试命令、架构决策、提交规范。
2. `docs/review-2026-10-25.md`：本次评审的证据、复现步骤、完整问题清单。
3. `docs/chaincode-api.md`、`docs/backend-api.md`：修改链码/API 的权威契约。
4. `docs/security.md`、`docs/randomness.md`、`docs/deployment.md`：身份、随机、真链部署。
5. `docs/architecture.md`：模块边界与双链模式。

### 0.2 工作方式（强制）

- 从 `main` 开分支：`git checkout -b fix/review-p0`。
- 每个工作包一个 commit；提交信息用中文约定式，例如 `fix(chaincode): 以 hf.EnrollmentID 校验玩家身份`。
- 每个工作包完成前必须：
  1. `cd chaincode/pokemon-cc && npm test && npm run build`
  2. `cd backend && npm run build && npm test`
  3. `cd frontend && npm run build && npm test`
  4. 如改链码：`python3 -m unittest discover -s frontend/tools -p 'test_*.py'` 可不动，但前端构建必须过。
  5. 更新 `AGENTS.md` 的测试计数与相关决策；更新受影响的 `docs/`。
  6. `git add` 只加本工作包文件，**不要 `git add -A`**（仓库里可能有评审报告、临时证书、日志）。
- 不允许：
  - 在链码里用 `Date.now()`、`Math.random()`、网络调用、`invokeChaincode`；
  - 为了让测试过而放宽链码权限/删断言；
  - 把 `CERT_ENC_KEY`、私钥、serverSeed 写进日志或提交；
  - 提交 `node_modules/`、`dist/`、`network/organizations/`、`frontend/public/assets/vendor/`、`backend/.fabric-certs/`；
  - 把 Mock 模式删掉（它是课程演示和 367 个测试的基础）。

### 0.3 环境基线

- 端口：前端 8080、后端 3000、PG 5432、Redis 6379；Fabric peer 7051/9051、CA 7054/8054。
- 默认应用栈：`docker compose up -d --build`，`FABRIC_MOCK=true`。
- 基线测试：链码 88、后端 367、前端 200；Mock e2e 25/25。
- 真链：见 §4；评审已证明“修 4 处后可 25/25”，但也证明“开箱即用不成立”。

### 0.4 当前评审环境说明

- 评审用的 3100 后端、`pokechain-cc` 容器已停止；本地 Fabric 账本被临时升级到 sequence 2，并留有 `smkA/smkB/audit` 测试数据。
- 默认 8080/3000 的 Mock 演示栈健康。
- 如果你要复现真链，先按 §4 重新准备 system 身份与链码服务；不要在未确认 `querycommitted`/`GetPlayer` 可调用前跑 e2e。

---

## 1. 修复顺序总表

> 依赖关系：C1 必须最先；C2/C3 依赖 C1 的测试 harness；C5/C6 可并行；C4 可在 C1-C3 之后；P1 在 P0 全绿后开始。

| 批次 | ID | 工作包 | 严重度 | 预估 | 依赖 |
|---|---|---|---|---|---|
| P0-1 | C1 | 链码身份：`hf.EnrollmentID` 校验 | Critical | 0.5-1d | 无 |
| P0-2 | C2/C3 | 铸造/揭示/养成权限收紧 | Critical | 1d | P0-1 |
| P0-3 | C5 | 交易只锁发起方资产 + TTL 上限 | Critical | 0.5-1d | P0-1 |
| P0-4 | C4 | 真链 CA/系统身份/链码部署 | Critical（部署） | 1-2d | P0-2 |
| P0-5 | C6 | `Forfeit` 写入 winner/result | High | 0.5h | 无 |
| P0-6 | H1/H2 | 宝可梦详情 BOLA + 队伍去重 | High | 0.5d | 无 |
| P1-1 | H3/H4 | PvP 经验 + 排行榜事件 | High | 1d | P0-5 |
| P1-2 | H5 | 房间启动失败补偿（含 `CancelBattle`） | High | 1-1.5d | P0-5 |
| P1-3 | H6/H7 | 免费学技能 + 锁定资产先消耗 | High | 1d | P0-2 |
| P1-4 | H8 | 链上错误码 → HTTP 映射 | High | 0.5d | 无 |
| P1-5 | H9 | 首球 reveal 改为结算后 reveal | High | 1-2d | P0-2 |
| P1-6 | H14-H17 | 前端交易/战斗重连/刷新 | High | 1d | P1-1/P1-2 |
| P1-7 | H19 | `SERVER_SIGNING_KEY` 持久化 | Medium | 0.5d | 无 |
| P2-1 | H10-H13 | 经济重平衡（注册/钥匙/竞技场/大师球/价格） | High（经济） | 2-3d | P1 全绿 |
| P2-2 | — | Mock/链码对拍、事件类型、@Global、BondModule | 架构 | 2-3d | P0/P1 |
| P2-3 | H18/H20 | 前端边角、admin 真链身份 | Medium | 0.5-1d | P1 |

**建议第一天只做 P0-1、P0-5、P0-6**，先建立“身份 + 负向测试 + 两个小修”的节奏；不要一上来改 C4 部署。

---

## 2. P0 工作包

## P0-1（C1）：链码身份必须校验到“用户”，不能只校验 MSP

### 现状

`chaincode/pokemon-cc/src/common/state.ts:71-76`：

```ts
export function assertCallerIsPlayer(ctx: Context, player: Player): void {
  const caller = getMspId(ctx);
  if (caller !== player.mspId) {
    fail('NOT_OWNER', `caller msp ${caller} does not match player ...`);
  }
}
```

所有玩家都在 `Org1MSP`，所以这个检查对任意玩家都成立。评审用普通玩家证书成功 `TransferPoints` 转走他人积分，并铸造 6V 闪光宝可梦。

### 目标

- 链码能区分“小明”和“小红”；非本人/非 system 的 `TransferPoints`、`ConfirmTrade`、`ConfirmResult`、`Dispute`、`Transfer`、`Release`、`ApplyGrowth`、`MergeStacks`、`ConsumeItem` 必须被拒绝。
- `CreateBattle` 的非 system 调用必须只能由 `playerA`/`playerB` 本人发起。
- 可选但推荐：`RegisterPlayer` 仅 `admin|system`，防止抢注 username。
- 不引入“属性缺失时回退 MSP”的后门（那等于没修）。

### 改法

1. 在 `chaincode/pokemon-cc/src/common/cid.ts` 增加：

```ts
/** CA 会在 ecert 中自动写入 hf.EnrollmentID；本项目 playerId === username === enrollmentID。 */
export function getEnrollmentId(ctx: Context): string {
  return ctx.clientIdentity.getAttributeValue('hf.EnrollmentID') ?? '';
}
```

2. 修改 `common/state.ts`：

```ts
import { getEnrollmentId, getMspId } from './cid';

export function assertCallerIsPlayer(ctx: Context, player: Player): void {
  const caller = getEnrollmentId(ctx);
  if (!caller || caller !== player.playerId) {
    fail('NOT_OWNER', `caller ${caller || '<none>'} does not match player ${player.playerId}`);
  }
}
```

> `player.playerId` 当前就是用户名；不要改成 UUID。旧记录不需要迁移，因为证书里的 `hf.EnrollmentID` 就是注册时的 username。

3. 修改 `BattleContract.CreateBattle` 的 party 检查：

```ts
if (getRole(ctx) !== 'system') {
  const caller = getEnrollmentId(ctx);
  if (caller !== playerA && caller !== playerB) {
    fail('FORBIDDEN', 'CreateBattle requires system or a battle party');
  }
}
```

4. 可选：`PlayerContract.RegisterPlayer` 增加 `requireRole(ctx, 'admin', 'system')`。后端注册用 `ADMIN_IDENTITY`（映射 system 证书），seed 也用 `ADMIN_IDENTITY`，所以业务不受影响；Mock 与测试需要同步。

5. 更新 `chaincode/pokemon-cc/tests/helpers/harness.ts`：

- 给 `identity(mspId, role, enrollmentId?)` 增加第三个参数，并把 `hf.EnrollmentID` 写入 attrs；
- 增加 `ctxAs(playerId, role = 'player')` 便捷函数；
- 所有“玩家本人”用例改用 `ctxAs(playerId)`；`system` 用例用 `identity(ORG1, 'system', 'system')`。
- 不要给缺失 `hf.EnrollmentID` 的 identity 默认填一个值；缺就拒绝，正好测试“无属性拒绝”。

6. 更新 Mock 适配器（`backend/src/fabric/mock-chain.adapter.ts`）：

- 它的身份检查本来就用 `as.userId`，比链码严格；确认 `TransferPoints`/`ConfirmTrade`/`ApplyGrowth` 等不会因为链码加严而漂移；
- 如果 Mock 中有 `as.role === 'player'` 但 `as.userId` 为空的用例，补成真实 userId。

### 必补测试（链码）

在 `tests/player.test.ts`、`trade.test.ts`、`battle.test.ts`、`pokemon.test.ts` 增加：

- A 的证书不能 `TransferPoints(A, B)` 从 B 扣款；抛 `NOT_OWNER`；
- A 不能 `ConfirmTrade(tradeId, B)`；抛 `NOT_OWNER`/`NOT_PARTY`；
- A 不能 `ConfirmResult(battleId, B)`；抛 `NOT_OWNER`；
- 无 `hf.EnrollmentID` 的玩家证书调用上述交易 → `NOT_OWNER`；
- system 证书仍可执行系统交易；
- 非 party 的玩家 `CreateBattle`（A、B 之外的 C）→ `FORBIDDEN`；
- `MintFromCapture` 的 playerId 与 event.playerId 不一致仍抛 `RAND_PLAYER_MISMATCH`（回归）。

### 验收

- 直接链码调用（用普通玩家证书）无法转他人积分/确认他人交易/改他人宝可梦。
- 三套测试全绿；真链 e2e 至少还能注册/捕捉/交易/对战（P0-4 完成后跑）。
- `docs/security.md` 的权限矩阵改为“enrollmentId 校验”，不要再写“mspId 匹配”。

### 风险

- 测试 harness 改动量大，可能一次红很多；先改 harness + 一个 `TransferPoints` 用例，跑通再批量。
- 现有链上旧玩家记录没有 `enrollmentId` 字段，但不需要迁移；不要为此加字段。
- 如果 CA 证书没有 `hf.EnrollmentID`（手工签发的特殊情况），交易会被拒绝；这是预期安全行为，文档要说明。

---

## P0-2（C2/C3）：铸造/揭示/养成权限收紧

### 现状

- `MintFromCapture`（`pokemon.contract.ts:72`）只 `loadPlayer` + `consumeRandom`，没有 `requireRole('system')`；
- `RevealAndVerify`（`random.contract.ts:60`）没有角色校验；
- `ApplyGrowth`（`pokemon.contract.ts:155`）对 owner 开放 `level/exp/evs/ivs/speciesId/name`，只校验范围，不校验成本/学习表/进化条件；
- 文档 `docs/security.md:24` 却写这些是 system 专属。

### 目标

- 只有 system 能铸造、揭示、执行养成写入；
- 玩家本人不能通过链码直接改等级/EV/IV/species；
- 后端已有的合法流程（capture/train/rename/evolve/applyExp）仍然工作；
- `learnMove` 不再免费。

### 改法

1. `PokemonContract.MintFromCapture` 第一行加：

```ts
requireRole(ctx, 'system');
```

2. `RandomContract.RevealAndVerify` 第一行加：

```ts
requireRole(ctx, 'system');
```

3. `PokemonContract.ApplyGrowth` 改为 system-only：

```ts
requireRole(ctx, 'system');
```

删除原来的 `if (getRole(ctx) !== 'system') assertCallerIsPlayer(...)` 分支。`assertIdle`、EV/IV 校验保留。

4. 后端确认所有合法调用已经是 system：

- `capture.service.ts` 的 `mintFromCapture(SYSTEM_IDENTITY, ...)` 已经是 system；
- `starter.service.ts` 已经是 system；
- `pokemon.service.ts` 的 `train`/`rename`/`evolve`/`applyExp` 已经是 `SYSTEM_IDENTITY`；
- **只有** `pokemon.service.ts:533` 的 `learnMove` 用 `as`（用户身份），必须改。

5. 处理 `learnMove`（推荐：下线免费入口）：

- 方案 A（推荐）：删除 `POST /pokemon/:id/moves/learn` 路由与前端入口；技能获取只保留升级学习表 + TM（`items.service` 的 `tm` 分支）。这样不需要新交易。
- 方案 B（保留功能）：在 `items.service` 的 TM 逻辑里消费 TM，再调用 `applyGrowth(SYSTEM_IDENTITY, ...)`；`pokemon.service.learnMove` 不再直接暴露，或改为“校验 TM 后由 system 调用”。
- 无论哪种，链码 `ApplyGrowth` 都不再接受玩家证书，所以免费学技能路径被堵死。

6. 更新 Mock：`MockChainAdapter.mintFromCapture`/`revealAndVerify`/`applyGrowth` 加 `as.role === 'system'` 检查；`learnMove` 相关测试改为 TM 或删除。

7. 文档：`docs/chaincode-api.md` 的 `MintFromCapture`/`RevealAndVerify`/`ApplyGrowth` 权限列改为 system；`docs/security.md` 同步；`AGENTS.md` 决策 5/10 补一句“链上养成写入仅 system”。

### 必补测试

- 玩家证书调用 `MintFromCapture` → `FORBIDDEN`；
- 玩家证书调用 `RevealAndVerify` → `FORBIDDEN`；
- owner 调用 `ApplyGrowth` 改 level/EV/IV/species → `FORBIDDEN`；
- system 调用上述三个 → 成功；
- 后端 capture/starter/train/rename/evolve 仍然成功（现有测试覆盖）；
- `learnMove` 若删除，补一个 404/410 测试；若保留，补“无 TM 拒绝、有 TM 扣除”测试。

### 验收

- 评审中的“普通玩家证书铸造 6V 超梦/改 100 级”攻击失败。
- 三套测试全绿；`docs/chaincode-api.md`/`docs/security.md` 与代码一致。

### 注意

这一步只是“权限收紧”，链码仍然信任后端传入的 IV/EV/level。要让链上真正校验游戏规则，见 P2-2/后续“从 resultHash 派生/成本校验”；不要在 P0 里做半套。

---

## P0-3（C5）：交易只锁发起方资产，并给 TTL 上限

### 现状

`TradeContract.CreateTrade` 在创建时对 `offer` 和 `request` 双方资产都做 `LOCKED_TRADE`（`trade.contract.ts:150-180`）。任何用户知道对方资产 id 后，可以创建“请求对方资产”的交易，直接锁住对方资产；`ttlSeconds` 只有 `@Min(10)`，没有上限。

### 目标

- 创建交易只锁 `fromId` 的 `offer`；
- `request` 资产在创建时只做“存在/归属/IDLE”预检，不锁定；接收方仍可自由使用/转移；
- 双方确认后，在 `executeTrade` 的同一交易内校验并转移 `request`；若已被锁/转走，整体回滚，交易保持 OPEN；
- 取消/过期时解锁双方（兼容旧交易，旧交易的 request 可能仍是 LOCKED_TRADE）；
- 后端 `ttlSeconds` 加 `@Max(7*24*3600)`（7 天），并在文档写明。

### 改法

1. `CreateTrade`：

```ts
const offerAssets = await validateBundleAssets(ctx, offer, fromId, 'offer');
// 只预检 request，不锁定
await validateBundleAssets(ctx, request, toId, 'request');

for (const p of offerAssets.pokemons) {
  p.status = 'LOCKED_TRADE';
  p.lockRef = id;
  await savePokemon(ctx, p);
}
for (const i of offerAssets.items) {
  i.status = 'LOCKED_TRADE';
  i.lockRef = id;
  await saveItem(ctx, i);
}
```

2. `executeTrade` 对 request 的处理要兼容两种状态：

```ts
for (const pid of trade.request.pokemonIds) {
  const p = await loadPokemon(ctx, pid);
  const lockedByThis = p.status === 'LOCKED_TRADE' && p.lockRef === trade.id;
  if (!lockedByThis && p.status !== 'IDLE') {
    fail('ASSET_LOCKED', `pokemon ${pid} is ${p.status}`);
  }
  if (p.ownerId !== trade.toId) {
    fail('NOT_OWNER', `pokemon ${pid} is not owned by ${trade.toId}`);
  }
  if (p.ownerId !== trade.fromId) p.bond = BOND_RESET_ON_TRANSFER;
  p.ownerId = trade.fromId;
  p.status = 'IDLE';
  p.lockRef = '';
  await savePokemon(ctx, p);
}
```

items 同理：允许 `LOCKED_TRADE`（lockRef 本单）或 `IDLE`，owner 必须是 `toId`。

3. `unlockTradeAssets` 保持“双方都解锁”：

- 新交易 request 没锁，遍历时 `status !== LOCKED_TRADE` 自动跳过；
- 旧交易 request 仍锁着，能解锁；
- 不要只解锁 offer，否则旧交易会留下锁。

4. 后端 `trades/dto/trades.dto.ts`：

```ts
@IsInt()
@Min(10)
@Max(7 * 24 * 3600)
ttlSeconds: number;
```

5. 可选链码 TTL 上限：如果担心直接调用链码传超长 `expiresAt`，在 `CreateTrade` 用 `Date.parse(expiresAt) - Date.parse(nowISO) <= 7d` 校验。`Date.parse` 对 ISO 字符串是确定性的；不要用 `Date.now()`。如果不想引入时间解析，至少保证 DTO 上限，并在文档注明“链码仍信任调用方时间”。

### 必补测试

- A 创建“request = B 的宝可梦”的交易后，B 的宝可梦仍是 `IDLE`；B 可以立即转移/使用；
- A 取消后，A 的 offer 解锁；B 的资产从未被锁；
- 双方确认时，如果 B 的 request 已被转走/锁定，`executeTrade` 抛 `NOT_OWNER`/`ASSET_LOCKED`，A 的 offer 仍锁定、交易仍 OPEN（或按你的设计取消），不会半结算；
- 旧格式交易（request 已 LOCKED_TRADE）仍可执行/取消/过期；
- `ttlSeconds` 超过 7 天 → 400。

### 验收

- 评审中的“普通 API 锁住受害者资产”不再成立；
- 结合 C1，攻击者也不能替受害者确认；
- 交易双确认/取消/过期/旧交易回归全绿。

---

## P0-4（C4）：真链的 4 个部署阻塞

> 这是“能不能验收真链”的关键。不要只改代码不验证；每一步都要用 `peer`/`curl` 确认。

### C4a：CA 注册 `hf.EnrollmentID` 被 403

改 `backend/src/fabric/fabric-ca.service.ts`：

```ts
attrs: [{ name: 'role', value: role, ecert: true }],
```

删除 `hf.EnrollmentID` 那一行。Fabric CA 会自动把 `hf.EnrollmentID` 写进 ecert；P0-1 正是读它。

补一个后端单测（mock `FabricCAServices` 或抽一个 `buildRegistrationRequest` 纯函数）断言 attrs 不含 `hf.EnrollmentID`。

### C4b：CA TLS 路径指向叶子证书

把以下三处改为组织 CA 根证书：

```ini
FABRIC_CA_TLS_CERT_PATH=../network/organizations/peerOrganizations/org1.pokechain.com/ca/ca.org1.pokechain.com-cert.pem
```

- `backend/.env.example`
- `docker-compose.yaml` 的 `FABRIC_CA_TLS_CERT_PATH`
- `docs/deployment.md` §4.4（以及手工 enroll 命令的 `CA_TLS`）

如果容器内路径不同，用 `/network/organizations/peerOrganizations/org1.pokechain.com/ca/ca.org1.pokechain.com-cert.pem`。不要再用 `fabric-ca/org1/tls-cert.pem`（它是 CA 的 TLS 叶子，Node 会报 `unable to verify the first certificate`）。

### C4c：system 身份没有自动创建/挂载

推荐把 enroll 做成**一次性脚本**，而不是容器启动时写文件：后端镜像以 `USER app` 运行，宿主目录 UID/权限容易不匹配；脚本在宿主机跑，容器只读挂载最稳。

1. 新增 `scripts/enroll-system.sh`（幂等）：

```bash
#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"

CERT_DIR="${ROOT_DIR}/backend/.fabric-certs"
if [[ -f "${CERT_DIR}/system-cert.pem" && -f "${CERT_DIR}/system-key.pem" ]]; then
  infoln "system 身份已存在，跳过 enroll"
  exit 0
fi

SECRET="${FABRIC_SYSTEM_SECRET:-systempw}"
CA_TLS="${NETWORK_DIR}/organizations/peerOrganizations/org1.pokechain.com/ca/ca.org1.pokechain.com-cert.pem"
mkdir -p "${CERT_DIR}"

cd "${NETWORK_DIR}"
export FABRIC_CA_CLIENT_HOME="${CERT_DIR}/ca-admin"
bin/fabric-ca-client enroll -u https://admin:adminpw@localhost:7054 \
  --caname ca.org1.pokechain.com --tls.certfiles "${CA_TLS}"

# 已注册时会返回 "identity already registered"；脚本应提示后继续尝试 enroll
bin/fabric-ca-client register --id.name system --id.secret "${SECRET}" \
  --id.attrs "role=system:ecert" --caname ca.org1.pokechain.com \
  --tls.certfiles "${CA_TLS}" -u https://localhost:7054 || true

export FABRIC_CA_CLIENT_HOME="${CERT_DIR}/ca-system"
bin/fabric-ca-client enroll -u "https://system:${SECRET}@localhost:7054" \
  --caname ca.org1.pokechain.com --tls.certfiles "${CA_TLS}"

cp "${FABRIC_CA_CLIENT_HOME}/msp/signcerts/cert.pem" "${CERT_DIR}/system-cert.pem"
cp "${FABRIC_CA_CLIENT_HOME}"/msp/keystore/*_sk "${CERT_DIR}/system-key.pem"
chmod 600 "${CERT_DIR}/system-key.pem"
```

注意：`register ... || true` 只适用于“已注册、secret 未变”的场景；如果对方已注册但 secret 不同，enroll 会 401，脚本应打印“设置 `FABRIC_SYSTEM_SECRET` 或手工 enroll”并 exit 1，不要静默继续。

2. 在 `scripts/up.sh` 末尾（或 root compose 的真链启动说明里）调用 `./scripts/enroll-system.sh`；容器只读挂载。

3. 根 `docker-compose.yaml` 的 `[real-fabric]` 段增加：

```yaml
volumes:
  - ./network/organizations:/network/organizations:ro
  - ./backend/.fabric-certs:/app/.fabric-certs:ro
environment:
  FABRIC_CERT_STORE_DIR: /app/.fabric-certs
```

4. 可选：保留 `FabricCaService.ensureSystemIdentity()` 供本地非容器路径；如果一定要在容器内自动 enroll，mount 必须可写且容器 UID 可写，不推荐作为默认路径。

5. `docs/deployment.md` §4.4 保留手工方案作为 fallback；在 `docs/setup.md` 增加“真链首次启动”步骤。

### C4d：链码安装/运行链路

当前仓库是“node 包 + ccaas external builder”混用：`deployCC.sh:40` 打 node 包，`network/config/core.yaml:602-606` 只配置 ccaas builder；本机 Docker 29 下 node 包 Docker build 失败。二选一，**推荐 A**：

**方案 A（推荐，简单）：恢复默认 Docker builder，固定 Docker 版本**

- 删除/注释 `network/config/core.yaml` 的 `externalBuilders` 段（或至少不要让 ccaas 成为唯一 builder）；
- `scripts/prereq.sh` 增加 Docker 版本检查：Fabric 2.5 建议 Docker 24/25/26；Docker 28/29 可能报 `write unix @->/run/docker.sock: broken pipe`；
- `scripts/deployCC.sh` 的 `CC_VERSION`/`CC_SEQUENCE` 改成可覆盖：

```bash
CC_VERSION="${CC_VERSION:-1.0}"
CC_SEQUENCE="${CC_SEQUENCE:-1}"
```

- 如果已提交的包不对，用 `CC_VERSION=1.1 CC_SEQUENCE=2 ./scripts/deployCC.sh`；幂等检查同时确认 `querycommitted.version/sequence` 与期望一致，不要只看 version/sequence 相同就跳过（当前会因为错误的 ccaas 包而被跳过）。

**方案 B（fallback）：ccaas 服务**

如果必须用 Docker 29/无法恢复 builder：

- 准备 `connection.json`：`{"address":"pokechain-cc:19999","dial_timeout":"10s","tls_required":false}`；
- 打包 ccaas（`metadata.json` type=ccaas + `code.tar.gz`）；
- 在 `network/docker-compose.yaml` 增加 `pokechain-cc` 服务：Node 20 镜像、挂载 `chaincode/pokemon-cc`、运行 `ChaincodeServer`（`fabric-shim` 的 `Bootstrap.register(..., {ccid,address}, true)`）；
- 用 `peer lifecycle chaincode install/approve/commit` 部署；`deployCC.sh` 支持 `CC_LANG=ccaas`/`CC_PACKAGE`；
- 该服务必须在 `pokechain_net` 内，且地址与 `connection.json` 一致。

> 评审已验证方案 B 可让真链 25/25；但它需要额外容器，课程演示前要把它纳入 compose/文档，否则“一键真链”仍然不成立。

### C4 验收

1. `peer lifecycle chaincode querycommitted -C gamechannel -n pokemoncc --output json` 显示期望的 sequence/version，Org1/Org2 approvals 都为 true。
2. `peer chaincode query -C gamechannel -n pokemoncc -c '{"Args":["PlayerContract:GetPlayer","<已注册用户>"]}'` 返回 200/JSON。
3. `FABRIC_MOCK=false` 启动后端，注册新用户成功（CA 不再 403/TLS 错误）。
4. `BASE_URL=http://localhost:3100 ./scripts/e2e-smoke.sh` **25/25**。
5. `peer channel getinfo -c gamechannel` 高度增长，账本能查到 `Player`/`Trade`/`Battle`。
6. 新增 `scripts/real-chain-smoke.sh`：先检查 `querycommitted` + `GetPlayer`，再调用 e2e；避免“链码没起来但 e2e 误报”。

### 风险

- 真链升级要 `sequence++`，旧 ledger/旧包保留；不要 `down -v` 清库，除非确认。
- 改 CA 路径/属性后，旧的用户证书仍然有效；但新注册用户才会带新属性。
- 如果 Docker 版本无法改，方案 B 的链码服务容器必须和 Fabric 网络同一网络；`172.22.0.1` 在评审环境不可达（宿主防火墙），不要再用宿主端口。

---

## P0-5（C6）：`Forfeit` 写入 winner/result

### 改法

`BattleContract.Forfeit`（`battle.contract.ts:377-394`）在 `settle` 前补：

```ts
battle.result.winnerId = winnerId;
if (!battle.result.serverSubmitted) {
  battle.result.resultHash = sha256hex(`forfeit|${battle.id}|${loserId}|${reason}`);
  battle.result.serverSubmitted = true;
}
await settle(ctx, battle, winnerId, nowISO);
```

保留 `status='SETTLED'`、`arbiterNote`、`BattleSettled` 事件。

### 测试

- `tests/battle.test.ts` 增加：`Forfeit` 后 `result.winnerId === 对方`、`serverSubmitted === true`、`resultHash` 64 hex；
- `Forfeit` 在 `RESULT_SUBMITTED` 状态调用时，不覆盖已有 `serverSig`/`resultHash`，只补 winner；
- Mock 已写 winner，回归确认不重复。

### 验收

- 真链 e2e 第 10 步通过；`battle.result.winnerId` 与积分归属一致。
- `docs/chaincode-api.md` 的 `Forfeit` 行补“写入 result.winnerId/resultHash”。

---

## P0-6（H1/H2）：宝可梦详情 BOLA + 队伍去重

### H1：`GET /pokemon/:id` 归属校验

现状：`backend/src/pokemon/pokemon.controller.ts:35` 直接 `getOne(id)`，`pokemon.service.ts:192` 只读链，不校验 owner。评审实测 B 能读 A 的 IV/EV/性格。

改法（最简单）：

```ts
@Get('pokemon/:id')
getOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
  return this.pokemon.getOneForUser(id, user.username);
}
```

`getOneForUser`：

```ts
async getOneForUser(id: string, requester: string): Promise<PokemonView> {
  const base = withComputedStats(await this.contract.getPokemon(id));
  if (base.ownerId !== requester) {
    throw new AppException('NOT_FOUND', `pokemon ${id} does not exist`, HttpStatus.NOT_FOUND);
  }
  base.renameCount = await this.renameCountOf(id);
  return this.withHp(base);
}
```

如果产品需要“看别人宝可梦”，返回 **sanitized public view**（id/name/speciesId/level/shiny/ownerId，不含 IV/EV/nature/stats），不要直接返回链上完整对象。前端若已有“他人资料页”，改用 public view。

测试：
- A 读自己的 → 200 且含 IV/EV；
- B 读 A 的 → 404（或 200 但无 IV/EV，按你选的方案）；
- 未登录 → 401。

### H2：队伍去重

`battles.service.ts:683-700` 的 `assertTeamOwnership` 只查长度和 owner，不查重复。加：

```ts
export function assertTeamUnique(pokemonIds: string[]): void {
  if (new Set(pokemonIds).size !== pokemonIds.length) {
    throw new AppException('DUPLICATE_TEAM', 'teamPokemonIds must not contain duplicates', HttpStatus.BAD_REQUEST);
  }
}
```

在 `assertTeamOwnership` 开头调用。`ranked.service.ts` 的 `assertTeam` 也复用（它现在只 `new Set` 做长度？确认后统一）。前端 `RankedView`/`WagerPicker` 最好也去重提示，但后端是权威。

测试：
- 6 个相同 id 创建房间 → 400 `DUPLICATE_TEAM`；
- 加入房间/确认押注同样拒绝；
- 正常 1-6 只不同 id 通过。

### 验收

- 评审中的 BOLA/6 条命攻击不再成立；
- 房间/排位现有测试全绿。

---

## 3. P1 工作包

## P1-1（H3/H4）：PvP 经验 + 排行榜事件

### H3：PvP 0 经验

`battle-reward.service.ts` 只在 `rankedRecord.bot` 分支调用 `grantBotWinExp`（`:145-147`）。普通 PvP（排位/房间）没有经验。

改法：在 `settle` 里，拿到 `winnerId`、`teamA/teamB` 后：

```ts
if (!rankedRecord?.bot) {
  const winnerTeam = winnerId === playerA ? teamA : winnerId === playerB ? teamB : [];
  if (winnerTeam.length > 0) {
    await this.pokemon.grantBattleWinExp(winnerId, winnerTeam, battleId, BATTLE_WIN_EXP_GAIN);
  }
}
```

放在 `bonds.grantPvpBond` 之后、`if (rankedRecord)` 之前或之后，确保 room battle 也有 `teamA/teamB`（`onSettled` 已从 `BattleSettledEvent` 存了 pending.teamA/B）。`grantBattleWinExp` 已用 `<battleId>-exp-<pokemonId>` 幂等键，重放不叠加。

测试：
- 普通排位胜利 → 胜者队伍每只 +30 exp；
- 房间胜利 → 同上；
- 机器人场仍是 +15（不能变成 +30/+45）；
- DRAW/REFUND → 0；
- 重复 sweep 不重复加。

### H4：排行榜真链不刷新

链上 `BattleSettled` 只有 `{id,winnerId}`（`battle.contract.ts:351`），`settle` 也不发 `PointsChanged`；`leaderboard.controller.ts:19-24` 只读 `playerId/playerA/playerB`。

改法（推荐一起做）：

1. 链码 `settle` 在 `savePlayer` 后，为双方 emit：

```ts
emit(ctx, 'PointsChanged', {
  playerId: a.playerId, delta: 0, balance: a.points, reason: `battle:${battle.id}`,
});
emit(ctx, 'PointsChanged', {
  playerId: b.playerId, delta: 0, balance: b.points, reason: `battle:${battle.id}`,
});
```

> delta 可以按结算前后差额计算（DRAW/REFUND 为 0）；如果不想算，balance 足够让排行榜刷新。

2. 所有 `BattleSettled` emit 补 `playerA: battle.playerA, playerB: battle.playerB`。
3. `LeaderboardController` 的 ids 数组加 `payload.winnerId`、`payload.fromId`、`payload.toId`，覆盖交易/结算事件。
4. Mock 适配器同步：`BattleSettled` 已带 playerA/B；补 `PointsChanged`（如果 Mock 没有）。

测试：
- 链码事件 payload 断言（battle.test.ts）；
- 后端 leaderboard：模拟 `PointsChanged`/`BattleSettled`，ZSET 分数更新；
- 真链 e2e 后 `GET /leaderboard` 能看到赢家新分数（手工验证即可）。

---

## P1-2（H5）：房间启动失败补偿

### 现状

`battles.service.ts:505-518`：`createBattle` → `activateBattle` → `startBattle` → 最后才写 `room.battleId`。任何一步失败，链上已锁资产，本地无 battleId，`reconcileRoom` 对 `!room.battleId` 直接 return false → 永久冻结。

### 改法

1. 在链上调用前生成 `battleId`，先写房间：

```ts
const battleId = `b_${randomUUID()}`;
room.battleId = battleId;
room.status = 'STARTING';
await this.saveRoom(room);
```

2. `try/catch` 包住 `createBattle/activateBattle/startBattle`：

- `createBattle` 失败：链上没锁（或已回滚），把 room 恢复 `JOINED`，清 `battleId`，抛错；
- `createBattle` 成功但 `activateBattle`/`startBattle` 失败：
  - 如果链上还是 `CREATED`，调用新增的 `CancelBattle`（见下）退款/解锁；
  - 如果已 `ACTIVE`，调用 `forfeitBattle(SYSTEM_IDENTITY, battleId, room.playerB, 'start-failed')` 结算；
  - 把 room 置 `FAILED`，清定时器，记录日志；`reconcileRoom` 能处理。
3. 新增链码 `BattleContract.CancelBattle`（system only，CREATED）：复用 `settle(ctx, battle, 'REFUND', nowISO)`，`status='REFUNDED'`，emit `BattleSettled`/`BattleRefunded`。这是 H5 的关键；没有它，`CREATED` 状态无法退款。
4. `reconcileRoom` 增加 `STARTING`：有 battleId 就按链上状态取消/结算；无 battleId 且超时才关房。

测试：
- mock `startBattle` 抛错 → 链上 battle 被取消/退款，资产 IDLE，房间 FAILED；
- `createBattle` 抛错 → room 回 JOINED，无 battleId；
- `reconcileRoom` 对 STARTING 的处理。

> 这个工作包需要同时改链码、Mock、后端、测试，建议单独一个 commit，不要和 P1-1 混。

---

## P1-3（H6/H7）：免费学技能 + 锁定资产先消耗

### H6：免费学技能

按 P0-2 的方案 A，删除 `POST /pokemon/:id/moves/learn` 与前端入口；技能只通过升级学习表 + TM。若保留，必须：

- 校验目标宝可梦 `IDLE`、本人所有；
- 消耗 `tm` 道具（`items.service` 已有 TM 逻辑）；
- 校验 `teachesMove` 与学习表；
- 用 `SYSTEM_IDENTITY` 调 `applyGrowth`，幂等键 `<itemId>-tm-<pokemonId>`。

### H7：锁定资产先消耗

`items.service.ts` 的 `mustOwnPokemon` 只校验 owner，不校验 `status`；`pokemon.service.mustOwn` 同理。加：

```ts
if (pokemon.status !== 'IDLE') {
  throw new AppException('ASSET_LOCKED', `pokemon ${pokemon.id} is ${pokemon.status}`, HttpStatus.CONFLICT);
}
```

在**消耗道具/扣积分之前**调用。涉及：药水、进化石、TM、糖果、王冠、训练、改名（改名是否允许锁定？链码 `ApplyGrowth` 要求 IDLE，所以后端也应拒绝）、放生、学技能。

测试：
- 宝可梦在 `LOCKED_TRADE`/`LOCKED_BATTLE` 时使用药水/训练/糖果 → 409，且道具/积分未扣；
- 解锁后恢复可用。

---

## P1-4（H8）：链上错误码 → HTTP

### 现状

`all-exceptions.filter.ts` 只处理 `HttpException`；链码 `CodedError` 没有 status，统一 500。`train` 积分不足实测 500，文档写 400/409。

### 改法

1. 在 `backend/src/common/utils/errors.ts` 或新文件定义映射：

```ts
export const CHAIN_HTTP_STATUS: Record<string, HttpStatus> = {
  NOT_OWNER: HttpStatus.FORBIDDEN,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  ASSET_LOCKED: HttpStatus.CONFLICT,
  INSUFFICIENT_POINTS: HttpStatus.BAD_REQUEST,
  INSUFFICIENT_QUANTITY: HttpStatus.BAD_REQUEST,
  INVALID_PARAM: HttpStatus.BAD_REQUEST,
  BAD_STATE: HttpStatus.CONFLICT,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  ...
};
```

2. `FabricChainAdapter.unwrap` 或 filter 里，如果异常有 `code` 且映射命中，设置 status；否则保持 500。
3. 加后端测试：`train` 积分不足 → 400/409；BOLA → 404；重复队伍 → 400；链码 `ASSET_LOCKED` → 409。
4. 文档 `docs/backend-api.md` 的错误码表同步。

---

## P1-5（H9）：首球 reveal 改为结算后 reveal

### 现状

`capture.service.ts:235-241` 与 `wild.service.ts:321-327` 在第一次投球时 `RevealAndVerify`；`/fairness` 是 `@Public`，返回 `serverSeed`。玩家可在第一次投球后计算后续投球/AI/IV/闪光。

### 改法（推荐）

- **快速捕捉**：不在第一次 attempt reveal；成功时、`MintFromCapture` 之前 reveal（链上要求 REVEALED）；如果所有 attempt 失败/会话放弃，在 finalize/超时时 reveal 用于审计。
- **野怪战斗**：不在第一次投球 reveal；在战斗终态（CAUGHT/WILD_FAINTED/FLED/TIMEOUT）时 reveal；如果 CAUGHT，先 reveal 再 mint。
- `/fairness` 对 `COMMITTED` 事件只返回 commitHash/clientSeed/meta，不返回 serverSeed；前端显示“结算后揭示”。
- 增加 `revealOnFinalize` 的幂等键 `<eventId>-reveal`；不会重复 reveal。
- 超时/放弃的会话要有定时清理，避免永久 COMMITTED；`CAPTURE_SESSION_TTL_SEC` 到期时 reveal 或标记过期。

测试：
- 第一次失败后，链上仍 `COMMITTED`，`/fairness` 不含 serverSeed；
- 成功后 `REVEALED`→`CONSUMED`，`/fairness` 可复核；
- 野怪战斗结束后才 reveal；
- 重复 finalize 不重复 reveal。

> 这个改动会影响“实时公平性页面”的展示与 e2e（e2e 在结算后查 fairness，应该仍然通过）；先改后端 + 测试，再改前端文案。

---

## P1-6（H14-H17）：前端四个 High

### H14：交易确认用 username

`frontend/src/views/TradeView.vue:102`：

```ts
const me = auth.user?.id; // UUID
return trade.fromId === me ? trade.confirmations.from : trade.confirmations.to;
```

改为 `auth.user?.username`。补一个 vitest：`fromId` 为 username 时，sender 在对方确认后仍显示“确认”按钮/正确状态。

### H15：战斗刷新后没有 turn

`battle.gateway.ts:139` 的 `onJoin` 只发 `battle:state`，不发 `battle:turn`。两种改法：

- 推荐：`onJoin` 在 `battle:state` 后补发当前 `turn` + `deadline`（如果引擎有 pending turn），或让 `publicState()` 带 `turn`；
- 前端 `BattleView` 的 `isMyTurn` 在 `turn` 为空时，从 `state` 里恢复/等待；不要在刷新后直接禁用 30s。

补后端 WS 测试（或 at least 单元测试 `onJoin` payload）与前端 store 测试。

### H16：Socket 重连取新 token

`BattleSocket.ts:21` 固定 `auth: { token: auth.accessToken }`。改为：

```ts
auth: (cb) => cb({ token: useAuthStore().accessToken }),
```

并加 `connect_error` 处理：提示“登录已过期”，停止重连/离开战斗。补 vitest（mock socket.io-client）。

### H17：启动 refresh 无超时

`frontend/src/api/http.ts:19` 裸 `axios.post` 没有 timeout；`stores/auth.ts:41` 守卫 await。改为：

```ts
axios.post(`${API_BASE}/auth/refresh`, { refreshToken }, { timeout: 5000 });
```

`refreshAccessToken` 失败时清 session 并放行到登录页；App.vue 的 loading 要有兜底（超时/错误）。补测试。

### 验收

- 战斗中刷新/断线重连能继续出招；
- access 过期后重连不被永久卡住；
- 发送方在对方先确认后仍能确认；
- 首屏 refresh 挂起不会全站卡死。

---

## P1-7（H19）：`SERVER_SIGNING_KEY` 持久化

`SigningService` 在空值时生成临时密钥；重启后 `/fairness` 返回新公钥，旧 `serverSig` 无法验证。

改法：
- `docker-compose.yaml` 增加 `SERVER_SIGNING_KEY: ${SERVER_SIGNING_KEY:-}`；
- `.env.example` 说明“生产必须设置 secp256k1 PKCS8 PEM；空值仅本地演示”；
- 生产/真链启动时，如果 `NODE_ENV=production` 且为空，至少 `logger.warn` 或 fail-fast（按课程演示选择）；
- `/fairness` 返回 `serverKeyId`（密钥指纹）并存到战斗记录，便于换钥后验证；
- 补 `SigningService.verifyResultHash` 测试（已有，确认）。

---

## 4. P2 工作包（时间不够可只做 P2-1 的 1-2 项）

## P2-1（H10-H13）：经济重平衡

> 这是**产品数值**改动，必须和 `scripts/e2e-smoke.sh`、`docs/backend-api.md`、`AGENTS.md` 一起改；不要和 P0 安全修复合在一个 commit。

### H10：注册积分/多开

推荐：`PlayerContract.INITIAL_POINTS` 1000 → **400**，并加 72h 转账锁：

- 链码 `Player` 增加 `transferLockUntil`（注册时 = nowISO + 72h；旧记录缺省 `''` 视为无锁）；
- `TransferPoints`/`CreateTrade` 的 points 检查：`nowISO < transferLockUntil` → `TRANSFER_LOCKED`；
- 或者后端用 `users.createdAt` 做 72h 限制（更简单，但不是链上权威）；
- e2e 预期值全部改：A 400→420→470→510；B 600→550→530；交易改成“宝可梦换 0P”或使用已过锁的 seed 账号。

如果不想破坏演示，可先只做“400P + 每日转账上限”，把 72h 锁留到下一批。

### H11：传说钥匙

- 进入传说区/创建传说遭遇时消耗钥匙（`consumeItem`，reason `legendary-key`，幂等键 `<zone>-<player>-<date>` 或 `<sessionId>`）；
- 每把钥匙一次遭遇；击倒/逃跑后钥匙不返还；
- 传说区击倒积分降为 0 或每日上限；
- 保留“每人每池一只”的已拥有检查。

### H12：竞技场/机器人

- 机器人场 rating 增益降为 0（或 ≤2），避免 20 天零风险到大师；
- 竞技场补贴改为“同段位 + 当日胜场<3 + 固定奖池”，或补贴只来自入场费，不增发；
- 双开检测（同 IP/设备/交易关系）作为 P3，不强制。

### H13：大师球/金冠/TM

- 大师球：加一个玩家可达的奖励（传说图鉴 6/6、赛季前 10、或首次通关），不要只靠 admin/seed；
- 金冠 15000 → 6000-8000；银冠 3000 → 1200-1500；
- TM 1500 → 800，或改为可重复使用；确保 `teachesMove` 对目标物种有实际提升；
- 更新 `shop.data.ts`、`shop` 测试、`docs/backend-api.md` 价目表、前端商店文案。

### 验收

- e2e 的积分断言与新初始值一致；
- 30 天模拟不再出现“工作室 78 万积分无处花”；
- 关键目标时间：高级球 1-2 天（休闲）、金冠 20-30 天（活跃）、大师球 1 个/赛季。

---

## P2-2：架构与双链一致性

### 1）链码 ↔ Mock 对拍（最高优先）

新增 `test-vectors/chain/*.json`：

```json
{
  "name": "transfer_points_non_owner",
  "tx": "PlayerContract:TransferPoints",
  "identity": { "mspId": "Org1MSP", "role": "player", "enrollmentId": "alice" },
  "args": ["bob", "alice", "10", "2026-01-01T00:00:00.000Z", "idem-1"],
  "expect": { "ok": false, "code": "NOT_OWNER" }
}
```

- 链码 Jest 用 harness 跑这些向量；
- 后端 Jest 用 `MockChainAdapter` 跑同一批向量；
- 断言同一 `code`/状态，防止再次漂移。
- 至少覆盖：身份、锁定、双花、幂等、Forfeit、交易部分数量、押注拆分、错误码。

### 2）事件类型

`chain.types.ts` 增加 `ChainEventMap` 判别联合；`ChainAdapter.onChainEvent` 泛型化；`ChainEventsService` 用 map；两个适配器共用 payload 类型。先做 `PointsChanged`/`BattleSettled`/`ItemMerged` 三个。

### 3）`@Global` 与模块边界

- `FabricModule` 去 `@Global`，只导出 `ChainAdapter`/`ContractService`；更新 25 个注入点；
- 抽 `BondModule`（`BondService`+`bond.ts`），Wild 不再 import `RankedModule`；
- 抽 `pokemon/team-eligibility.ts`（`assertTeamSize`/`assertTeamOwnership`/`assertTeamUnique`），Battles/Ranked 共用；
- `LeaderboardController` 抽 `LeaderboardService`；`assets.controller` 的 AuditLog 抽 `AuditService`。

### 4）前端数据去重

- `frontend/src/stores/zone.ts` 改为从 `GET /capture/zones` 拉取，删除本地 14 区副本；
- `wild-battle.ts` 的球倍率/捕捉公式改为后端返回或共享常量；
- `frontend/src/types.ts` 用 OpenAPI/共享包生成，至少加一个“字段漂移”测试。

---

## P2-3：前端边角/管理身份

- `H18`：`crypto.randomUUID` fallback：

```ts
const nonce = crypto.randomUUID?.() ??
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
```

- `H20`：真链 admin 身份：要么单独 enroll `admin`（role=admin）并让 `ADMIN_IDENTITY` 使用它；要么放宽 `GrantRole` 为 `admin|system` 并在文档声明“课程简化”。推荐前者。
- 多标签页 refresh 竞态：`BroadcastChannel`/localStorage 锁；长期方案 httpOnly Cookie。
- 登出清 KeepAlive/GameView 缓存；按 username key 重建。
- 移动端触控方向键；公平性页第三项改为真实复算 + 验签。

---

## 5. 测试与验收

### 5.1 每个工作包必跑

```bash
(cd chaincode/pokemon-cc && npm test && npm run build)
(cd backend && npm run build && npm test)
(cd frontend && npm run build && npm test)
python3 -m unittest discover -s frontend/tools -p 'test_*.py'   # 如改世界素材
```

### 5.2 安全回归（新增脚本或 Jest）

建议新增 `scripts/security-regression.sh`，至少检查：

- 普通用户 A 不能 `GET /pokemon/:id` 读 B 的 IV/EV；
- 6 个相同 id 创建房间 → 400；
- A 创建“request=B 的宝可梦”的交易后，B 的宝可梦仍 `IDLE`；
- PvP 胜利后胜者队伍 exp +30；
- Forfeit 后 `battle.result.winnerId` 非空；
- 直接链码：玩家证书调用 `MintFromCapture`/`RevealAndVerify`/`ApplyGrowth`/`TransferPoints`（他人）全部失败。

### 5.3 真链验收

```bash
# 1) 网络
./scripts/up.sh
CC_VERSION=1.1 CC_SEQUENCE=2 ./scripts/deployCC.sh   # 或你修好的默认脚本

# 2) 链码可调用
peer lifecycle chaincode querycommitted -C gamechannel -n pokemoncc --output json
peer chaincode query -C gamechannel -n pokemoncc \
  -c '{"Args":["PlayerContract:GetPlayer","<user>"]}'

# 3) 后端
cd backend && npm run build
PORT=3100 FABRIC_MOCK=false MINIO_MOCK=true \
  DATABASE_URL=postgres://pokechain:pokechain@localhost:5432/pokechain \
  REDIS_URL=redis://localhost:6379 JWT_SECRET=... CERT_ENC_KEY=... \
  FABRIC_PEER_ENDPOINT=localhost:7051 FABRIC_PEER_HOST_ALIAS=peer0.org1.pokechain.com \
  FABRIC_PEER_TLS_CERT_PATH=$PWD/../network/organizations/peerOrganizations/org1.pokechain.com/peers/peer0.org1.pokechain.com/tls/ca.crt \
  FABRIC_CA_URL=https://localhost:7054 FABRIC_CA_NAME=ca.org1.pokechain.com \
  FABRIC_CA_TLS_CERT_PATH=$PWD/../network/organizations/peerOrganizations/org1.pokechain.com/ca/ca.org1.pokechain.com-cert.pem \
  FABRIC_CERT_STORE_DIR=$PWD/.fabric-certs node dist/main.js

# 4) e2e
BASE_URL=http://localhost:3100 ./scripts/e2e-smoke.sh
```

期望：`SMOKE PASS — 25 项断言全部通过`；账本高度增长；`GetPlayer`/`GetBattle` 可查。

### 5.4 Definition of Done

- [ ] P0-1 ~ P0-6 全部完成，负向测试覆盖。
- [ ] 三套测试全绿；测试计数更新到 `AGENTS.md`（不要照抄旧值）。
- [ ] Mock e2e 25/25；真链 e2e 25/25。
- [ ] `docs/chaincode-api.md`/`backend-api.md`/`security.md`/`deployment.md`/`architecture.md` 与代码一致。
- [ ] `AGENTS.md` 的决策 5/6/9/10/11、命令、测试计数已更新。
- [ ] 无 `CERT_ENC_KEY`/私钥/serverSeed 日志；无临时证书/账本文件进入 git。
- [ ] `git status` 干净；每个 commit 可单独回滚。

---

## 6. 提交顺序建议

```text
fix(chaincode): 以 hf.EnrollmentID 校验玩家身份
fix(chaincode): 收紧铸造/揭示/养成权限
fix(chaincode): 交易仅锁发起方资产
fix(chaincode): 认输结算记录赢家
fix(backend): 修复宝可梦详情越权与队伍重复
fix(backend): 真链 CA 证书与 system 身份引导
fix(backend): 修复真链链码部署与冒烟
fix(backend): PvP 经验与排行榜事件
fix(backend): 房间启动失败补偿与错误映射
fix(frontend): 修复交易确认/战斗重连/刷新
test(chaincode): 增补权限/状态机/对拍用例
docs: 更新 AGENTS 与部署/契约文档
```

每个 commit 前跑对应测试；不要把所有 P0 塞进一个 commit。

---

## 7. 兼容、回滚与部署注意

- **链码升级**：用 `CC_VERSION`/`CC_SEQUENCE` 递增；保留旧包，不要 `down -v`。升级前备份账本/通道配置。
- **旧交易**：C5 只改变“新建交易”的锁策略；`executeTrade`/`unlockTradeAssets` 要兼容旧交易（request 已锁）。
- **旧玩家**：C1 不需要数据迁移；C1 依赖证书 `hf.EnrollmentID`。如果旧用户证书是手工签发没有该属性，需要重新 enroll 或补属性。
- **混合版本**：C2/C3 之后，旧后端用用户证书调 `ApplyGrowth` 会失败；必须**链码 + 后端一起发布**，不要长时间混跑。
- **真链 Docker**：Fabric 2.5 对 Docker 28/29 的兼容性差；优先 Docker 24/25/26。若无法降级，用 ccaas fallback，并把它纳入 compose。
- **签名密钥**：`SERVER_SIGNING_KEY` 一旦启用，轮换要保留 keyId/旧公钥，否则历史 `serverSig` 不可验。
- **经济改动**：先备份/清空 mock 世界状态（`docker compose down -v` 或 `redis-cli flushall`）再跑 seed，避免旧积分/旧价格混淆。

---

## 8. 第一天 30 分钟清单

1. `git status`，确认只有 `docs/review-2026-10-25.md` 未跟踪；`git checkout -b fix/review-p0`。
2. 读 `AGENTS.md` + 评审报告 §2.1/§2.3/§3。
3. 跑基线：链码 88、后端 367、前端 200；Mock e2e 25/25。
4. 打开 `chaincode/pokemon-cc/src/common/state.ts` 和 `tests/helpers/harness.ts`，先写一个“B 不能转 A 积分”的失败用例。
5. 实现 P0-1 的 `getEnrollmentId` + `assertCallerIsPlayer`；改 harness；跑到绿。
6. 加 P0-5 的 `Forfeit` 用例 + 3 行修复；跑到绿。
7. 跑三套测试；更新 `AGENTS.md` 计数；commit。
8. 再开 P0-6（BOLA/队伍去重），不要同时动 C4。

> 如果 P0-1 的 harness 改动超过 2 小时，先停下来把改动范围记录在 commit message/文档里；不要用“属性缺失回退 MSP”来省事。

---

## 9. 明确不要做的事

- 不要删除 Mock 模式或把测试改成只跑真链。
- 不要为了“让 e2e 过”而放宽 `Forfeit`/`Mint`/`ApplyGrowth` 权限。
- 不要在链码里加 `Date.now()`/`Math.random()`/`invokeChaincode`。
- 不要把 `CERT_ENC_KEY`、私钥、serverSeed 写进仓库/日志。
- 不要把经济数值、前端重构、真链部署混在一个 commit。
- 不要直接 `git add -A`（会带入临时证书、账本、报告）。
- 不要在没有 `querycommitted`/`GetPlayer` 验证前宣称“真链通过”。
- 不要改 `docs/review-2026-10-25.md` 的结论来“匹配”代码；应该改代码/文档，而不是改评审。

---

## 10. 需要产品决策时的默认选择

| 问题 | 默认选择 | 备注 |
|---|---|---|
| 身份校验 | `hf.EnrollmentID` vs `playerId` | 不引入 schema；旧记录无需迁移 |
| `RegisterPlayer` | 加 `admin|system` | 防抢注；后端已用 system |
| `ApplyGrowth` | system-only | 玩家改名/学技能由后端 system 代签 |
| `learnMove` | 下线免费入口，走 TM | 若保留，必须消耗 TM + 学习表 |
| 交易锁 | 只锁 offer；execute 时校验 request | 兼容旧交易 |
| 真链链码 | node 包 + Docker 24/25/26 | 若 Docker 29，用 ccaas fallback |
| PvP 经验 | 胜者队伍每只 +30 | 机器人仍 +15 |
| 注册积分 | 400 + 72h 转账锁（P2） | 需同步 e2e 预期值 |
| 大师球 | 传说图鉴 6/6 或赛季前 10 | 不要放商店 |
| 羁绊易主 | 先保留现状，P2 再改 50% | 避免安全和数值混在一起 |

如果实际代码与本文档冲突，以代码/契约为准，但要在同一个 commit 里把文档改回来，并在 commit message 说明差异。
