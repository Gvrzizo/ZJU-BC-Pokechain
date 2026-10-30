# 交易背书、证书与角色（以一次 `ConfirmTrade` 为例）

> 配套：`docs/chaincode-api.md`（合约）、`docs/security.md` §1（身份）、`network/configtx.yaml`（策略）
> 本文所有结论都在本机真链上实测过，命令附在 §6。

## 1. 先看策略：三层，本项目只在通道级定义

| 层级 | 定义位置 | 本项目取值 | 实际含义 |
|---|---|---|---|
| **通道级** `Application.Endorsement` | `network/configtx.yaml` 的 `ApplicationDefaults` | `MAJORITY Endorsement` | 两组织各一票 → **2/2**，Org1 和 Org2 都必须背书 |
| **组织级** `Org1MSP.Endorsement` | 同上 `Organizations` | `OR('Org1MSP.peer')` | 该组织**任意一个 peer** 签名即代表这个组织 |
| **链码级** | 链码定义的 `validation_parameter` | 指向 `/Channel/Application/Endorsement` | 没自定义，**继承通道默认 2/2** |
| key 级（SBE） | `SetStateValidationParameter` | **未使用** | 可扩展：让 `rand:*`、`battle:*` 单独要求 Org2 |

实测链码定义：

```bash
peer lifecycle chaincode querycommitted -C gamechannel -n pokemoncc --output json
# "validation_parameter": "EiAvQ2hhbm5lbC9BcHBsaWNhdGlvbi9FbmRvcnNlbWVudA=="
```

把这段 base64 解开就是 `/Channel/Application/Endorsement`：

```bash
echo EiAvQ2hhbm5lbC9BcHBsaWNhdGlvbi9FbmRvcnNlbWVudA== | base64 -d
# /Channel/Application/Endorsement
```

所以本项目是**通道默认策略、双组织都必须签**，没有做链码级或 key 级的收紧。

## 2. 一个常见误解：只连一个 peer ≠ 只有一个组织背书

后端配置里只有一个端点：

```yaml
FABRIC_PEER_ENDPOINT: peer0.org1.pokechain.com:7051
```

但 2/2 依然被满足，因为客户端调用的不是"这个 peer 自己"，而是 peer 上的 **Fabric Gateway 服务**（`/gateway.Gateway/Endorse`）：

```
后端 ──gRPC/TLS──▶ peer0.org1 的 Gateway 服务
                        │ 1) 本地执行一次链码
                        │ 2) 用服务发现找到策略要求的其他组织 peer
                        │ 3) 转发提案 → peer0.org2 执行并签名
                        ▼
                   聚合 2 个背书，返回给后端
```

实测证一个区块里的交易有 2 个背书（命令见 §6）。**推论**：停掉 `peer0.org2` 后写路径会失败（凑不齐 2/2），读路径仍然可用——这就是"双组织背书"的代价与含义。

## 3. 证书与角色

### 3.1 两套证书，别混

| 证书 | 证明什么 | 谁验 | 配置位置 |
|---|---|---|---|
| **TLS 证书** | "你连的这台机器确实是 peer0.org1" | 客户端的 `tls/ca.crt` | `FABRIC_PEER_TLS_CERT_PATH` |
| **ECert（签名证书）** | "这笔交易是**这个人**签的" | peer 的 MSP（用组织根 CA 验签） | MSP 目录 / 用户证书 |

TLS 保证通道加密和服务器身份；ECert 保证交易身份。两者都由组织 CA 体系签发，但用途完全不同。

### 3.2 证书里有什么，链码读什么

```
ECert = 公钥 + 主体信息(CN/OU) + 有效期 + 签发者签名
      + 属性(attrs)
```

本项目只依赖两个属性：

| 属性 | 来源 | 链码怎么用 |
|---|---|---|
| `hf.EnrollmentID` | CA register 时的 `enrollmentID` | **认人**：`getEnrollmentId(ctx)` 必须等于 `playerId` |
| `role` | register 时 `attrs: [{name:'role', ecert:true}]` | **认权限**：`player / admin / system / arbitrator` |

```ts
// chaincode/pokemon-cc/src/common/cid.ts
ctx.clientIdentity.getMSPID()                      // Org1MSP / Org2MSP
ctx.clientIdentity.getAttributeValue('role')       // player/admin/system/arbitrator
ctx.clientIdentity.getAttributeValue('hf.EnrollmentID')  // 用户名
```

改角色只能重签证书（或 admin 走 `GrantRole` 改链上 `Player.role` 供业务读）；后端改不了证书内容。

### 3.3 四种身份从哪来、能签什么

| 身份 | 证书从哪来 | 存哪 | 能签的交易 | 组织 |
|---|---|---|---|---|
| **player** | `ca.org1` register+enroll（注册时自动） | PostgreSQL `users.fabric_key_enc`（AES-256-GCM） | Transfer / ConfirmTrade / ConfirmResult / Dispute / Breed | Org1MSP |
| **admin** | 种子脚本或手工 | 同 player（但多数 admin 接口实际用 system 证书提交） | RegisterPlayer / GrantRole / AddPoints / MintItem | Org1MSP |
| **system** | `./scripts/enroll-system.sh` | `backend/.fabric-certs/system-*.pem`（0600） | RevealAndVerify / MintFromCapture / CreateBattle / SubmitResult / SettleBattle | Org1MSP |
| **arbitrator** | 需向 `ca.org2` 单独 enroll | 同 player 机制 | **仅 Arbitrate** | **Org2MSP** |

`requireArbitrator` 同时校验组织和角色：

```ts
assertMsp(ctx, 'Org2MSP');
requireRole(ctx, 'arbitrator');
```

所以运营方控制后端也签不出仲裁签名——这是"裁判独立"的技术落点。

### 3.4 两层校验，互不替代

| 层 | 校验 | 代码 |
|---|---|---|
| Web | JWT + `@Roles('admin')` 等 | `common/guards/{jwt-auth,roles}.guard.ts` |
| 链码 | CID：组织 / 角色 / EnrollmentID | `common/cid.ts`、`common/state.ts::assertCallerIsPlayer` |

即使有人绕过 HTTP 直接拿 peer 背书，链码仍会拒绝。反过来，链码通过也不代表 Web 层可信——两层各管一段。

## 4. 一次交易的全流程：B 确认交易

场景：A 发起交易单 `t_1`（A 给一只宝可梦，B 给 50 积分）。`CreateTrade` **只锁了 A 的 offer**（`LOCKED_TRADE`），B 的宝可梦仍是 `IDLE`，现在 B 点"确认"。

```
① 浏览器 ──▶ ② NestJS ──▶ ③ 取证书 ──▶ ④ Gateway ──▶ ⑤ 两个 peer ──▶ ⑥ orderer ──▶ ⑦ 提交验证 ──▶ ⑧ 写账本
```

| # | 谁 | 做什么 | 用什么证书 | 读到/写了什么 |
|---|---|---|---|---|
| 1 | 前端 | 点"确认" → `POST /api/v1/trades/t_1/confirm`，带 `Authorization: Bearer <JWT>` 与 `X-Nonce`/`X-Timestamp` | — | 请求体只有交易单 id |
| 2 | 后端 | JWT 校验、防重放、确认 B 是交易当事人；生成 `idemKey` 与 `nowISO` | — | — |
| 3 | 后端 | 从 `users.fabric_key_enc` 解出 B 的证书与私钥（AES-256-GCM，`CERT_ENC_KEY`） | **B 的 ECert** | — |
| 4 | 后端 | 建 gRPC 连接：TLS 到 `peer0.org1:7051`，用 org1 的 `tls/ca.crt` 校验 | TLS 客户端 | — |
| 5 | 后端 | 发提案：channel `gamechannel`、chaincode `pokemoncc`、fn `ConfirmTrade`、args `[t_1, B, nowISO, idemKey]` | B 的私钥签名 + B 的证书作为 identity（mspId=Org1MSP） | — |
| 6 | peer0.org1 | 执行链码。链码内部：<br>• `requireNonEmpty`/`assertISO` 校验参数<br>• `loadTrade(t_1)`，要求 `status=OPEN` 且未过期<br>• 校验调用者是 `fromId` 或 `toId`（`NOT_PARTY`）<br>• 若双方都确认 → 同交易内换 owner、划积分、解锁、`status=EXECUTED` | — | **读** trade、pokemon、item、player；**写**这些键的新值 |
| 7 | peer0.org1 的 Gateway | 按 2/2 策略用服务发现找到 Org2 的 peer，转发提案，收集第二个背书；两边读写集必须一致 | — | — |
| 8 | 后端 → orderer | 把 `{提案响应, 2 个背书}` 提交到 `orderer:7050` | — | orderer 只排序、打包（2 秒一批） |
| 9 | 两个 peer | 收到区块后**独立验证**：① 2/2 背书是否满足 ② 读写集 MVCC 是否冲突 | — | 通过则有效（VALID），冲突则整笔作废 |
| 10 | 两个 peer | 写世界状态（CouchDB）：宝可梦 `ownerId` 变 B、A 的宝可梦 bond 重置 30、积分划转、资产 `IDLE`、trade `EXECUTED` | — | 发 `TradeConfirmed` / `TradeExecuted` 事件 |
| 11 | 后端 | 拿到 commit status=`VALID` 后返回前端；前端刷新列表 | — | — |

关键点：**第 6 步只是"模拟执行"**，第 9 步才是"真的生效"。链码返回成功但第 9 步验证失败时，账本不会变——这正是"前端调后端 ≠ 上链"的原因。

## 5. 失败时谁负责

| 失败点 | 报错 | 账本是否已变 |
|---|---|---|
| 没有 JWT | `UNAUTHORIZED: missing bearer token` | 否 |
| 角色不够（如非 admin 调 admin 接口） | 403 `FORBIDDEN` | 否 |
| 不是交易当事人 | 链码 `NOT_PARTY` | 否 |
| 资产已被锁定/交易过期 | `ASSET_LOCKED` / `TRADE_EXPIRED` | 否（整笔回滚） |
| 积分不足 | `INSUFFICIENT_POINTS` | 否（整笔回滚） |
| 任一组织 peer 不可用 | `ENDORSEMENT_POLICY_FAILURE` 或背书收集失败 | 否 |
| 并发改同一资产 | `MVCC_READ_CONFLICT`（提交验证失败） | 否（另一笔已生效） |
| 网络超时 | 网关超时；`idemKey` 保证重试不重复执行 | 取决于是否已提交 |

## 6. 自己验证这几件事

```bash
cd ~/programs_mine/ZJU-BC-Pokechain
source scripts/common.sh && switchOrg 1

# ① 链码的有效策略（应指向 /Channel/Application/Endorsement）
peer lifecycle chaincode querycommitted -C gamechannel -n pokemoncc --output json | jq -r .validation_parameter | base64 -d; echo

# ② 通道级策略（Endorsement 应为 MAJORITY）
peer channel fetch config /tmp/cfg.pb -c gamechannel -o localhost:7050 --tls --cafile "$ORDERER_CA"
network/bin/configtxlator proto_decode --input /tmp/cfg.pb --type common.Block --output /tmp/cfg.json
jq -c '.data.data[0].payload.data.config.channel_group.groups.Application.policies.Endorsement' /tmp/cfg.json

# ③ 最近一个区块里每笔交易的背书数量（应为 2）
H=$(peer channel getinfo -c gamechannel | sed 's/^Blockchain info: //' | jq -r .height)
peer channel fetch $((H-1)) /tmp/blk.pb -c gamechannel -o localhost:7050 --tls --cafile "$ORDERER_CA"
network/bin/configtxlator proto_decode --input /tmp/blk.pb --type common.Block --output /tmp/blk.json
jq -r '.data.data[] | .payload.data.actions[]? | (.payload.action.endorsements | length)' /tmp/blk.json

# ④ 实验（可选）：停掉 Org2 的 peer，再提交一笔写交易
docker stop peer0.org2.pokechain.com
#   预期：写失败（凑不齐 2/2），读仍然可用
docker start peer0.org2.pokechain.com
```

## 7. 与本项目其它部分的对应关系

| 概念 | 代码位置 |
|---|---|
| 策略定义 | `network/configtx.yaml` |
| 链码安装与 commit | `scripts/deployCC.sh` |
| 证书签发（玩家） | `backend/src/fabric/fabric-ca.service.ts` |
| 证书托管与解密 | `backend/src/common/utils/secret-box.util.ts`、`users.fabric_key_enc` |
| 交易提交 | `backend/src/fabric/fabric-gateway.service.ts`、`fabric-chain.adapter.ts` |
| 身份与权限校验 | `chaincode/pokemon-cc/src/common/cid.ts`、`state.ts` |

## 8. 文字版说明（可直接用于报告/答辩稿）

交易背书（endorsement）在这套系统里不是"某个人点同意"，而是"指定的组织各自把同一笔交易在链码上跑一遍，并对结果签名"。Fabric 采用先执行、后排序、再验证的模型，因此需要先由背书节点模拟执行、产出读写集（读集是这次读了哪些键，写集是准备把这些键改成什么），再把读写集和签名一起交给排序服务。这样做的前提是同一笔交易在所有背书节点上的执行结果必须完全一致，所以链码里不能有随机数、系统时间和网络调用——这也是本项目随机数方案必须把种子放在链下、只把承诺上链的根本原因。

策略层面本项目用了三层里的两层。通道级 `Application.Endorsement` 是 MAJORITY，两个组织下等于 2/2，也就是 Org1 和 Org2 都必须提供背书；组织级 `Org1MSP.Endorsement` 是 `OR('Org1MSP.peer')`，意味着每个组织内部任意一台 peer 签名就能代表这个组织，所以"加同组织的 peer"只增加冗余、不提高门槛，真正提高门槛的是加组织。链码定义里没有单独设置背书策略，`validation_parameter` 直接指向 `/Channel/Application/Endorsement`，继承通道默认，这一点可以用 `querycommitted` 查到，把 base64 解开即可验证。项目没有使用 key 级背书（SBE），所以不能只对某个键（例如随机事件）单独要求 Org2，这属于可扩展但当前未做的部分。

这里有个容易被误解的地方：后端只配置了一个 peer 端点 `peer0.org1:7051`，看上去像是只有 Org1 在背书。实际上客户端连的是这个 peer 上的 Fabric Gateway 服务，Gateway 会先在本地执行一次链码，然后根据背书策略用服务发现找到 Org2 的 peer，把提案转发过去执行并收集签名，最后把两个背书一起返回。拆开最近一个区块可以看到，其中的交易确实带有两个背书。换句话说，"客户端只连一个 peer"不等于"只有一个组织背书"；但 2/2 的代价也很直接——Org2 的 peer 不可用时写路径凑不齐背书，交易会被拒绝，读路径不受影响。

证书这一侧要区分两套。TLS 证书证明"你连的这台机器确实是 peer0.org1"，用来加密 gRPC 并防止中间人；ECert（签名证书）证明"这笔交易是哪个用户签的"。ECert 由 Fabric CA 在注册时签发，除公钥和主体信息外，还写了两个链码依赖的属性：`hf.EnrollmentID` 是用户名，链码用它认人；`role` 是角色，链码用它认权限。peer 用组织根 CA 校验签名链，确认证书确实属于 Org1MSP 或 Org2MSP，再把 mspId 和属性交给链码。因此链码里实际是两层校验：背书策略决定"哪些组织必须签"，CID（ClientIdentity）决定"这个签名的人有没有权限做这件事"，两者不能互相替代——策略满足只说明组织同意，不代表调用者有权。

拿一次具体交易走一遍。假设 A 创建了交易单 `t_1`，把一只宝可梦给 B、B 给 A 五十积分。创建时**只把 A 的 offer 锁成 `LOCKED_TRADE`**，B 的宝可梦保持 `IDLE`（创建时只对 request 做存在性、归属和 IDLE 的预检，不锁），所以 B 期间仍可自由使用自己的资产。B 在页面上点确认，前端带 JWT 和防重放头请求后端；后端先校验会话与角色、确认 B 是交易当事人，再从数据库解出 B 的证书与私钥（私钥以 AES-256-GCM 加密存储，主密钥是 `CERT_ENC_KEY`），用它构造提案：通道 `gamechannel`、链码 `pokemoncc`、函数 `ConfirmTrade`、参数是交易单号、B、时间戳与幂等键，并用 B 的私钥签名。提案经 TLS 发到 peer0.org1 的 Gateway 服务，peer 执行链码：校验参数与时间格式，读出交易单，要求状态为 `OPEN` 且未过期，确认调用者确实是 from 或 to；如果双方都已确认，就在同一笔交易里更换 owner、划转积分、解锁资产、把状态改为 `EXECUTED`，同时产出一条 `TradeExecuted` 事件。需要注意，此时链码并没有改动账本，只是给出了"如果按当前状态执行，会改成这样"。

接下来 Gateway 按 2/2 策略收集第二个背书：通过服务发现找到 Org2 的 peer，把同一份提案转发过去执行。两个 peer 各自算出的读写集必须完全一致，否则说明链码不确定或状态不一致，交易直接失败。拿到两个签名后，后端把"提案响应加两个背书"提交给 orderer；orderer 不执行链码，只负责排序并打包成区块（本项目配置为两秒一批）。区块再广播回两个 peer，每个 peer 独立验证两件事：一是背书是否满足策略，也就是两个组织的签名都在；二是读写集有没有冲突，也就是这笔交易读过的键在它之前是否被别的交易改过。两项都通过，交易才算有效，世界状态才真正更新，前端这时才会看到成功；任何一项不通过，账本保持原样。

失败时的责任是分层的：没有 JWT 由 Web 层拒绝；不是当事人由链码抛 `NOT_PARTY`；资产锁定或交易过期由状态机拒绝；积分不足整笔回滚；某个组织的 peer 不可用会卡在背书收集；两个请求并发修改同一只宝可梦时，后提交的那笔会在验证阶段因为读写冲突作废。这些情况下账本都不会出现"改了一半"的状态，因为写集要么整体生效、要么整体丢弃。也正因为如此，幂等键和锁定状态机在这套设计里是必需项，而不是可选优化。

最后要说清楚背书能证明什么、不能证明什么。它能证明：这笔交易确实由策略要求的组织各自执行过，执行结果一致、签名完整，运营方无法单方面改写账本，也无法单方面升级链码（`LifecycleEndorsement` 同样是 MAJORITY）。它不能证明：业务逻辑本身正确、随机数公平（后者要靠承诺-揭示与链上重算）、或者用户私钥没有被托管方滥用（本项目私钥托管在后端，属于课程取舍，生产应换 HSM 或客户端签名）。这些边界在 `docs/security.md`、`docs/randomness.md` 中都写明了，答辩时不应把背书说成"绝对可信"。


