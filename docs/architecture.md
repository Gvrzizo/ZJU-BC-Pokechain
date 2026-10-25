# PokeChain 总体架构设计

> 课程大作业设计文档 · 与 `docs/chaincode-api.md`（链码契约）、`docs/backend-api.md`（后端 API 契约）配套
> 本文描述的系统已全部实现，文中路径均可在仓库中对照源码核实。

## 1. 系统概述

PokeChain 是一个基于 Hyperledger Fabric 2.5 的类宝可梦区块链游戏。玩家通过浏览器进行地图行走、宝可梦捕捉、养成、交易与押注对战；游戏资产（宝可梦、道具、积分、随机事件、交易单、对局）全部登记在 Fabric 账本上，由双组织联盟链背书；Web 后端承担身份托管、流程编排与实时战斗计算，浏览器不直接接触 Fabric 节点。

设计目标与作业要求的对应关系：

| 作业要求 | 本系统的落实 | 详见 |
|---|---|---|
| 联盟链多组织 | Org1（运营方）+ Org2（仲裁方）双组织、单 Raft orderer、通道 `gamechannel` | §3 |
| 智能合约管理资产 | `pokemoncc` 链码 6 合约：Player/Random/Pokemon/Item/Trade/Battle | `docs/chaincode-api.md` |
| 数字资产确权与流转 | 宝可梦/道具/积分链上登记，ownerId 确权，交易/对战驱动状态机流转 | §5 |
| 可验证随机数 | 承诺-揭示 + HMAC-SHA256 派生流，链上重算验证 | `docs/randomness.md` |
| 交易与原子结算 | TradeContract 双确认 + 同事务原子交换 | §6.3 |
| 押注对战与仲裁 | BattleContract 锁定/escrow/签名结果/双确认/兜底/Org2 仲裁 | §6.4 |
| 身份与权限 | Fabric CA 签发 X.509，角色属性入证书，链码 CID 校验 | §4 |
| 链下资源管理 | MinIO 存图片，链上只存 hash+URI，前端 sha256 校验 | `docs/security.md` §5 |
| 安全与隐私 | 防重放/限流/argon2/JWT/私钥加密托管/PDC 扩展方案 | `docs/security.md` |
| 一键部署与演示 | scripts/up.sh / deployCC.sh / reset.sh + Mock 演示模式 | `docs/deployment.md` |

## 2. 总体分层架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 表现层  浏览器                                                             │
│  Vue3 + pinia + vue-router │ Phaser 3（地图/战斗渲染）                     │
│  axios（JWT、X-Nonce/X-Timestamp 注入） │ socket.io-client │ Web Crypto    │
│  （vendor 素材 sha256 校验、/fairness 页面本地复核 HMAC 派生流）            │
└───────────────▲──────────────────────────────────────────▲───────────────┘
     HTTPS/REST /api/v1（JSON）                 WebSocket /battle（Socket.IO）
┌───────────────┴──────────────────────────────────────────┴───────────────┐
│ 应用层  NestJS 10 后端（B/S 架构的 S，浏览器不直连 Fabric）                 │
│ ┌─────────────┬──────────────┬───────────────┬─────────────────────────┐ │
│ │ Auth/Users  │ 捕捉编排      │ Trades         │ Battles                  │ │
│ │ argon2/JWT  │ Commit→派生→ │ 建单/确认/取消  │ 房间/押注双确认           │ │
│ │ refresh 轮换 │ Reveal→Mint │ 过期清扫        │ BattleEngine 服务端权威   │ │
│ ├─────────────┼──────────────┼───────────────┤ 30s 回合/60s 掉线/5min 兜底│ │
│ │ 公共防线：helmet、CORS 白名单、ValidationPipe、JWT/Roles 守卫、          │ │
│ │ nonce 防重放拦截器、Redis 滑动窗口限流、统一错误码                         │ │
│ ├─────────────┴──────────────┴───────────────┴─────────────────────────┤ │
│ │ Fabric 集成：ContractService（注入 nowISO+idemKey）                     │ │
│ │   → ChainAdapter 抽象（一方法对应一笔链码交易）                          │ │
│ │      ├─ FabricChainAdapter（FABRIC_MOCK=false，fabric-gateway 代发）    │ │
│ │      └─ MockChainAdapter  （FABRIC_MOCK=true，Redis 共享状态链）         │ │
│ │ FabricCaService（注册/enroll）│ ChainEventsService（链事件→WS 推送）     │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
└───────▲───────────────────────▲───────────────────────────▲──────────────┘
        │ gRPC/TLS              │ gRPC(gateway)             │ gRPC/TLS
        │ register/enroll       │ submit/evaluate           │ （peer 直连:7051）
┌───────┴───────┐       ┌───────┴───────────────────────────┴──────────────┐
│ 身份层         │       │ 区块链层  Hyperledger Fabric 2.5（容器网络 pokechain_net）│
│ ca.org1:7054  │       │ ┌────────────────┐   ┌────────────────┐          │
│ ca.org2:8054  │       │ │ peer0.org1:7051│   │ peer0.org2:9051│          │
│ 签发 X.509，   │       │ │ Org1MSP 运营方 │   │ Org2MSP 仲裁方 │          │
│ role 属性入证   │       │ │ + couchdb0     │   │ + couchdb1     │          │
│ 书（MSP 背书） │       │ └───────┬────────┘   └────────┬───────┘          │
└───────────────┘       │         └──────────┬──────────┘                  │
                        │   orderer.pokechain.com:7050（单节点 etcdraft）   │
                        │   通道 gamechannel · 链码 pokemoncc（6 合约）      │
                        │   世界状态 CouchDB（富查询 + META-INF 索引）       │
                        └─────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────┐
│ 链下支撑层（后端私有，不上链）                                              │
│ PostgreSQL 16：users(口令哈希/加密证书)、battle_logs、audit_logs、          │
│                 friendships/blacklists/chat_messages/assets               │
│ Redis 7：refresh 白名单、nonce、限流窗口、捕捉会话(含未揭示 serverSeed)、     │
│           战斗房间/大厅缓存、排行榜 ZSET、战斗种子灾备                        │
│ MinIO：sprite/道具图片等静态资源（链上仅存 uri + metadataHash）              │
└──────────────────────────────────────────────────────────────────────────┘
```

读图要点：

- **浏览器永远不见 Fabric**：所有链上读写都经 NestJS 中转，链上身份由后端托管代发（§4.3），这满足"浏览器不直连 Peer/Orderer"的 B/S 架构要求，也让 JWT/限流/防重放等 Web 防线成为链的统一入口。
- **ChainAdapter 双实现**：接口与链码交易一一对应（`backend/src/fabric/chain.adapter.ts`），真实网络与内存 Mock 可一键切换（`FABRIC_MOCK`），课堂演示无需起链也能跑通全部业务，且 Mock 复刻了锁定/escrow/幂等/承诺-揭示语义，测试与演示结论可迁移到真链。Mock 世界状态存 Redis（键前缀 `mockchain:`），因此 seed 进程、API 进程与重跑共享同一份账本状态。
- **随机性与战斗在链下计算、链上锚定**：战斗引擎每秒多次掷点不适合上链，因此"种子承诺上链 → 链下计算 → 结果哈希+签名上链 → 事后揭示可复核"（详见 `docs/randomness.md`）。

## 3. 区块链网络：组织、通道与背书策略

### 3.1 拓扑（`network/`，compose project 名 `pokechain`）

| 节点 | 宿主机端口 | 容器内地址 | 角色 |
|---|---|---|---|
| orderer.pokechain.com | 7050 | 同左 | 单节点 etcdraft 排序服务（课程简化；生产应 ≥3 节点） |
| peer0.org1.pokechain.com | 7051 | peer0.org1…:7051（链码 7052 仅容器内） | Org1 背书/提交节点，Org1MSP |
| peer0.org2.pokechain.com | 9051 | peer0.org2…:9051（链码 9052 仅容器内） | Org2 背书/提交节点，Org2MSP |
| ca.org1.pokechain.com | 7054 | 同左 | Org1 用户身份 CA（bootstrap admin/adminpw） |
| ca.org2.pokechain.com | 8054 | 同左 | Org2 用户身份 CA |
| couchdb0 / couchdb1 | 不暴露 | couchdb0:5984 / couchdb1:5984 | 两 peer 各自的世界状态库 |

节点证书由 **cryptogen** 生成（`crypto-config-*.yaml`，TLS 证书带 `localhost`/`127.0.0.1` SAN，方便宿主机工具直连）；两个 **Fabric CA 复用 cryptogen 生成的组织 CA 密钥**（`up.sh` 将 `ca/*_sk` 复制为 `ca/priv_sk` 供 CA 容器挂载），专职做游戏用户身份的注册与 enroll。创世块与通道交易由 configtxgen 按 `network/configtx.yaml` 的 `TwoOrgsOrdererGenesis` / `TwoOrgsChannel` profile 生成，Application 能力级别 V2_5。

### 3.2 通道与链码

- 通道：`gamechannel`（两组织 peer 均已加入，锚节点 peer0.org1:7051 / peer0.org2:9051，写在 configtx.yaml 的 AnchorPeers 中，`up.sh` 幂等校验跳过）。
- 链码：`pokemoncc`（TypeScript，fabric-contract-api 2.5），部署 label `pokemoncc_1.0`、version 1.0、sequence 1（`scripts/deployCC.sh`）。
- 状态库：CouchDB，支撑 `QueryByOwner`/`QueryPokedex` 等富查询；索引文件随链码打包于 `chaincode/pokemon-cc/META-INF/statedb/couchdb/indexes/`（owner、trade、battle、species 四张）。

### 3.3 背书与治理策略

| 策略 | 取值（configtx.yaml ApplicationDefaults） | 含义（两组织时） |
|---|---|---|
| 交易背书（Endorsement） | `MAJORITY Endorsement` | Org1+Org2 **双方 peer 都须背书** 才生效 |
| 链码生命周期（LifecycleEndorsement） | `MAJORITY Endorsement` | 链码定义（安装/升级）须两组织各自 approve |
| 通道管理（Admins） | `MAJORITY Admins` | 通道配置变更须两组织管理员多数 |

效果：任何单方组织都无法独断改写账本或独自升级链码——运营方（Org1）与仲裁方（Org2）互为制衡，这是"押注对战需要中立仲裁"的治理基础。链码级/私有背书（如仅对战相关交易要求 Org2 背书）属于可扩展点，`deployCC.sh` 当前使用通道默认策略（见 `docs/chaincode-api.md` §4）。

## 4. 身份体系

### 4.1 三层身份模型

```
Fabric CA (ca.org1/ca.org2)
   │  register + enroll（后端 FabricCaService，fabric-ca-client）
   ▼
X.509 证书 + 私钥 ──► 证书属性：role=player|admin|system|arbitrator（ecert 内嵌）
   │                   hf.EnrollmentID=用户名
   ▼
链码 CID（ClientIdentity）：getMSPID() 取组织，getAttributeValue('role') 取角色
   ▼
访问控制：requireRole / requireArbitrator(Org2MSP+arbitrator) / assertCallerIsPlayer(hf.EnrollmentID == playerId)
```

- **用户身份**：CA 自动写入的 `hf.EnrollmentID`（= 注册用户名 = 链上 `playerId`）是「本人」的唯一依据；`mspId` 只表示组织归属。`RegisterPlayer` 仅 `admin|system` 可调用（防抢注 username）。
- **组织归属（MSP）**：普通玩家与运营身份在 Org1MSP；仲裁身份在 Org2MSP。链码 `requireArbitrator` 同时校验 `mspId=Org2MSP` 与 `role=arbitrator`（`chaincode/pokemon-cc/src/common/cid.ts`），仲裁权因此不依赖后端自律，而由 Fabric 成员服务背书。
- **角色**：`player`（默认，注册即得）、`admin`（Org1 运营，可 GrantRole/MintItem/AddPoints）、`system`（后端服务身份，Org1，专用于 RevealAndVerify/CreateBattle/SubmitResult/SettleBattle 等编排交易）、`arbitrator`（Org2）。角色作为 CA 属性写进证书（`registerAndEnroll` 时 `attrs: [{name:'role', ecert:true}]`），链码改不了、后端也改不了，换角色必须重签证书或链上 GrantRole（仅 admin，且写链上 Player.role 供业务读取）。

### 4.2 四类链上身份与用途

| 身份 | MSP | 获取方式 | 典型交易 |
|---|---|---|---|
| 玩家（ash/gary…） | Org1MSP | 注册时 CA enroll，证书私钥 AES-256-GCM 加密存 users 表 | Transfer、ConfirmTrade、ConfirmResult、Dispute |
| system | Org1MSP | `FabricCaService.ensureSystemIdentity()` 注册/enroll（当前需手工执行，命令见 `docs/deployment.md` §4.4），证书落盘 `backend/.fabric-certs/` | RevealAndVerify、MintFromCapture、CreateBattle、SubmitResult、Forfeit、SettleBattle |
| admin | Org1MSP | 种子脚本/手工注册 | RegisterPlayer 代发、GrantRole、MintItem、AddPoints |
| arbiter | Org2MSP | 种子脚本建账号（DB role=arbitrator、fabricMspId=Org2MSP；Mock 模式开箱可用；真链需另行向 Org2 CA enroll，见 `docs/deployment.md` §4.4） | Arbitrate |

### 4.3 托管代发模式

用户私钥不出后端：注册时后端完成 CA 注册+enroll，私钥用 `CERT_ENC_KEY`（64 hex，AES-256-GCM）加密后与证书一起存 PostgreSQL `users.fabric_key_enc / fabric_cert_enc`（`backend/src/common/utils/secret-box.util.ts`）；用户发起链上操作时，后端解密私钥、以其证书经 fabric-gateway 签名代发。课程环境可接受，生产应替换为 HSM/KMS 或客户端自持私钥——风险声明见 `docs/security.md` §1.4。Web 层会话用 JWT（access 15min / refresh 7d，Redis 白名单+轮换），与链上身份解耦：JWT 管"能不能调 API"，X.509 管"链上算谁"。

## 5. 链上 / 链下职责划分

划分原则：**凡涉及"资产归属、价值转移、公平性裁决"的，必须上链并经双方组织背书；凡是高频、大体积、易变或纯展示的，放链下。**

| 职责 | 链上（pokemoncc / CouchDB 世界状态） | 链下（PG / Redis / MinIO / 内存） |
|---|---|---|
| 账号与口令 | —（链上没有口令概念） | users 表 argon2 口令哈希、昵称/头像 |
| 玩家资产台账 | Player（积分/战绩）、Pokemon、Item 的 ownerId 与状态机 | 展示层缓存（Redis 5s） |
| 随机公平性 | RandomCommit 承诺/揭示/消费状态机、commitHash、resultHash | serverSeed 生成与暂存（Redis/内存，揭示前保密）、HMAC 派生计算 |
| 捕捉判定 | MintFromCapture 铸造（消费已揭示随机） | 捕捉公式、分块派生（capture-derive.ts） |
| 交易 | 锁定、双确认、原子交换、过期解锁 | 交易单 DTO 组装、过期清扫触发 |
| 押注对战 | 押注锁定+escrow、wagerHash、结果记录（resultHash/serverSig）、结算/退款/仲裁 | 回合制战斗引擎（伤害/命中/暴击）、30s/60s 计时、回合日志（battle_logs） |
| 争议仲裁 | Dispute 冻结、Arbitrate 终局（Org2） | 仲裁操作 audit_logs 留痕、回放展示 |
| 静态资源 | Item.uri + metadataHash | MinIO 图片/音频，前端 sha256 校验 |
| 实时推送 | 链事件（setEvent） | 事件→Redis→Socket.IO 转发、大厅缓存 |
| 安全防线 | 链码访问控制/状态机/幂等 | JWT、nonce 防重放、限流、入参校验 |

对应到作业"链上链下结合"的逐条映射：资产确权与流转✔（链上）、随机数可验证✔（链上承诺+链下派生）、战斗高性能计算✔（链下引擎+链上锚定）、大文件资源✔（MinIO+哈希锚定）、操作留痕✔（链上事件 + 链下 audit_logs 双轨）。

### 5.1 为什么 Fabric 没有挖矿与节点奖励

Hyperledger Fabric 是**许可链**（permissioned）：加入 `gamechannel` 的组织与节点由 MSP/CA 证书准入、通道配置决定，没有公开链那种"算力竞争出块、按算力分配奖励"的机制，也**不存在原生代币**与 gas 概念，交易不消耗任何链上货币。它的最终性来自**排序服务（Raft orderer）出块 + 背书策略（本作业为 Org1/Org2 双组织多数背书，见 §3.3）**：交易一旦被足够多背书节点签名、由 orderer 排入区块并写入账本即最终确认，不需要等待若干个区块的"确认数"，也不需要矿工打包。因此本项目的"积分"（`Player.points`）不可能是挖矿产出，而是**游戏自己发行的链上记账资产**：由 `admin`/`system` 身份经 `PlayerContract.AddPoints` 发放与扣减（注册初始 400 且 72h 内不可转出——`Player.transferLockUntil`，堵多开小号转账；收服 +20、击倒/放生按等级 ×1、押注结算），每一笔都带可审计 `reason` 并落链，等价于运营方在账本上记账，而非节点算力奖励。同理，运行 peer/orderer 的组织（课程环境即两台机器/容器）**不会因为出块而获得任何积分**，节点奖励在这套架构里从设计上就不存在。

## 6. 关键流程时序

### 6.1 注册（Web 账号 + 链上身份 一次完成）

```
浏览器            NestJS(Auth)          PostgreSQL        Fabric CA        链码(PlayerContract)
 │ register         │                     │                 │                 │
 │─────────────────▶│ argon2 哈希建用户    │                 │                 │
 │                  │────────────────────▶│                 │                 │
 │                  │ register+enroll(role=player 入 ecert) │                 │
 │                  │─────────────────────────────────────▶│                 │
 │                  │  X.509+私钥                           │                 │
 │                  │◀─────────────────────────────────────│                 │
 │                  │ AES-256-GCM 加密私钥存 users 表        │                 │
 │                  │────────────────────▶│                 │                 │
 │                  │ RegisterPlayer（admin 代发，idemKey=register-<username>）│
 │                  │────────────────────────────────────────────────────────▶│
 │                  │                                       PlayerRegistered │
 │  JWT 对          │◀────────────────────────────────────────────────────────│
 │◀─────────────────│
```

要点：三步任一失败即整体失败返回错误；`RegisterPlayer` 幂等，重复注册（如同名重试）不会重复建链上档案。`FABRIC_MOCK=true` 时跳过 CA 两步，链上档案由 MockChainAdapter 落 Redis 共享状态（`mockchain:*`，见 `backend/src/fabric/mock-chain.store.ts`）。新玩家链上初始 `points=400`，注册时写入 `transferLockUntil = nowISO + 72h`：锁定期内 `TransferPoints` 与交易中支付积分的一方都抛 `TRANSFER_LOCKED`（seed 用 admin `ClearTransferLock` 解锁演示账号）；详见 `docs/backend-api.md` §10「积分经济」。注册后前端引导进入 `/starter` 领新手礼包（三选一御三家，仅一次）。

### 6.2 捕捉：遇敌 → 野怪战斗（PvE）→ Commit → Reveal → Mint

```
玩家       后端 Capture/WildService     Redis            RandomContract     ItemContract   PokemonContract
 │ encounter │                          │                  │                  │              │
 │──────────▶│ serverSeed←CSPRNG 32B    │                  │                  │              │
 │           │ commitHash=sha256(seed)  │                  │                  │              │
 │           │ Commit(eventId,commitHash,clientSeed) ────▶│ 状态 COMMITTED   │              │
 │           │ 【承诺上链后才允许使用随机】 │                  │                  │              │
 │           │ 派生 rand(0)→species、rand(1)→level          │                  │              │
 │           │ 会话(seed 明文)──────────▶│ TTL 1h          │                  │              │
 │◀──────────│ {eventId, wild 预览, commitHash}（不泄露 IV）│                  │              │
 │ wild/start │                          │                  │                  │              │
 │──────────▶│ 派生野怪个体(20000 区) + 出战队伍(最强 IDLE)     │                  │              │
 │           │ 会话────────────────────▶│ wild:<id> TTL 15min│                  │              │
 │◀──────────│ {sessionId, 双方 HP, 各球成功率, log}          │                  │              │
 │ action:move/ball/run                 │                  │                  │              │
 │──────────▶│ 回合块(30000 区)：AI 选招 + 双方命中/暴击/浮动  │                  │              │
 │           │ ball: ConsumeItem(球-1, idem=eventId-attempt-n) ───────────────▶│              │
 │           │ RevealAndVerify(serverSeed)（仅首次，system）─▶│ 重算 sha256 校验  │              │
 │           │ 捕捉判定 rand(attempt 块+0) < p（p 随野怪 HP 变化，状态里下发）  │              │
 │           │ 成功: MintFromCapture(野怪个体,dnaHash,eventId) ───────────────────────────────▶│
 │           │                          │                  │ consumeRandom→CONSUMED │  铸造并归属玩家
 │◀──────────│ 新状态 {双方 HP, 各球实时成功率, log, captured?}│                  │              │
 │           │ 野怪倒地→ApplyGrowth(经验)；我方倒地/逃跑/15min 超时→终态          │              │
```

公平性要点：serverSeed 的哈希**先于**任何派生计算上链，后端事后无法换种子；clientSeed 可由玩家提供，后端也无法单独决定结果；揭示时链上重算 `sha256(serverSeed)==commitHash`；铸造必须消费同一事件，杜绝"用未承诺的随机铸宠"。完整论证见 `docs/randomness.md`。

野怪战斗（PvE，`backend/src/wild/`）是捕捉的**主流程**：`POST /wild/start` 用 encounter 的 eventId 开会话，`POST /wild/:id/action` 出招/投球/逃跑；回合判定复用 PvP 引擎的纯函数（`battles/engine/battle-math.ts`）与同一套属性/能力值口径，掷点取该事件派生流的野怪区段（20000 个体、30000 回合）。兼容路径 `POST /capture/attempt`（快速捕捉，等价满血投球）保留给冒烟脚本与旧前端。细节见 `docs/backend-api.md` §2。

### 6.3 交易：双确认 + 原子结算

```
A                  后端 TradesService              TradeContract                     B
 │ POST /trades      │                                │                               │
 │──────────────────▶│ CreateTrade(offer,request,TTL) │                               │
 │                  │───────────────────────────────▶│ 校验双方资产归属/状态/积分余额     │
 │                  │                                │ 全部资产→LOCKED_TRADE(lockRef=id)│
 │                  │                                │ manifestHash=sha256(canonical(…))│
 │ confirm           │                                │                               │
 │──────────────────▶│ ConfirmTrade(A) ─────────────▶│ confirmations.from=true        │
 │                  │                                │         ◀── 通知（链事件→WS） ──│
 │                  │                                │◀──────── ConfirmTrade(B) ──────│
 │                  │                                │ confirmations.to=true          │
 │                  │                                │ 【同一交易内原子执行】           │
 │                  │                                │  交换 owner、划转积分、解锁      │
 │                  │                                │  任一校验失败整体回滚           │
 │                  │                                │ status=EXECUTED                │
```

取消/过期：`CancelTrade`（任一方，OPEN 时）与 `ExpireTrade`（任何人可触发；后端列表查询时惰性清扫）都会解锁全部资产。锁定资产再开新单会被 `ASSET_LOCKED` 拒绝，从状态机层面防双花。

### 6.4 押注对战：锁定 → 战斗 → 签名结果 → 结算/仲裁

```
A            后端 BattlesService/BattleManager       BattleContract          B            Org2 仲裁
 │ 建房(wagerA,teamA) │                                  │                    │              │
 │───────────────────▶│ Redis 房间 WAITING                │                    │              │
 │                   │◀────────────────── join(wagerB,teamB) ────────────────│              │
 │ confirm           │                                  │◀──── confirm ─────│              │
 │──────────────────▶│ 第二次确认：wagerHash=sha256(canonical)│                    │              │
 │                   │ CreateBattle(wagerHash) ────────▶│ 校验哈希/归属/余额    │              │
 │                   │                                  │ 资产→LOCKED_BATTLE  │              │
 │                   │                                  │ 积分扣入 escrow     │              │
 │                   │ ActivateBattle ─────────────────▶│ →ACTIVE           │              │
 │                   │ 战斗 RandomCommit(purpose=battle)  │                    │              │
 │                   │ 启动 BattleEngine（服务端权威）     │                    │              │
 │ ◀══ Socket.IO /battle：battle:state / battle:turn（30s）/ battle:end ══▶   │              │
 │                   │ 结束：RevealAndVerify 战斗种子      │                    │              │
 │                   │ resultHash=sha256(canonical(回合日志))│                   │              │
 │                   │ serverSig=secp256k1(resultHash)   │                    │              │
 │                   │ SubmitResult ────────────────────▶│ →RESULT_SUBMITTED │              │
 │ confirm 结果       │                                  │◀──── confirm 结果─│              │
 │──────────────────▶│ ConfirmResult ×2 ───────────────▶│ 双方确认→原子结算    │              │
 │                   │ （2min 未确认：SettleBattle 兜底）   │ →SETTLED          │              │
 │                   │                                  │ 赢家得全部押注+escrow│             │
 │── dispute(reason) ──────────────────────────────────▶│ →DISPUTED 资产冻结 │              │
 │                   │                                  │◀── Arbitrate(outcome) ──────────│
 │                   │                                  │ →SETTLED / REFUNDED│              │
```

异常路径的结算规则表（超时/掉线/认输/平局/掉线不确认）见 `docs/security.md` §4.3。

## 7. 模块与目录结构

```
Pokechain/
├── network/                    # Fabric 2.5 双组织网络（独立 compose：pokechain）
│   ├── configtx.yaml           #   TwoOrgsOrdererGenesis / TwoOrgsChannel（App V2_5）
│   ├── crypto-config-*.yaml    #   cryptogen 配置（TLS 带 localhost SAN）
│   ├── docker-compose.yaml     #   orderer + 2 peer + 2 CouchDB + 2 CA
│   ├── connection-profile-org{1,2}.json
│   ├── bin/ config/            #   install-fabric.sh 下载产物（gitignore）
│   ├── organizations/          #   cryptogen 输出 + CA 数据（gitignore）
│   └── channel-artifacts/      #   genesis.block / gamechannel.tx/.block / 链码包
├── chaincode/pokemon-cc/       # TypeScript 链码（fabric-contract-api 2.5）
│   ├── src/contracts/          #   player/random/pokemon/item/trade/battle 六合约
│   ├── src/common/             #   cid/assert/state/idempotency/query/bundle/crypto
│   ├── META-INF/statedb/couchdb/indexes/   # 4 张富查询索引
│   └── tests/                  #   Jest 60 用例（手写 mock-stub harness）
├── backend/                    # NestJS 10 后端
│   └── src/
│       ├── fabric/             #   ChainAdapter 抽象 + Fabric/Mock 双实现 + CA/Gateway
│       ├── auth/ users/ social/#   账号、argon2、JWT、好友/黑名单
│       ├── pokemon/            #   捕捉编排/快速捕捉 + capture-derive.ts 派生布局（含分球校验）
│       ├── wild/               #   野怪战斗（PvE 捕捉主流程）：会话/回合结算/Redis 状态
│       ├── items/ trades/      #   道具、交易
│       ├── battles/            #   房间/押注 + engine/ 战斗引擎 + /battle 网关 + 签名
│       ├── fairness/ assets/ admin/ leaderboard/
│       ├── game-data/          #   species/moves/natures/items/type-chart 静态表 + stats.ts 能力值公式（种族值+IV+EV+等级+性格）
│       ├── common/             #   守卫/拦截器/过滤器/Redis/加密工具
│       └── scripts/seed.ts     #   演示数据（npm run seed）
├── frontend/                   # Vue3 + Phaser 3
│   └── src/{api,stores,game,ui,components,views,styles}
│   └── nginx.conf              # SPA + /api + /socket.io 反代
├── scripts/                    # up.sh / deployCC.sh / down.sh / reset.sh / prereq.sh
└── docs/                       # 本文档族
```

## 8. 技术选型与理由

| 选型 | 理由 | 放弃的替代方案及原因 |
|---|---|---|
| Hyperledger Fabric 2.5（联盟链） | 作业要求许可链；MSP/通道/私有数据等机制天然匹配"运营方+仲裁方"的治理；execute-order-validate 与确定性链码便于讲清背书安全 | 公链（无准入、Gas、终局慢）；Fabric 2.4（无 V2_5 能力） |
| 单节点 etcdraft orderer | 课程环境最小可运行共识，配置简单；raft 语义与生产一致，扩到多节点只改 configtx | solo（已被 2.5 移除）；kafka（运维过重） |
| CouchDB 状态库 | 富查询（按 owner/species 检索）与 META-INF 索引是图鉴/背包/大厅的基础 | LevelDB（只能按 key 精确查） |
| TypeScript 链码（fabric-contract-api 2.5） | 与后端同语言，canonical JSON/HMAC 派生可共享实现并字节级对齐；类型系统减少链上 bug | Go 链码（跨语言对齐哈希/JSON 易踩坑） |
| NestJS 10 + fabric-gateway | Gateway API 是 2.5 官方推荐（旧 fabric-network 已废弃）；Nest 的守卫/拦截器/管线刚好承载防重放/限流/校验 | 裸 Express（横切逻辑分散）；fabric-network SDK（deprecated） |
| 承诺-揭示 + HMAC-SHA256 派生流 | 纯哈希即可实现可验证随机，链上只需重算 sha256；HMAC 派生给单次事件无限掷点，适合战斗 | 区块哈希（Fabric 无此语义）；VRF（列为升级路线，见 randomness.md §8） |
| 服务端权威战斗 + 结果签名上链 | 回合制战斗高频掷点无法上链；secp256k1 签名+resultHash 让结果不可抵赖、可事后复核 | 全链上战斗（吞吐/时延不可行）；纯链下战斗（不可审计） |
| Vue3 + Phaser 3 | Vue 负责表单/列表，Phaser 负责像素地图与战斗动画；Web Crypto 可完成前端 sha256/HMAC 复核 | Unity/Cocos（B/S 轻量要求下过重） |
| PostgreSQL + Redis + MinIO | PG 存账号/日志，Redis 存会话/限流/房间/缓存（TTL 语义），MinIO S3 兼容存资源 | MongoDB（课程栈统一关系型）；本地文件存资源（无 URI 化/签名 URL） |
| MockChainAdapter 共享链（状态存 Redis） | 课堂演示与单测不依赖 Docker 网络，语义对齐链码；seed/API/重跑共享同一账本状态；`FABRIC_MOCK` 一键切换 | 每次演示都起真链（环境脆弱、演示风险高） |
