# PokeChain 部署与演示手册

> 两种运行模式：**A. 演示模式**（`FABRIC_MOCK=true`，Redis 共享 mock 链，5 分钟开课）；**B. 完整模式**（真实 Fabric 2.5 双组织网络）。
> 本文所有命令在仓库根目录执行（除非另注），路径相对仓库根。涉及脚本：`scripts/{up,deployCC,down,reset,prereq,common}.sh`。

## 1. 环境依赖

### 1.1 软件

| 依赖 | 版本要求 | 用途 | 检查命令 |
|---|---|---|---|
| Docker Engine + Compose 插件 | compose **v2**（`docker compose version`） | Fabric 网络容器、PG/Redis | `docker info`、`docker compose version` |
| Node.js | **20+**（后端 argon2 原生模块需编译链） | 后端/前端/seed | `node -v` |
| npm | 随 Node | 同上 | `npm -v` |
| jq | 任意 | 锚节点配置、链码就绪断言 | `jq --version` |
| curl | 任意 | 下载 Fabric 二进制、API 验证 | `curl --version` |

Fabric 平台二进制（cryptogen/configtxgen/configtxlator/peer 等，默认 **2.5.9** + CA **1.5.12**）**无需手工安装**：首次 `scripts/up.sh` 会经官方 `install-fabric.sh` 下载到 `network/bin/`（可用 `FABRIC_VERSION`/`CA_VERSION` 覆盖版本，`FABRIC_INSTALL_BINARIES=off` 禁止自动下载）。`scripts/common.sh` 始终把 `network/bin` 放在 PATH 最前，避免 PATH 上其他项目的 2.4 旧二进制混用。

### 1.2 镜像清单与磁盘

| 镜像 | 标签 | 用途 | 模式 |
|---|---|---|---|
| hyperledger/fabric-peer | 2.5.9 | Org1/Org2 peer | B |
| hyperledger/fabric-orderer | 2.5.9 | Raft 排序 | B |
| hyperledger/fabric-ca | 1.5.12 | 两组织用户 CA | B |
| hyperledger/fabric-couchdb | 0.4.22 | 世界状态库 | B |
| postgres | 16 | 后端数据库 | A+B |
| redis | 7 | 会话/限流/缓存 | A+B |
| minio/minio | latest（可选） | 资源存储（`MINIO_MOCK=true` 时不需要） | A+B 可选 |
| node | 20-alpine（构建期） | 后端/前端 Docker 构建 | 可选 |

磁盘预留：镜像约 3–4 GB（其中 Fabric 四件套约 2.5 GB）+ 链码容器构建（peer 在容器内 `npm install`，每个 dev-peer0.* 镜像约 1 GB）+ 数据卷，建议 ≥ 8 GB 空闲。

## 2. 两种运行模式总览

| | A. 演示模式 | B. 完整模式 |
|---|---|---|
| 链 | `MockChainAdapter` 共享 mock 链：世界状态存 Redis（`mockchain:*`），复刻链码语义（锁定/escrow/幂等/承诺-揭示均为真实 sha256+HMAC 计算） | Fabric 2.5 双组织网络 + `pokemoncc` 链码 |
| 前置 | 只需 PG + Redis | Docker 网络 + 链码部署 + system 身份 enroll |
| 适用 | 课堂快速演示、开发、单测 | 答辩验收"真链"环节、链上验证 |
| 数据持久性 | Redis 共享世界状态（`mockchain:*`，随 redis 容器生命周期；账号/日志在 PG，重跑 seed 幂等可恢复） | 账本 + CouchDB（`down.sh` 不加 -v 之外均保留） |
| 演示账号 | seed 四账号全部可用 | **seed 账号无托管证书，仅注册页新建账号可玩**（§4.4） |

> 说明：根目录已提供应用层 `docker-compose.yaml`（postgres/redis/minio/minio-init/backend/frontend，健康检查齐全，默认 `FABRIC_MOCK=true`），模式 A 标准路径即根 compose（§3.1）；下文另附本地 `npm` 开发路径（§3.2）与单独构建镜像的容器化路径（§3.4）。

## 3. 模式 A：演示模式（FABRIC_MOCK=true）

### 3.1 标准路径：根 compose 一键（推荐）

```bash
docker compose up -d --build   # postgres + redis + minio(+init) + backend + frontend（默认 mock 链，世界状态存 Redis）
./scripts/seed-demo.sh         # 等 backend 健康检查通过后灌演示数据（ash/gary/arbiter/admin，密码 demo1234）
./scripts/e2e-smoke.sh         # 端到端冒烟：健康检查→注册→捕捉→交易→押注对战→结算→公平性复核
```

浏览器访问 http://localhost:8080（frontend nginx 反代 `/api` 与 `/socket.io` 到 backend:3000；API 亦可直连 http://localhost:3000/api/v1）。根 compose（项目 `pokechain-app`）与 `network/docker-compose.yaml`（Fabric 网络，项目 `pokechain`）相互独立，模式 A 不需要 `scripts/up.sh`。

### 3.2 本地开发路径（不起 Docker 应用栈）

```bash
# 1) 链下依赖（PG + Redis；MinIO 用 MINIO_MOCK=true 跳过）
docker run -d --name pokechain-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=pokechain postgres:16
docker run -d --name pokechain-redis -p 6379:6379 redis:7

# 2) 后端配置（.env.example 默认即 FABRIC_MOCK=true / MINIO_MOCK=true）
cd backend
cp .env.example .env
# 演示机建议补两项（不补也能跑，走开发默认值）：
#   JWT_SECRET=<随机长字符串>
#   CERT_ENC_KEY=$(openssl rand -hex 32)

# 3) 安装依赖、灌演示数据、启动
npm install
npm run seed          # 演示账号 + 道具 + 宝可梦（全链路幂等，可安全重跑；需先 npm run build，或改用 npm run seed:dev 免构建）
npm run start:dev     # http://localhost:3000/api/v1

# 4) 前端（另开终端）
cd ../frontend
npm install
npm run dev           # http://localhost:5173（/api 与 /socket.io 代理到 :3000）
```

对本机直接运行的后端灌数据也可用 `LOCAL=true ./scripts/seed-demo.sh`（自动选择 `npm run seed` / `seed:dev`）。

### 3.3 期望输出与验证

- `npm run seed`：打印 `created user ash ... / granted on-chain role arbitrator to arbiter / ensured demo items / ensured 皮卡丘 ... / seed complete. login: ash/gary/arbiter/admin, password demo1234`。全链路幂等：重复运行只补齐缺失资产，不会重复发放（固定 id + `seed-v1-*` idemKey）。`./scripts/seed-demo.sh` 在 seed 后还会登录 ash/gary 校验资产对运行中的 backend 可见，校验失败直接非零退出。
- 后端启动日志：`[pokechain] api listening on :3000 (mock=true)`。
- 存活验证（`@Public` 健康检查接口；compose healthcheck、`seed-demo.sh`、`e2e-smoke.sh` 均使用它）：

```bash
curl -s http://localhost:3000/api/v1/health
# 期望：{"status":"ok","uptime":<秒>,"ts":"<ISO>"}（compose 栈经前端反代亦可：http://localhost:8080/api/v1/health）
```

- 登录验证（变更请求需带防重放头）：

```bash
curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -H "X-Nonce: $(uuidgen || cat /proc/sys/kernel/random/uuid)" \
  -H "X-Timestamp: $(date +%s%3N)" \
  -d '{"username":"ash","password":"demo1234"}' | head -c 200
# 期望：{"user":{...},"accessToken":"...","refreshToken":"..."}
```

- 浏览器打开 `http://localhost:5173`，用 `ash / demo1234` 登录即入地图。

### 3.4 容器化替代路径（可选，单独构建镜像）

```bash
cd backend  && docker build -t pokechain-backend .
cd frontend && docker build -t pokechain-frontend .
docker network create pokechain-app
docker run -d --name backend  --network pokechain-app -p 3000:3000 \
  --env-file backend/.env pokechain-backend
docker run -d --name frontend --network pokechain-app -p 8080:80 pokechain-frontend
# 前端 nginx 反代目标为同网络的 backend:3000（frontend/nginx.conf），访问 http://localhost:8080
```

（后端镜像为 node:20-alpine 多阶段构建；前端为 node:20 构建 + nginx:alpine 运行。根 compose 已按等价方式编排，一般无需手工走本路径。）

## 4. 模式 B：完整模式（真实 Fabric 网络）

### 4.1 启动网络

```bash
./scripts/up.sh
```

七步流程：① 依赖检查（缺二进制自动下载到 `network/bin`）→ ② cryptogen 生成三份组织证书（CA 私钥复制为 `ca/priv_sk`）→ ③ configtxgen 生成 `genesis.block` 与 `gamechannel.tx` → ④ `docker compose -f network/docker-compose.yaml up -d`（orderer/2 peer/2 CouchDB/2 CA）→ ⑤ 等待 peer 就绪 → ⑥ 创建 `gamechannel` 并加入两 peer → ⑦ 锚节点幂等校验（configtx.yaml 已内置 AnchorPeers，通常打印"已是期望值，跳过"）。**脚本幂等**：重复运行不会重建证书/通道。

期望末尾输出：

```
========== 网络启动完成 ==========
拓扑：orderer.pokechain.com:7050 (Raft 单节点)
      peer0.org1.pokechain.com:7051 + couchdb0 + ca.org1:7054
      peer0.org2.pokechain.com:9051 + couchdb1 + ca.org2:8054
通道：gamechannel
```

### 4.2 部署链码

```bash
./scripts/deployCC.sh
```

流程：打包（`pokemoncc_1.0`，node 链码，`META-INF` CouchDB 索引随包）→ 安装到两 peer → 两组织各自 `approveformyorg` → `checkcommitreadiness` 断言双批准 → `commit` → `querycommitted` 验证。幂等：已按相同 version/sequence 提交则直接退出。

期望输出（末尾）：

```
链码：pokemoncc  version=1.0  sequence=1  通道=gamechannel
背书策略：通道默认（MAJORITY Endorsement，即 Org1+Org2 均须背书）
```

链码容器首次由 peer 在容器内构建（`npm install` + `tsc`），**这一步较慢（数分钟）**，可在 `docker ps --filter name=dev-` 看到 `dev-peer0.org1...-pokemoncc_1.0-*` 容器。

### 4.3 验证网络与链码

```bash
source scripts/common.sh
switchOrg 1
peer channel list                                        # 期望含 gamechannel
peer lifecycle chaincode querycommitted -C gamechannel -n pokemoncc --output json | jq .
# 期望：{"version":"1.0","sequence":1,...,"approvals":{"Org1MSP":true,"Org2MSP":true}}
```

### 4.4 配置后端并准备 system 身份

1) 修正 `backend/.env`（`.env.example` 的 Fabric 默认值已对齐本仓库网络 org*.pokechain.com；切真链至少把 `FABRIC_MOCK` 改为 `false`，其余按下表核对）：

```ini
FABRIC_MOCK=false
FABRIC_CHANNEL=gamechannel
FABRIC_CHAINCODE=pokemoncc
FABRIC_PEER_ENDPOINT=localhost:7051
FABRIC_PEER_HOST_ALIAS=peer0.org1.pokechain.com
FABRIC_PEER_TLS_CERT_PATH=../network/organizations/peerOrganizations/org1.pokechain.com/peers/peer0.org1.pokechain.com/tls/ca.crt
FABRIC_CA_URL=https://localhost:7054
FABRIC_CA_NAME=ca.org1.pokechain.com
FABRIC_CA_TLS_CERT_PATH=../network/organizations/fabric-ca/org1/tls-cert.pem
FABRIC_CA_ADMIN_ID=admin
FABRIC_CA_ADMIN_SECRET=adminpw
FABRIC_SYSTEM_USER=system
FABRIC_SYSTEM_MSP_ID=Org1MSP
FABRIC_CERT_STORE_DIR=.fabric-certs
CERT_ENC_KEY=<openssl rand -hex 32 的输出>
MINIO_MOCK=true        # 或接真实 MinIO
```

（`FABRIC_CONNECTION_PROFILE` 变量存在但当前实现未消费——gateway 直接用上表 endpoint/TLS 配置建连。）

2) **一次性 enroll system 服务身份**（后端不会自动做这一步）：

```bash
cd network
CA_TLS=organizations/fabric-ca/org1/tls-cert.pem
export FABRIC_CA_CLIENT_HOME=$PWD/../backend/.fabric-certs/ca-admin
bin/fabric-ca-client enroll -u https://admin:adminpw@localhost:7054 \
  --caname ca.org1.pokechain.com --tls.certfiles $CA_TLS
bin/fabric-ca-client register --id.name system --id.secret systempw \
  --id.attrs "role=system:ecert" --caname ca.org1.pokechain.com \
  --tls.certfiles $CA_TLS -u https://localhost:7054

export FABRIC_CA_CLIENT_HOME=$PWD/../backend/.fabric-certs/ca-system
bin/fabric-ca-client enroll -u https://system:systempw@localhost:7054 \
  --caname ca.org1.pokechain.com --tls.certfiles $CA_TLS
mkdir -p ../backend/.fabric-certs
cp "$FABRIC_CA_CLIENT_HOME/msp/signcerts/cert.pem" ../backend/.fabric-certs/system-cert.pem
cp "$FABRIC_CA_CLIENT_HOME"/msp/keystore/*_sk    ../backend/.fabric-certs/system-key.pem
chmod 600 ../backend/.fabric-certs/system-key.pem
```

3) 启动后端与前端（同模式 A 的 §3.2 第 3–4 步，本地路径；或将根 compose 按文件头 [real-fabric] 注释接入 Fabric 网络后以 `FABRIC_MOCK=false docker compose up -d --build` 启动）。

**真链模式已知限制（三条，实现现状，非文档错误）**：

- **演示账号不可用于真链**：`npm run seed` 建的 ash/gary/arbiter/admin 没有走 CA enroll，没有托管证书，其玩家身份交易会在后端报 `NO_FABRIC_CERT`。**请在前端注册页新建账号**（注册流程内含 CA register+enroll+加密托管）。
- **仲裁链路**：后端只接 Org1 CA，无法为 arbiter 取得 Org2MSP 证书，而链码 `requireArbitrator` 强制 Org2MSP+arbitrator —— 真链上 `Arbitrate` 需要另行手工向 ca.org2:8054 注册 Org2 身份并入库，课程演示中**仲裁环节请在模式 A 展示**（Mock 模式身份由后端直接断言，arbiter 开箱可用）。
- **admin 专属交易**：后端把 admin 身份映射到 system 证书签名，链码 `GrantRole` 要求 role=admin，真链上会被拒（MintItem/AddPoints 允许 admin|system，不受影响）。模式 A 无此问题。

### 4.5 端到端冒烟

`scripts/e2e-smoke.sh` 已实现：健康检查 → 注册随机账号 A/B → admin 发放物资（admin 不可用则容忍降级）→ A 捕捉 → A→B 交易双确认 → 开房押注 → B forfeit → 断言 SETTLED 与积分归属 → fairness 复核 `sha256(serverSeed)==commitHash`，任一断言失败即打印请求/响应并 exit 1。模式 A / compose 栈直接 `./scripts/e2e-smoke.sh`（默认打 http://localhost:8080，`BASE_URL=http://localhost:3000` 可直连后端）。模式 B 真链下注册接口会走 CA enroll，新账号冒烟链路可用，但受上文"真链模式已知限制"约束（seed 账号不可玩、仲裁不在真链演示）。手工冒烟清单（模式 B，先完成 4.4）：

1. 注册两个新账号 A/B（前端注册页）→ `peer chaincode query ... '{"Args":["PlayerContract:GetPlayer","<用户名>"]}'` 返回积分 1000；
2. A 走捕捉（§5 动线第 2 步），链上 `RandomContract:GetRandom` 看到 COMMITTED→REVEALED→CONSUMED；
3. A→B 发起交易并双方确认，`TradeContract:GetTrade` 看到 EXECUTED；
4. A/B 押注对战打到结算，`BattleContract:GetBattle` 看到 SETTLED 且 escrow 归赢家；
5. 任意 eventId 在 `/fairness` 页面复核三项等式全绿。

（上述 1–5 在模式 A 用 seed 账号可更快跑完，验收时先 A 后 B。）

## 5. 课堂演示动线（建议 15 分钟）

| # | 演示环节 | 界面/操作 | 链上验证命令（真链；`source scripts/common.sh && switchOrg 1` 后执行） |
|---|---|---|---|
| 1 | 注册与身份 | `/register` 注册账号；说明"注册=CA 发证书+链上建档" | `peer chaincode query -C gamechannel -n pokemoncc -c '{"Args":["PlayerContract:GetPlayer","<用户名>"]}'` |
| 2 | 捕捉（野怪战斗 + 承诺-揭示） | `/game` 方向键走进深草 → 遇敌 → 野怪战斗（技能削血 / 球按钮上的实时成功率 / 逃跑）→ 捕捉成功展示新宝可梦；先展示 encounter 返回的 commitHash | 投球前：`... '{"Args":["RandomContract:GetRandom","<eventId>"]}'`（status COMMITTED）；成功后同命令（status CONSUMED，含 serverSeed/resultHash） |
| 3 | 资产确权 | `/team` 展示新宝可梦 IV/性格/dnaHash 与"链上状态"徽章 | `... '{"Args":["PokemonContract:QueryByOwner","<用户名>"]}'` |
| 4 | 交易（双确认原子结算） | `/trade` 向另一账号发单 → 对方确认 → 双方确认后执行 | `... '{"Args":["TradeContract:GetTrade","<tradeId>"]}'`（OPEN→EXECUTED；锁定期间对方再开单报 ASSET_LOCKED） |
| 5 | 押注对战 | `/lobby` 建房（押积分+宝可梦）→ 另一账号加入 → 双方确认押注 → `/battle/:id` 实时对战 → 结算 | `... '{"Args":["BattleContract:GetBattle","<battleId>"]}'`（CREATED→ACTIVE→RESULT_SUBMITTED→SETTLED，escrow 归属） |
| 6 | 仲裁（模式 A） | 战斗中任一方 `/battle` 页"申诉" → arbiter 登 `/admin` 裁决 REFUND | Mock 模式看同一 GetBattle（DISPUTED→REFUNDED）；真链限制见 §4.4 |
| 7 | 公平性复核 | `/fairness` 输入 eventId → 三项哈希等式 + 派生流逐项打勾 | 与 `RandomContract:GetRandom` 输出对照 |
| 8 | 管理面 | admin 登 `/admin` mint 道具 / 调积分；展示 audit_logs | `... '{"Args":["ItemContract:QueryByOwner","<用户名>"]}'`；PG 查 `audit_logs` 表 |

时间分配建议：1+2 四分钟（重点讲承诺先于使用），3+4 四分钟（重点讲原子结算），5 四分钟（escrow+签名+兜底），6+7 两分钟，8 一分钟。

## 6. 常见故障表

| 症状 | 原因 | 处理 |
|---|---|---|
| `docker: command not found` / `Cannot connect to the Docker daemon` | Docker 未装/守护进程未起 | 安装 Docker Engine；`sudo systemctl start docker`；当前用户加入 docker 组 |
| 拉取 `hyperledger/fabric-*` 镜像超时 | Docker Hub 网络不可达 | 配置 registry mirror/代理后重跑 `up.sh` |
| `install-fabric.sh` 下载失败（GitHub 超时） | 网络受限 | `FABRIC_INSTALL_BINARIES=off ./scripts/up.sh` 跳过，手工把 Fabric 2.5.9 的 `bin/` 放 `network/bin/`、`config/` 放 `network/config/` |
| `peer: command not found` 或版本不符 | PATH 上有其他项目 2.4 旧二进制 | 脚本已把 `network/bin` 置 PATH 最前并校验 2.5.x；手工执行时先 `source scripts/common.sh` |
| 端口被占用（7050/7051/7054/8054/9051，或 3000/5173/5432/6379） | 上次未停干净/端口冲突 | `sudo lsof -i :<端口>` 找进程；Fabric 侧先 `./scripts/down.sh` |
| `x509: certificate is valid for ... not localhost` | 旧配置生成的证书无 localhost SAN | `./scripts/down.sh --purge && ./scripts/up.sh` 重建（勿在生产这么干） |
| 链码部署卡在 install/首次调用很慢 | peer 容器内 npm install + tsc 构建 | 正常现象，等数分钟；看 `docker logs dev-peer0.org1...`；npm 源慢属网络问题，耐心重试 |
| `approveformyorg` 报 "redefine uncommitted approved chaincode" | 该组织已批准同 sequence | 脚本幂等跳过，可忽略；升级链码需改 `deployCC.sh` 中 `CC_VERSION`/`CC_SEQUENCE` 后重跑 |
| 锚节点步骤报错 | configtx.yaml 已内置 AnchorPeers | up.sh 检测到已是期望值会跳过；个别 gossip 警告可忽略 |
| CA 容器起不来 / enroll 不受信 | 手工动过 `organizations/` | 删 `organizations/fabric-ca/` 与对应 `ca/priv_sk` 后重跑 up.sh |
| 后端启动报 `NO_FABRIC_CERT`（真链） | seed 账号无托管证书 | 模式 B 必须用注册页新建账号（§4.4） |
| 后端报 system 证书文件不存在（真链） | 未做 §4.4 第 2 步 | 按 4.4 手工 enroll system 身份到 `backend/.fabric-certs/` |
| `Arbitrate` 真链上 FORBIDDEN | 仲裁需 Org2MSP 证书，后端未接 Org2 CA | 课程演示在模式 A 进行仲裁（§4.4 限制说明） |
| 后端连不上 PG/Redis | 容器未起或端口冲突 | compose 栈：`docker compose ps`（postgres/redis 应为 healthy）；本地 docker run 方式：`docker ps` 确认 pokechain-pg / pokechain-redis；核 `.env` 的 DATABASE_URL/REDIS_URL |
| 前端一直占位图 | 未放 vendor 素材或 sha256 校验失败回退 | 正常降级行为；放素材到 `frontend/public/assets/vendor/` 并登记 manifest |
| 429 RATE_LIMITED / 409 REPLAY_DETECTED | 限流/防重放生效 | 降低点击频率；客户端必须每次请求新生成 X-Nonce |

## 7. 重置方法

| 范围 | 命令 | 影响 |
|---|---|---|
| 停 Fabric 网络（保证书/通道产物） | `./scripts/down.sh` | 容器+数据卷删除，`organizations/`、`channel-artifacts/` 保留，重跑 up.sh 快速恢复 |
| 彻底重置 Fabric | `./scripts/down.sh --purge` 或 `./scripts/reset.sh` | 连证书/通道产物一起删；reset.sh 会接着自动 up + deployCC 全量重建（`network/bin`、`network/config` 保留免重下） |
| 后端托管身份（真链） | `rm -rf backend/.fabric-certs` | system/CA 客户端证书清除，需重做 §4.4 第 2 步 |
| 链下数据（模式 A/B 通用） | compose 栈：`docker compose down -v`；本地 docker run 方式：`docker rm -f pokechain-pg pokechain-redis`（PG 内数据即删） | 账号/日志/会话清空，重新 `./scripts/seed-demo.sh`（或本地 `npm run seed`） |
| Mock 链内资产（模式 A） | `docker compose exec -T redis redis-cli del mockchain:state mockchain:idem`（或 `docker compose down -v`） | mock 链世界状态存 Redis 的 `mockchain:*`，backend 重启不丢；只清空链状态而保留 PG 账号，重跑 `./scripts/seed-demo.sh` 幂等恢复资产 |

完全回到出厂： `./scripts/reset.sh` + 上表后三行 + `rm -rf backend/.fabric-certs frontend/node_modules backend/node_modules`（如需重装依赖）。
