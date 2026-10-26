# PokeChain 的区块链逻辑

本文只讲一件事：**这个项目里，链上记录什么、每类操作在链上怎么走、为什么这么切分。**
细节契约见 `docs/chaincode-api.md`，随机数论证见 `docs/randomness.md`。

## 1. 链上记录什么

只有 7 类数据，全部是 `<类型>:<id>` 的键：

| 键 | 内容 | 关键字段 |
|---|---|---|
| `player:<id>` | 玩家账户 | points、wins、losses、rating |
| `pokemon:<id>` | 宝可梦 | speciesId、ivs、evs、nature、bond、ownerId、status、lockRef |
| `item:<id>` | 道具堆叠 | typeId、quantity、ownerId、status、uri、metadataHash |
| `trade:<id>` | 交易单 | 双方、offer、request、manifestHash、confirmations |
| `battle:<id>` | 对战单 | 双方押注、wagerHash、escrow、result、status |
| `rand:<id>` | 随机事件 | commitHash、clientSeed、serverSeed、resultHash、status |
| `idemp:<key>` | 幂等记录 | 首次交易的返回值 |

不记录：当前 HP、能力值、战斗日志、房间、会话、聊天、图片本体、口令。

判断标准：**会易主或有价值 → 上链；能由链上数据算出来 / 每秒在变 / 没人拿它主张权利 → 不上链。**

## 2. 一笔交易在链上怎么走

1. 应用把交易提案发给两个 peer；
2. **两个 peer 各自执行一遍链码**，各算出一份"读了哪些键、要写什么值"，并签名（这叫背书）；
3. 提案连同两份签名交给 orderer；
4. orderer 排序，打包成区块（2 秒一个块）；
5. 区块发回 peer，peer 检查签名数量够不够、读写集有没有冲突，通过才写入世界状态。

由此产生三条硬约束，链码必须遵守：

- 双方都要签名 → 默认背书策略是两组织多数，单方写不进账本；
- 两个 peer 的执行结果必须一致 → 链码里不能用 `Math.random()`、`Date.now()`、网络调用；
- 同一个键被并发修改时后到的交易会失败 → 状态机必须自己防冲突（锁定、幂等）。

## 3. 各类操作的链上步骤

### 3.1 注册

1. 后端建账号（PG 存口令哈希）；
2. 后端向 ca.org1 申请证书，证书里带属性 `role=player`；
3. 私钥加密存 PG；
4. 后端用 admin 证书发 `RegisterPlayer`，链上生成 `player:<id>`，points=1000。

### 3.2 捕捉（一次遇敌 = 1 个随机事件 + 若干交易）

1. 后端生成 serverSeed，算 `commitHash=sha256(serverSeed)`；
2. 发 `Commit`，链上写 `rand:<eventId>`，状态 COMMITTED；
3. 后端用派生流算出野怪种类/等级，返回给前端；
4. 打野怪、投球时：`ConsumeItem` 扣球；
5. 首次投球前发 `RevealAndVerify`，链上重算 `sha256(serverSeed)==commitHash`，通过则状态 REVEALED；
6. 捕捉成功发 `MintFromCapture`，链码内部把该随机事件标为 CONSUMED，同时生成 `pokemon:<id>`，owner 是玩家。

要点：**先承诺、后使用、再揭示**。铸造必须消费同一个随机事件，一个事件只能消费一次。

### 3.3 交易

1. `CreateTrade`：校验双方资产归属和 IDLE 状态，全部锁成 `LOCKED_TRADE`（lockRef=交易单 id）；
2. 甲方 `ConfirmTrade`：只记 confirmations.from；
3. 乙方 `ConfirmTrade`：在同一笔交易里换 owner、划积分、解锁、置 EXECUTED；
4. 取消或过期：`CancelTrade` / `ExpireTrade` 解锁资产。

任一步失败整笔回滚，不会出现"资产给了、积分没付"。

### 3.4 押注对战

1. 后端在 Redis 建房、双方各自确认押注；
2. 后端算 `wagerHash=sha256(canonical({playerA,playerB,wagerA,wagerB}))`；
3. `CreateBattle`：链码重算 wagerHash 比对，资产锁成 `LOCKED_BATTLE`，积分从双方余额扣进 escrow；
4. `ActivateBattle`：CREATED → ACTIVE；
5. 开战时 `Commit` 战斗随机种子，整场战斗用这条派生流，种子对玩家不可见；
6. 打完：`RevealAndVerify` 揭示种子，`SubmitResult` 提交 `resultHash=sha256(回合日志)` 和服务端签名；
7. 双方各发一次 `ConfirmResult`，第二笔里原子结算；
8. 异常分支：
   - 30 秒不行动 → `Forfeit`（判负）
   - 掉线 60 秒 → `Forfeit`
   - 提交结果后 2 分钟不确认 → `SettleBattle`（system 兜底，按已提交结果结算）
   - 双方同时倒 → `SubmitResult('DRAW')`，各回各家
   - 有异议 → `Dispute`，资产保持锁定；只有 Org2 的 `Arbitrate` 能给出终局（判胜/平局/退款）

所有分支最终都调链码里同一个 `settle()`，规则只有一套。

### 3.5 积分

- 只有 admin / system 能通过 `AddPoints` 增减，每笔记 `reason`；
- 玩家之间转分用 `TransferPoints`，必须本人签名；
- 押注的积分在 `CreateBattle` 时就扣进 escrow，结算时才划给赢家。

## 4. 随机数：链上做什么，链下做什么

链码不能生成随机数（两个 peer 结果会不一致），所以随机数在链下生成，链上做三件事：

| 步骤 | 谁做 | 内容 |
|---|---|---|
| 承诺 | 链上 | 存 `commitHash=sha256(serverSeed)`，此时种子不公开 |
| 派生 | 链下 | `rand(n)=HMAC-SHA256(serverSeed, "clientSeed|eventId|n")` 前 8 字节转 [0,1) |
| 揭示 | 链上 | 收到 serverSeed 后重算 sha256，不等于 commitHash 就拒绝 |
| 消费 | 链上 | 铸造/结算时校验该事件已揭示、purpose 与 playerId 匹配，然后标 CONSUMED |

状态机：`COMMITTED → REVEALED → CONSUMED`，只前进，不可复用。

这样能验证三件事：

1. 揭开的种子确实是当初承诺的那个（sha256 对得上）；
2. 结果确实来自这个种子（resultHash 对得上）；
3. 同一个随机事件没有被用两次（只能消费一次）。

任何人都能拿 `/fairness/:eventId` 返回的数据自己重算，不需要相信后端。

链上解决不了的：后端在揭示前能看到种子；后端可以不揭示（但那样铸造和结算都走不下去）。

## 5. 谁有权做什么

权限写在证书里（CA 属性 `role`），链码用 `getMSPID()` + `getAttributeValue('role')` 校验。

| 角色 | 组织 | 能做的事 |
|---|---|---|
| player | Org1 | 转移自己的资产、确认交易、确认结果、发起争议 |
| admin | Org1 | 建账户、发积分、铸道具、改角色 |
| system | Org1 | 揭示种子、铸造宝可梦、建对局、提交结果、兜底结算 |
| arbitrator | **Org2** | 只能仲裁 |

`arbitrator` 必须是 Org2 组织的证书。运营方即使控制了后端，也签不出这个签名。

## 6. 状态机

```
宝可梦 / 道具：IDLE ⇄ LOCKED_TRADE / LOCKED_BATTLE，宝可梦另有 RELEASED
交易单：      OPEN → EXECUTED / CANCELLED / EXPIRED
对战单：      CREATED → ACTIVE → RESULT_SUBMITTED → SETTLED
                                                   ↘ DISPUTED → SETTLED / REFUNDED
随机事件：    COMMITTED → REVEALED → CONSUMED
```

锁定状态下不能转移、不能消耗、不能被第二笔交易再锁。

## 7. 链上 / 链下分工

| 上链 | 链下 |
|---|---|
| 资产归属和锁定状态 | 战斗逐回合计算、命中、伤害 |
| 积分余额、押注托管 | 捕捉会话、房间、匹配队列 |
| 随机数承诺、揭示值、结果哈希 | 种子生成、派生计算、种子暂存 |
| 交易单、对战单、双确认 | 战斗日志、审计日志、聊天、好友 |
| 道具的 uri + hash | 图片音频本体 |
| 链上事件 | 排行榜、缓存、限流、防重放 |

一句话：**链上记录"谁拥有什么、发生过什么、结果是什么"；链下负责算、负责展示、负责临时状态。**

## 8. 这套设计的边界

1. 玩家私钥由后端保管，后端泄露等于身份全部泄露；
2. 后端揭示前能看到随机种子，也知道战斗掷点；
3. 单 orderer、每组织单 peer，没有容错；
4. 防重放和限流依赖 Redis，Redis 挂了就放开（可用性优先）；
5. 战斗引擎状态在内存，后端崩溃后这一局无法继续，只能仲裁退款。

## 9. 看代码的位置

| 内容 | 文件 |
|---|---|
| 链码通用逻辑（幂等、状态、权限） | `chaincode/pokemon-cc/src/common/` |
| 六个合约 | `chaincode/pokemon-cc/src/contracts/` |
| 网络与背书策略 | `network/configtx.yaml`、`scripts/deployCC.sh` |
| 后端如何发交易 | `backend/src/fabric/chain.adapter.ts`、`fabric-gateway.service.ts` |
| 随机数派生布局 | `backend/src/pokemon/capture-derive.ts` |
| 无链模式（Mock） | `backend/src/fabric/mock-chain.adapter.ts` |
