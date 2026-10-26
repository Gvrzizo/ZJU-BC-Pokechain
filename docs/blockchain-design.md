# PokeChain 架构与区块链设计总览

> 一篇通读材料：**先讲整体架构，再深入讲区块链设计**。
> 与 `docs/architecture.md`（分层与治理细节）、`docs/chaincode-api.md`（链码契约）、
> `docs/randomness.md`（随机性完整论证）、`docs/security.md`（安全边界）配套；
> 本文中的结论、数字与路径均可在源码与上述文档中核实。

## 0. 五分钟速览

**一句话**：用 Hyperledger Fabric 2.5 给一个网页链游做"资产账本 + 公平性公证处"——所有有价值、会易主、可争议的东西（宝可梦、道具、积分、对局、随机数承诺）登记在联盟链上，由 Org1（运营）与 Org2（仲裁）**双方背书**才能生效；战斗帧、地图、会话这些高频算力活全在链下。

**它不是"链上游戏"，而是"链下运行、链上确权"的游戏。**

| 关键问题 | 答案 | 详见 |
|---|---|---|
| 链上有哪些组织 | Org1 运营 + Org2 仲裁，单 Raft orderer，通道 `gamechannel` | §2 |
| 凭什么相信链上数据 | `MAJORITY Endorsement` = 两组织都要背书；链码升级也要双方批准 | §2.2 |
| 链上存什么 | player / pokemon / item / trade / battle / rand / idemp 七类文档 | §4.2 |
| 谁能在链上做高危操作 | 四种 CA 属性角色：player / admin / system / arbitrator | §3 |
| 随机数怎么保证公平 | 承诺-揭示 + HMAC 派生流，链上重算验证 | §5 |
| 战斗为什么不上链 | 上百次掷点无法进 2s 出块的账本，改为"结果哈希+签名上链、事后可重放" | §6 |
| 没有链怎么演示 | `ChainAdapter` 双实现，Mock 复刻链码语义、状态存 Redis | §7 |
| 这套设计的边界 | 私钥托管、单生成方随机、单 orderer、fail-open 限流…… | §9 |

---

## 1. 总体架构

### 1.1 三条贯穿全系统的铁律

| # | 铁律 | 具体体现 |
|---|---|---|
| 1 | **链上只管"所有权、价值、公平性证据"** | 宝可梦 ownerId/状态机、积分余额、押注 escrow、随机承诺与揭示值上链；伤害计算、能力值计算、房间状态、聊天不上链 |
| 2 | **链码必须确定性** | 禁 `Date.now()`/`Math.random()`/网络调用；时间靠 `nowISO` 入参，随机靠已验证的派生流 |
| 3 | **浏览器永不接触 Fabric** | 所有链上读写经 NestJS 代发，链上身份由后端托管（课程取舍，风险已声明） |

### 1.2 分层图

```
┌─ 表现层 ─────────────────────────────────────────────────────┐
│ Vue3 + Phaser3：地图/战斗渲染；/fairness 用 Web Crypto 独立复核  │
└───────────┬───────────────────────────────┬─────────────────┘
   REST /api/v1（JWT + X-Nonce/X-Timestamp）        WS /battle
┌───────────┴───────────────────────────────┴─────────────────┐
│ 应用层 NestJS：Auth/Users · Capture/Wild · Trades · Battles   │
│              Items/Shop · Ranked · Admin · Fairness          │
│   ContractService（自动注入 nowISO + idemKey）                 │
│      └─ ChainAdapter（抽象）─┬─ FabricChainAdapter（真链）     │
│                             └─ MockChainAdapter（Redis 状态）  │
└───────────┬───────────────────────────────┬─────────────────┘
     gRPC/TLS（CA register/enroll）    gRPC/TLS（gateway 代发）
┌───────────┴──────────────┐  ┌─────────────┴───────────────────┐
│ 身份层 Fabric CA          │  │ 区块链层 Hyperledger Fabric 2.5  │
│ ca.org1.pokechain.com:7054│  │ peer0.org1:7051 (Org1MSP)+CouchDB│
│ ca.org2.pokechain.com:8054│  │ peer0.org2:9051 (Org2MSP)+CouchDB│
│ 签发 X.509，role 写入证书  │  │ orderer:7050  单节点 etcdraft    │
└───────────────────────────┘  │ 通道 gamechannel · 链码 pokemoncc│
                               └─────────────────────────────────┘
┌─ 链下支撑层 ──────────────────────────────────────────────────┐
│ PostgreSQL：账号/口令哈希/加密证书/战斗日志/审计日志                │
│ Redis：refresh 白名单/nonce/限流/捕捉会话(含未揭示种子)/房间/排行榜   │
│ MinIO：图片音频（链上只存 uri + metadataHash）                    │
└───────────────────────────────────────────────────────────────┘
```

**读图要点**：这个架构里唯一"不可信"的是应用层与链下支撑层——它们可能宕机、可能作恶、可能被改数据。区块链层的职责是：**让应用层的任何撒谎都能被第三方用链上数据当场证伪**。

### 1.3 为什么是这个形状

- 浏览器不直连 Peer/Orderer：满足 B/S 架构要求，同时把 JWT/限流/防重放变成访问链的统一入口。
- 链下算、链上锚：随机与战斗的高频性决定了它们不可能逐步上链，只能用"承诺 → 链下计算 → 结果锚定"的三段式。
- 双组织：运维上并没有必要（课程环境一台机器就能跑），**必要性来自治理**——仲裁方必须独立于运营方，见 §2.2。

---

## 2. Fabric 网络与治理

### 2.1 拓扑（`network/`，compose project `pokechain`）

| 组件 | 地址 | 角色 |
|---|---|---|
| orderer.pokechain.com | 7050（宿主） | 单节点 etcdraft，BatchTimeout 2s |
| peer0.org1.pokechain.com | 7051 | Org1MSP 背书/提交 + couchdb0 |
| peer0.org2.pokechain.com | 9051 | Org2MSP 背书/提交 + couchdb1 |
| ca.org1.pokechain.com | 7054 | Org1 用户身份 CA（bootstrap admin/adminpw） |
| ca.org2.pokechain.com | 8054 | Org2 用户身份 CA |
| couchdb0 / couchdb1 | 仅容器内 5984 | 两 peer 各自的 world state |

- 通道 `gamechannel`，两组织 peer 均已加入，锚节点写在 `configtx.yaml` 的 `AnchorPeers`（`up.sh` 幂等校验）。
- 链码 `pokemoncc`（TypeScript，fabric-contract-api 2.5），label `pokemoncc_1.0`、version 1.0、sequence 1（`scripts/deployCC.sh`）。
- 节点证书由 **cryptogen** 预生成（TLS 带 localhost/127.0.0.1 SAN）；两个 **Fabric CA 复用 cryptogen 的组织 CA 密钥**（`up.sh` 把 `ca/*_sk` 复制为 `priv_sk`）。所以 CA 只干一件事：**给游戏玩家签发带 `role` 属性的用户证书**。
- 状态库 CouchDB 而非 LevelDB：需要按 owner/species 富查询。链码包内带 **5 张索引**（`chaincode/pokemon-cc/META-INF/statedb/couchdb/indexes/`）：`indexOwner`、`indexTrade`、`indexBattle`、`indexSpecies`、`indexItemStacks`。**缺索引 CouchDB 会直接拒绝查询**，所以索引是链码的一部分，不是运维配置。

### 2.2 背书策略才是治理的核心

`network/configtx.yaml` 的 `ApplicationDefaults`：

```yaml
Endorsement:          MAJORITY Endorsement   # 交易背书
LifecycleEndorsement: MAJORITY Endorsement   # 链码安装/升级
Admins:               MAJORITY Admins        # 通道配置变更
```

两组织场景下 `MAJORITY` = **2/2**，于是有三条硬结论：

1. **任何交易都要 Org1 + Org2 两个 peer 各自执行并签名**，读写集一致才能提交 → 单方无法独自写账本。
2. **链码升级也要双方各 approve 一次**（`deployCC.sh` 的 `checkcommitreadiness` 断言 `.approvals.Org1MSP == true and .approvals.Org2MSP == true`）→ **运营方不能偷偷改规则**。这是"仲裁方制衡运营方"的物质基础，不是道德承诺。
3. 任一组织 peer 宕机 → **写路径停摆，读路径仍可用**。这是可用性的代价（`security.md` §7.3 明确承认）。

补充：**这里没有挖矿、没有 gas、没有节点奖励**。Fabric 是许可链，最终性来自"Raft 出块 + 背书策略"，交易不需等确认数；`Player.points` 不是代币，而是**运营方自己发行的链上记账资产**，只能由 `admin`/`system` 经 `AddPoints` 变更，每笔带可审计的 `reason`。运行 peer/orderer 的组织不会因为出块获得任何积分——节点奖励在这套架构里从设计上不存在。

---

## 3. 身份体系：链上"你是谁"从哪来

### 3.1 三层身份，各管一段

| 层 | 凭据 | 管什么 | 失效影响 |
|---|---|---|---|
| Web 会话 | JWT（access 15min / refresh 7d，Redis 白名单轮换） | 能不能调这个 API | 重新登录 |
| 链上身份 | Fabric CA 签发的 X.509 + 私钥 | 这笔交易算谁签的 | 该用户的链上身份失陷 |
| 链上角色 | 证书内的 CA 属性 `role`（**写进 ecert，事后不可改**） | 能调哪些链码交易 | 必须重签证书 |

关键设计：**JWT 与 X.509 完全解耦**。JWT 挂了不影响链上资产；证书才是链上世界的身份证。

### 3.2 四种链上身份

| 身份 | MSP | 从哪来 | 典型高危交易 |
|---|---|---|---|
| player | Org1 | 注册时 CA enroll（`role=player` 入 ecert） | Transfer / ConfirmTrade / ConfirmResult / Dispute |
| admin | Org1 | 种子脚本或手工注册 | RegisterPlayer 代发、GrantRole、MintItem、AddPoints |
| **system** | Org1 | `ensureSystemIdentity()`，私钥落盘 `backend/.fabric-certs/` | RevealAndVerify、MintFromCapture、CreateBattle、SubmitResult、Forfeit、SettleBattle |
| **arbitrator** | **Org2** | 需向 Org2 CA enroll（真链手工，见 `deployment.md` §4.4） | 仅 Arbitrate |

`requireArbitrator` 同时校验 `mspId === Org2MSP` **且** `role === arbitrator`（`chaincode/pokemon-cc/src/common/cid.ts`）。

> 这是治理模型最漂亮的一处：**仲裁权不在运营方的数据库里，而在第二张组织的证书里**。后端即使被运营方完全控制，也签不出 Org2 的仲裁签名。
> 反过来，`system` 权力极大（能铸造、能提交结果、能兜底结算），其边界只剩服务器文件权限——这是课程级简化，写在"已知风险"第 8 条。

### 3.3 托管代发

用户私钥不出后端：enroll 后以 AES-256-GCM（`CERT_ENC_KEY` 派生，随机 12B IV + authTag）加密存 `users.fabric_key_enc`；玩家操作时后端解密、用**该用户证书**经 fabric-gateway 签名代发。所以链上看到的确实是"玩家签的"，而不是"后端签的"。生产替代是 HSM/KMS 或客户端签名——签名已被收敛在 `FabricGatewayService` 一处，替换成本不高。

### 3.4 越权防护在两层独立实施

Web 层 `@Roles()` 守卫挡掉非 admin/arbitrator 的 HTTP 调用；链码层 CID 再校验一次。即使后端被绕过（直接拿到 peer 背书），链码仍会拒绝。单测覆盖"非 owner 转移/非 arbitrator 仲裁/非 system 提交结果"的全部拒绝路径。

---

## 4. 链码设计：账本上的业务规则

### 4.1 六条通用纪律（`docs/chaincode-api.md` §0）

| 纪律 | 实现 |
|---|---|
| 确定性 | 无时间/随机/网络；时间 `nowISO` 入参 + `assertISO` 校验 |
| 键空间 | `<DOCTYPE>:<id>`，docType ∈ player / pokemon / item / trade / battle / rand / idemp |
| 规范哈希 | `canonical(obj)` = 递归键排序后 `JSON.stringify`，再 `sha256` —— 链上链下必须字节级一致 |
| 幂等 | 每笔变更交易带 `idemKey`；`idemp:<key>` 已存在则**直接返回首次结果的 JSON**，零副作用 |
| 状态机 | 锁定态拒绝转移/消耗/再锁定（`ASSET_LOCKED`）；`lockRef` 校验"解锁的是不是本单" |
| 事件与错误 | `setEvent(name, payload)`；错误统一 `CODE: message`，CODE 全大写蛇形 |

**为什么用 TypeScript 写链码**：后端也是 TS，`canonical` / `sha256` / `HMAC` 能两边共享同一实现、字节级对齐。在"链上链下要互算哈希"的场景里这是关键选型，不是口味问题。

### 4.2 七类上链文档

| docType | 核心字段 | 状态机 |
|---|---|---|
| `player` | points、wins/losses、rating | 无（余额由 AddPoints 增减） |
| `pokemon` | speciesId、ivs/evs/nature/ability/shiny、bond、ownerId、lockRef、dnaHash | `IDLE` ⇄ `LOCKED_TRADE` / `LOCKED_BATTLE`；`→ RELEASED` |
| `item` | typeId、quantity、ownerId、uri + metadataHash | 同资产锁；IDLE 堆叠自动归一 |
| `trade` | offer/request、manifestHash、双确认 | `OPEN → EXECUTED / CANCELLED / EXPIRED` |
| `battle` | wagerA/B、wagerHash、escrow、result(resultHash + serverSig) | `CREATED → ACTIVE → RESULT_SUBMITTED → {SETTLED, DISPUTED → SETTLED/REFUNDED}` |
| `rand` | commitHash、clientSeed、serverSeed、resultHash、purpose、meta | `COMMITTED → REVEALED → CONSUMED` |
| `idemp` | 首次交易返回值 | 终态 |

两个刻意的**不上链**决定：

- **不存最终能力值**：只存 IV/EV/性格，六项能力值由后端按第三世代公式计算。理由是"可完全推导"，不必重复记账。
- **不存当前 HP**：伤势存 Redis `poke:hp:<pokemonId>`，缺键 = 满血。理由是高频可变、且不属于价值本体。PvP 一律满血出战、赛后不回写。

### 4.3 八个合约的分工

| 合约 | 职责 | 谁调 |
|---|---|---|
| PlayerContract | 建档案、发/扣积分、转分、改段位 | admin / system / 本人 |
| **RandomContract** | 承诺、揭示验证、查询（+ 内部消费） | 后端 / system |
| PokemonContract | 铸造、转移、养成、放生、羁绊 | 本人 / system |
| ItemContract | 铸造、堆叠合并、转移、消耗 | 本人 / system |
| **TradeContract** | 双确认原子交换 | 双方 |
| **BattleContract** | 押注锁定、结果提交、双确认、兜底、仲裁 | system / 双方 / Org2 |
| HistoryContract | 只读查询账本历史（履历） | 任何人（需登录） |
| BreedingContract | 血统繁殖：校验双亲、重算遗传、写子代 | 本人 / system |

### 4.4 TradeContract：一笔交易内完成整套交换

```
CreateTrade  → 逐项校验归属与 IDLE → 只锁发起方的 offer(LOCKED_TRADE, lockRef=tradeId)
            → request 仅预检不锁（否则任何人可用"请求你的资产"锁住你的资产）
             → manifestHash = sha256(canonical(offer,request,from,to))
ConfirmTrade → 先确认方只记 confirmations.from
             → 后确认方在同一笔交易内：换 owner → 划积分 → 解锁 → EXECUTED
```

任一步失败整体抛错回滚，**链上不存在"宝可梦给了、分没付"的中间态**。锁定即防双花：被锁资产再开新单直接 `ASSET_LOCKED`。取消/过期各有交易（`CancelTrade` / `ExpireTrade`）负责解锁；过期由后端查询时惰性触发——**链上不跑定时任务**（确定性纪律），清扫责任在链下，安全性由链上状态机兜住。

道具是**同质堆叠**模型：同 owner 同 typeId 的 IDLE 堆叠合并到最早创建的那堆（发 `ItemMerged`），锁定堆叠不参与。押注部分数量时会拆出确定性 id 的子堆叠 `<parentId>#w<battleId>`，DRAW 时再并回父堆叠。

### 4.5 BattleContract：escrow + 双确认 + 兜底 + 仲裁

```
CreateBattle    校验 wagerHash = sha256(canonical({playerA,playerB,wagerA,wagerB}))
                资产 → LOCKED_BATTLE；积分立刻扣入 escrow；CREATED
ActivateBattle  system → ACTIVE
SubmitResult    system → resultHash + serverSig；RESULT_SUBMITTED
ConfirmResult   双方各一次 → 同交易内原子结算 → SETTLED
SettleBattle    超时兜底（system）
Forfeit         认输/超时/掉线（system）
Dispute         当事人 → DISPUTED（资产保持冻结，不解锁）
Arbitrate       仅 Org2 arbitrator → SETTLED / REFUNDED
```

六个要点：

1. **建单前防改单**：`wagerHash` 由链码重算比对，服务端与中间人都无法偷换押注内容（`WAGER_HASH_MISMATCH`）。
2. **资产与积分同时锁死**：宝可梦/道具 `LOCKED_BATTLE`，积分立即进 escrow。同一资产也不可能同时出现在双方押注里（重复即拒）。
3. **结果不可抵赖**：`resultHash = sha256(canonical(回合日志))`，`serverSig = secp256k1(resultHash)`，只有 system 能提交。
4. **所有路径汇入同一个 `settle()`**：正常 KO、双倒、超时判负、掉线、认输、兜底、仲裁——**规则唯一、无旁路**。这也让"输不起掉线"在账本层面只有一种后果：判负。
5. **仲裁冻结优先**：`Dispute` 置 DISPUTED 且**资产不解锁**（防销赃），只有 Org2 `Arbitrate` 能终局。
6. **易主即断羁绊**：`bond` 铸造 50，**所有权变更一律重置 30**（直接转移/交易/押注被赢走），只有 `BondUp`(system) 能涨，255 截顶；DRAW/REFUND/放生不改动。

---

### 4.6 两个可删除的扩展：履历与血统

两个功能都是**独立合约 + 独立后端模块**，用 `[FEAT:history]` / `[FEAT:breeding]` 成对标记接入点，删起来不影响主流程。

| 扩展 | 链上做什么 | 为什么需要链 |
|---|---|---|
| **宝可梦履历** `HistoryContract` | 只读 `getHistoryForKey('pokemon:<id>')`，把每个版本投影成摘要返回；`summary`（初训家/转手/版本数）在**完整历史**上算，只有时间线受 `maxEntries` 截断 | 历史是账本自带的，运营方改不了；普通数据库只能存"当前值" |
| **血统繁殖** `BreedingContract` | 校验双亲（同 owner/IDLE/等级≥20）→ 消费 `purpose='mint'` 随机事件 → **按 serverSeed 重算子代 IV/性格/闪光再比对** → 扣 200P → 写子代（`parents`/`generation`，`dnaHash` 即血统承诺） | 属性由链码重算，后端改不了；血统绑定双亲与事件，无法伪造 |

两个实现细节值得记：

- `getHistoryForKey` 只能放在 `@Transaction(false)` 里（不同 peer 结果可能不同）；本项目 Fabric 2.5.16 实测返回**新→旧**，链码按首尾时间戳归一化，不依赖方向；peer 必须开启历史库（`CORE_LEDGER_HISTORY_ENABLEHISTORYDATABASE=true`）。
- 繁殖**不引入新状态、不加锁**：整笔交易内完成，并发保护来自"扣积分写同一个 player 键"；把费用改成 0 时该保护会消失。

## 5. 可验证随机数（本项目最"区块链"的部分）

这一节的重点不是"把功能搬到链上"，而是**用链上机制约束链下算力**。

### 5.1 为什么链码不能自己掷骰子

Fabric 采用 **execute-order-validate**：同一笔提案会分别送到 Org1 和 Org2 的 peer **各执行一遍**，只有读写集完全一致的提案才能通过背书。于是：

1. `Math.random()` / `Date.now()` / 网络调用 → 两个 peer 结果不同 → `ENDORSEMENT_POLICY_FAILURE` 或状态分叉；
2. Fabric 里**不存在以太坊那种 blockhash**；交易时间戳由客户端给、区块时间由 orderer 写，都不能当公平随机源。

结论：**链码内零随机**。随机在链下生成，但用链上机制把它焊死：**承诺先于使用上链 → 揭示时链上重算 → 消费由状态机限制为一次性**。

### 5.2 三方职责分离

| 角色 | 是谁 | 能做 | 不能做 |
|---|---|---|---|
| 生成方 | 后端服务（CSPRNG 32 字节） | 生成种子、先提交承诺、事后揭示 | 换种子（揭示会被抓）；单方决定输出 |
| 使用方 | 玩家 | 提供 clientSeed、发起事件 | 预测输出（揭示前看不见 serverSeed） |
| 验证方 | 链码（双组织背书）+ 任何第三方 | 重算 sha256、检查消费一次性 | — |

### 5.3 生命周期

```
serverSeed ← randomBytes(32)                     ← 链下，只有后端知道
commitHash  = sha256(serverSeed)

① Commit(eventId, commitHash, clientSeed, purpose, meta)     → COMMITTED
   【承诺先于任何随机数使用】← 这是整个方案的支点

② 链下派生 rand(n)：决定遇敌种类/等级……（IV/性格/闪光此时不揭晓）

③ RevealAndVerify(eventId, serverSeed)                       → REVEALED
   链上重算 sha256(serverSeed) == commitHash ?
     不等 → SEED_MISMATCH 拒绝，状态不变
     相等 → 落盘 serverSeed，resultHash = sha256(seed|client|eventId)

④ 业务合约消费：MintFromCapture 内部调用 consumeRandom(eventId,'capture',playerId)
   校验 REVEALED + purpose 匹配 + playerId 匹配 → CONSUMED（一次性）
```

**为什么"承诺先于使用"是支点**：承诺一旦上链，后端就失去换种子的能力；玩家拿到 clientSeed 的搅动权，又看不见种子；两者共同决定结果。任何一方单独作恶都会被另一方或验证方发现。

### 5.4 派生流：一次承诺，无限掷点

```
rand(n) = uint64_be( HMAC-SHA256(key = serverSeed,
                                 msg = "clientSeed|eventId|n")[0..8) ) / 2^64
```

- HMAC 而非纯哈希拼接：key 固定为保密的 serverSeed；
- message 绑死 `clientSeed`（玩家搅动）、`eventId`（跨事件不可移植）、`n`（流内序号）；
- 链上锚点 `resultHash = sha256(serverSeed|clientSeed|eventId)` 与该流同源 → 验证 resultHash 就等于验证"这条流确实是承诺的那条"。

**关键工程点：按索引寻址，而不是顺序消耗。** 第 k 次投球的结果只取决于 `(serverSeed, clientSeed, eventId, k)`，与前面掷了多少次无关。于是审计者可以只复核"第 3 次投球"，不必重放整场；玩家也不会"投失几个球把好运消耗掉"。

分块布局（`backend/src/pokemon/capture-derive.ts`，同时经 `GET /fairness/:eventId` 的 `captureLayout` 公开）：

| n 区段 | 用途 | 计算要点 |
|---|---|---|
| 0 | 野生种类 | 区域池加权索引（常见 60 / 少见 30 / 稀有 10，种族值 ≥500 再 ×0.3） |
| 1 | 野生等级 | `zone.minLevel + floor(rand × 带宽)`，只由区域决定，与队伍等级无关 |
| 第 k 次投球：base = 2+(k−1)×10 | +0 捕捉判定、+1..+6 IV 六维、+7 性格、+8 闪光、+9 摇晃次数 | `p = min(1, ((3×maxHP−2×curHP)×catchRate×ballBonus)/(3×maxHP)/255)` |
| 20000 | 野怪个体（IV/性格/闪光） | **开场固定一次，整场与铸造同源**，堵死"投失重刷个体" |
| 30000+(t−1)×16 | 第 t 回合 16 槽 | AI 选招 + 双方各 5 掷点（麻痹/命中/暴击/浮动/追加）+ 平速裁决 + 4 预留 |
| 40000 | 战斗掉落 | +0 是否掉落（20%）、+1 品类（伤药/精灵球/超级球） |

区段隔离是刻意的：**"多打几回合"不会挪动投球判定的槽位**，"多投几个球"也不会改变掉落。区域与付费档位写进 `Commit.meta`（`{"zone":"coast","lureTier":2,"cost":200}`），于是"0 付费的遇敌不可能享受 tier 2 加成"也可被第三方核对。

### 5.5 战斗与捕捉的时序差异

- **捕捉**：`Commit` → 立刻派生预览 → 打到终态/投中时才 `Reveal` 并消费（H9）。失败投球保持 COMMITTED，`/fairness` 对 COMMITTED 裁剪种子，避免首球后预测后续判定。
- **PvP 战斗**：开战 `Commit`，**整场打完才 `Reveal`**。战斗全程 serverSeed 对双方不可见，没人能预测下一次暴击；战后揭示 + 回合日志（`resultHash = sha256(canonical(log))`）让整场可逐步重放复核。
- 战斗种子额外在 Redis `battle:seed:<battleId>` 备份 24h，防止后端崩溃导致**永远无法揭示 → 无法结算**（揭示是结算的前置）。

### 5.6 能论证的安全性质

| 性质 | 机制 |
|---|---|
| 防预测 | 32 字节 CSPRNG；揭示前只有 sha256 承诺上链 |
| 防生成方操纵 | 承诺先于使用 + clientSeed 搅动 + 链上重算（`SEED_MISMATCH`） |
| 防使用方操纵 | 玩家拿不到 serverSeed，只能搅动不能决定 |
| 防篡改 | 承诺/揭示/消费全程上链 + 双组织背书 |
| 防重放 | eventId 唯一 + 三态状态机 + idemKey + 一次性消费 |
| 可审计 | `/fairness` 用 Web Crypto 独立重算，**不依赖后端结论，只用后端证据** |
| 不可抵赖 | resultHash + secp256k1 签名上链，双方 ConfirmResult 即链上认可 |

### 5.7 必须承认的局限

1. **后端在揭示前看得见种子**——承诺-揭示保证"不能换、必须揭示"，不保证"没偷看"（内幕者可预知结果）。
2. **拒绝揭示**：后端可以永不揭示（代价是铸造/结算走不下去，且 COMMITTED 记录永久留痕）。
3. **单生成方**：本质是"可审计的中心化随机"，不是去中心化随机。
4. 浮点 2⁻⁵³ 粒度损失（对游戏无实际影响）。

升级路线已在架构上预留，改造点收敛在两处：**链码 `RandomContract`**（状态机骨架不变，只换承诺内容与验证逻辑）与 **`ChainAdapter` 抽象**（Fabric/Mock 同步演进，业务层无感）：P1 drand 混合熵 → P2 VRF 替换派生基值 → P3 双方掷币/阈值签名。

---

## 6. 链上 / 链下边界

| 维度 | 上链 | 链下 |
|---|---|---|
| 账号口令 | 无口令概念 | PG + argon2 |
| 资产确权 | ownerId + 状态机 + 锁定 | 展示缓存（Redis 5s） |
| 价值转移 | 双确认原子交换、escrow | DTO 组装、过期清扫触发 |
| 随机公平 | 承诺/揭示/消费状态机 | CSPRNG 生成、HMAC 派生、种子暂存 |
| 战斗判定 | 结果哈希 + 签名 + 双确认 | **整套回合制引擎**、30s/60s 计时、回合日志 |
| 资源文件 | `uri + metadataHash` | MinIO 本体；前端 sha256 校验失败回退占位图 |
| 留痕 | 链事件（不可抵赖） | `audit_logs`（可检索）——双轨审计 |
| 隐私 | 只放玩家 ID 与游戏数值 | 好友、黑名单、聊天、房间、会话 |

**为什么战斗必须链下**：一场战斗上百个掷点、每秒多次状态更新，全上链等于把实时战斗塞进 2 秒出块的账本。所以采用"链上锚定"：随机承诺上链 → 链下算 → 结果哈希+签名上链 → 事后可完整重放复核。这是性能与可验证性之间唯一现实的折中。

---

## 7. 双链模式：ChainAdapter

`ChainAdapter`（`backend/src/fabric/chain.adapter.ts`）是一个**与链码交易一一对应**的接口，两个实现：

| 实现 | 世界状态存哪 | 用在哪 |
|---|---|---|
| `FabricChainAdapter` | 真 Fabric + CouchDB | `FABRIC_MOCK=false`，答辩"真链"环节 |
| `MockChainAdapter`（约 1500 行） | Redis 前缀 `mockchain:*` | 默认 `true`，课堂演示、单测、CI |

它不是空壳假实现：**完整复刻链码语义**——真实 sha256/HMAC、锁定、escrow、幂等、承诺-揭示、堆叠合并；状态存 Redis，所以 seed 进程 / API 进程 / 重跑共享同一份账本。因此：

- 课堂演示不起 Fabric，25 项 e2e 断言照样全绿；
- 改链码行为时，Mock 与两边测试必须同步改（纪律见 `AGENTS.md` 决策 6）；
- 演示结论可以迁移到真链，因为语义是对齐的。

代价：Mock 是真链行为的"影子账本"，需要长期同步维护——这是本项目最重的工程债，也是它能在教室环境稳定演示的原因。

---

## 8. 三条主线，从链的视角重讲

**注册**：argon2 建用户 → CA register+enroll（`role=player` 入 ecert，`hf.EnrollmentID=用户名`）→ 私钥 AES-GCM 存 PG → `RegisterPlayer`（admin 代发，idemKey=`register-<username>`）→ 链上 points=400、rating=1000，并带 72 小时转账锁（防小号搬分）。

**捕捉**：`Commit`（承诺上链）→ 派生种类/等级（预览，不揭 IV）→ 野怪战斗（整场读 30000 区）→ 投球（`ConsumeItem` 扣球）→ 结算时 `RevealAndVerify`→ 判定 → 成功则 `MintFromCapture`（内部 `consumeRandom` 一次性消费 + dnaHash）→ 掉落走 `MintItem`（确定性 idemKey `<sessionId>-drop`）。

**押注对战**：
```
建房(Redis) → 双方确认 → wagerHash → CreateBattle(锁资产 + 扣 escrow)
→ ActivateBattle → 战斗 Commit → 引擎跑（serverSeed 全程保密）
→ Reveal + SubmitResult(resultHash + serverSig)
→ 双 ConfirmResult 原子结算 ／ 超时 SettleBattle 兜底 ／ Dispute → Org2 Arbitrate
```
最后这排斜杠的含义是：**所有异常路径都通向同一个 `settle()`**。

---

## 9. 安全与已知边界

### 9.1 链上侧的关键防线

| 威胁 | 防护 |
|---|---|
| 双花 | 资产进入交易/押注即锁定；积分建单即入 escrow |
| 重放 | `idemKey` 幂等 + 各实体 id 唯一性检查 + 随机三态状态机 |
| 溢出/负数 | 数量/积分/经验全为非负整数，`Number.isSafeInteger` 统一收口 |
| 越权 | Web 守卫 + 链码 CID 双层 |
| 部分结算 | 结算全部在单笔交易内，失败整体回滚 |
| 永久锁定 | 交易有过期、对战有 2min 兜底与仲裁退款，任何对局必然终止 |

### 9.2 诚实清单（课程的边界）

1. 用户私钥后端托管（AES-256-GCM + DB），未用 HSM/KMS，`CERT_ENC_KEY` 缺省有开发回退值；
2. 后端揭示前可见 serverSeed；单生成方随机；
3. 单节点 orderer、每组织单 peer，无容错，纯演示拓扑；
4. 默认口令/密钥明文出现在 compose 与配置（CA admin/adminpw、PG、JWT dev 值）；
5. 防重放/限流在 Redis 宕机时 **fail-open**（可用性优先）；
6. TypeORM `synchronize=true`，无迁移；
7. 战斗引擎状态在内存，后端崩了当局无法续打 → 走 Dispute/仲裁退款；
8. `system` 身份权力大，保护 = 服务器文件权限；
9. 刷分/小号互打只能事后审计，无主动风控；
10. 宝可梦形象与名称版权：仅课程演示，仓库不含版权素材。

### 9.3 已识别的扩展方向

| 方向 | 解决什么 | 接入点 |
|---|---|---|
| PDC 私有数据集合 | 隐藏阵容 / 押注明细 | `RandomContract` 与集合配置 |
| VRF / drand / 双方掷币 | 把"可审计的中心化随机"推向可验证随机 | `RandomContract` + `ChainAdapter` |
| 链码级细化背书 | 例如 `Arbitrate` / 结算类交易仅 Org2 背书 | `deployCC.sh` 的 `--signature-policy` |
| 多节点 Raft、每组织多 peer | 容错与高可用 | `configtx.yaml` |

---

## 10. 代码地图

| 想理解什么 | 看哪里 |
|---|---|
| 链码通用纪律（幂等/键空间/身份/状态） | `chaincode/pokemon-cc/src/common/{idempotency,state,cid,crypto,keys,bundle}.ts` |
| 八个合约 | `chaincode/pokemon-cc/src/contracts/*.contract.ts`（先看 `battle`、`random`、`breeding`） |
| 网络与背书策略 | `network/configtx.yaml` + `scripts/up.sh` + `scripts/deployCC.sh` |
| 后端怎么代发交易 | `backend/src/fabric/{contract.service,chain.adapter,fabric-gateway.service,fabric-ca.service}.ts` |
| Mock 复刻了什么 | `backend/src/fabric/mock-chain.adapter.ts` + `mock-chain.store.ts` |
| 随机流派生布局 | `backend/src/pokemon/capture-derive.ts` + `docs/randomness.md` §3 |
| 数据模型与交易契约 | `docs/chaincode-api.md` |
| 答辩用论证 | `docs/architecture.md` §3/§4/§5/§6、`docs/security.md` §2/§4、`docs/randomness.md` §5 |
| 环境复刻 | `docs/setup.md`、`docs/deployment.md` |

---

## 11. 两处文档小漂移（以代码为准）

- `docs/architecture.md` §3.2 写"CouchDB 索引四张"，实际是 **5 张**（多一张 `indexItemStacks`，供堆叠合并富查询）。
- `docs/architecture.md` §7 的目录树写 `tests/ Jest 60 用例`，当前实测为 **88 用例 / 8 套**（其余计数以 `AGENTS.md` 的"本轮验证"为准）。

按仓库纪律"文档与代码不一致时以代码为准"，遇到细节追问一律回源码核对。
