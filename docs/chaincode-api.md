# PokeChain 链码接口规范（pokemon-cc）

链码名：`pokemoncc`　通道：`gamechannel`　语言：TypeScript（fabric-contract-api 2.5.x）

## 0. 总则（所有合约必须遵守）

1. **确定性**：禁止 `Date.now()`/`Math.random()`/网络调用/系统时间。所有时间戳由调用方以 ISO-8601 字符串参数传入（`nowISO`）。随机性只能来自 `RandomContract` 已验证的随机流。
2. **身份**：每个变更交易用 CID（`fabric-shim` 的 `ClientIdentity`）取得 `mspId` 与 `attrs`。角色：`player`（默认）、`admin`（Org1）、`system`（后端服务身份，Org1）、`arbitrator`（Org2）。`getAttrValue('role')` 判定。
   **本人校验**：证书的 `hf.EnrollmentID`（Fabric CA 自动写入，不得显式注册）必须等于链上 `playerId`——本项目 `playerId === username === enrollmentID`，`getEnrollmentId(ctx) !== player.playerId` 即抛 `NOT_OWNER`；证书缺该属性时同样拒绝（不回退 mspId）。`mspId` 只表示组织归属（Org1 运营 / Org2 仲裁），不再是「本人」的依据。
3. **幂等**：所有变更交易接受 `idemKey`（调用方生成，通常 uuid）。若 `IDEMP:<idemKey>` 已存在，直接返回首次结果，不重复变更。
4. **状态机**：资产 `status` 仅允许合法迁移，锁定状态拒绝转移/消耗/再锁定。
5. **整数**：数量/积分/经验一律非负整数，运算后检查溢出与负值（用 `Number.isSafeInteger`）。
6. **规范 JSON 哈希**：`canonical(obj)` = 键排序后的 `JSON.stringify`；`sha256hex = createHash('sha256').update(s,'utf8').digest('hex')`。
7. **键空间**：`<DOCTYPE>:<id>`。docType：`player / pokemon / item / trade / battle / rand / idemp`。
8. **事件**：关键变更 `ctx.stub.setEvent(name, Buffer.from(JSON.stringify(payload)))`。事件名见各合约。
9. 错误一律 `throw new Error('CODE: 人类可读信息')`，CODE 全大写蛇形（如 `NOT_OWNER`、`ASSET_LOCKED`、`TRADE_EXPIRED`）。

## 1. 数据模型（世界状态 JSON）

### Player `player:<playerId>`
```json
{ "docType":"player", "playerId":"u_xxx", "mspId":"Org1MSP", "nickname":"小智",
  "role":"player", "points":400, "wins":0, "losses":0, "rating":1000, "createdAt":"ISO",
  "transferLockUntil":"2026-01-04T00:00:00.000Z" }
```
`rating`：排位分，注册默认 `1000`，范围 `0-99999`，仅 `system` 可经 `UpdateRating` 变更（`docs/backend-api.md` 侧的段位/匹配口径属后端）。
`rating` 字段上线前的旧记录缺失该字段，链码读写时按 `1000` 处理。
`transferLockUntil`（2026-10 P2）：注册时 = `nowISO + 72h`，此前禁止转出积分（`TRANSFER_LOCKED`）；缺省/空串的旧记录视为无锁（不迁移）。seed 用 admin `ClearTransferLock` 解锁 ash/gary 等演示账号。
`mspId` 记录注册调用者的组织，仅供展示/审计；链上「本人」校验一律用证书 `hf.EnrollmentID`（见 §0 第 2 条），旧记录无需迁移。

### Pokemon `pokemon:<id>`
```json
{ "docType":"pokemon", "id":"p_xxx", "speciesId":25, "name":"皮卡丘",
  "dnaHash":"sha256hex",
  "ivs":{"hp":0,"atk":0,"def":0,"spatk":0,"spdef":0,"speed":0},
  "evs":{"hp":0,"atk":0,"def":0,"spatk":0,"spdef":0,"speed":0},
  "nature":"hardy", "ability":"static", "shiny":false,
  "level":5, "exp":0, "moves":["thunder-shock","growl"],
  "ownerId":"u_xxx", "status":"IDLE", "lockRef":"",
  "captureEventId":"ev_xxx", "createdAt":"ISO", "bond":50 }
```
`status`：`IDLE | LOCKED_TRADE | LOCKED_BATTLE`。`lockRef` 指向 trade/battle id。

**羁绊值 `bond`（0-255）——"陪你成长的记录，换手即清零"**：
- 铸造（`MintFromCapture`，捕捉与新手礼包 starter 同走该交易）默认 `50`；仅 `BondUp`（system）可提升，单次 `+1..50`，上限 `255` 截断。
- **所有权变更即重置为 `30`**：`PokemonContract.Transfer`（易主时，转给自己不算）、Trade 执行交换（双方宝可梦各自重置）、Battle 结算押注宝可梦易主时（赢家赢得的对手宝可梦重置；赢家自有宝可梦保持原值）。
- DRAW/REFUND 各自取回押注资产、`Release`（Released 无 owner）均不改动 bond；锁定（LOCKED_TRADE/LOCKED_BATTLE）不影响 bond，`BondUp` 对锁定中的宝可梦同样生效。
- `bond` 字段上线前的旧记录缺失该字段，链码读写时按铸造默认值 `50` 处理。

`ivs`/`evs`：个体值各项 `0-31`；努力值各项 `0-255` 且六项总和 `≤510`（第三世代规则）。**链上只存 IV/EV 与性格，
不存最终能力值**——六项最终能力值由后端按 `HP/其他 = f(种族值, IV, EV, 等级, 性格)` 计算后随 API 返回，
公式与 25 种性格修正表见 `docs/backend-api.md` §2「能力值计算」。`evs` 字段上线前的旧记录缺失该字段，链码读写时按全 0 处理。

### Item `item:<id>`（同质道具按堆叠存）
```json
{ "docType":"item", "id":"i_xxx", "typeId":"poke-ball", "ownerId":"u_xxx",
  "quantity":5, "uri":"minio://assets/items/poke-ball.png", "metadataHash":"sha256hex",
  "status":"IDLE", "lockRef":"", "createdAt":"ISO" }
```

**堆叠归一（合并）规则**：同一 owner 名下同 `typeId` 的所有 `status=IDLE` 堆叠合并为一个——数量累加到**最早创建**的堆叠
（`createdAt` 升序，缺失视为 `''` 即最旧；同一时间按 `id` 字典序），其余堆叠记录删除，发 `ItemMerged` 事件。触发时机：
`MintItem` 铸造后自动执行、Battle 结算赢家收下锁定堆叠时自动执行、`MergeStacks` 显式调用。`LOCKED_TRADE/LOCKED_BATTLE`
的堆叠与其他 owner/typeId 的堆叠不参与合并。`TransferItem` 与 Trade 保持整堆转移语义，**不**自动合并（需要归一时调用
`MergeStacks`）。合并依赖 CouchDB 富查询：只读**已提交状态**，本交易内新建/改写的堆叠由合约显式补充，因此同一交易内
先写后并也正确；不同 peer 在同一高度上结果一致（见 §3 索引 `indexItemStacks`）。

**子堆叠 id 规则**：部分数量押注拆出的子堆叠 id 恒为 `<parentId>#w<battleId>`（如 `i_xxx#wb_abc123`）；反向求父堆叠取
最后一个 `#w` 之前的前缀。子堆叠继承父堆叠的 `typeId/uri/metadataHash`，`createdAt` 为拆分时刻。

### RandomCommit `rand:<eventId>`
```json
{ "docType":"rand", "eventId":"ev_xxx", "purpose":"capture|battle|mint",
  "playerId":"u_xxx", "commitHash":"sha256(serverSeed)", "clientSeed":"hex",
  "serverSeed":"", "resultHash":"", "status":"COMMITTED", "createdAt":"ISO",
  "meta":"" }
```
`meta`：可选的链下上下文备注（如区域/诱饵付费，≤256 字节 UTF-8，缺省空串），随承诺一起上链留痕，`GetRandom` 原样返回。
`status`：`COMMITTED → REVEALED → CONSUMED`。

### Trade `trade:<id>`
```json
{ "docType":"trade", "id":"t_xxx", "fromId":"u_a", "toId":"u_b",
  "offer":{"pokemonIds":[],"itemIds":[],"points":0},
  "request":{"pokemonIds":[],"itemIds":[],"points":100},
  "manifestHash":"sha256hex",
  "confirmations":{"from":false,"to":false},
  "status":"OPEN", "createdAt":"ISO", "expiresAt":"ISO" }
```
`status`：`OPEN → EXECUTED | CANCELLED | EXPIRED`。offer 属于 from，request 属于 to。

### Battle `battle:<id>`
```json
{ "docType":"battle", "id":"b_xxx", "playerA":"u_a", "playerB":"u_b",
  "wagerA":{"pokemonIds":[],"items":[{"id":"i_xxx","qty":3}],"points":50},
  "wagerB":{"pokemonIds":[],"items":[],"points":50},
  "wagerHash":"sha256(canonical({wagerA,wagerB,playerA,playerB}))",
  "status":"CREATED", "escrow":{"pointsA":50,"pointsB":50},
  "result":{"winnerId":"","resultHash":"","serverSig":"","serverSubmitted":false,
            "confirmations":{"A":false,"B":false}},
  "disputeReason":"", "arbiterNote":"", "createdAt":"ISO", "settledAt":"" }
```
`status`：`CREATED → ACTIVE → RESULT_SUBMITTED → SETTLED | DISPUTED → SETTLED | REFUNDED`。

押注道具：`items:[{id,qty}]`（`qty≥1` 部分数量；`qty=0` 表示**整堆**，仅由旧格式 `itemIds` 解析归一产生）。押注包在
CreateBattle 时归一为 `{pokemonIds, items, points}` 并以此形态存储、参与 `wagerHash` 计算；链下计算 wagerHash 前必须做同样的
归一（backend `chain.adapter.normalizeWagerBundle`）。

### Idempotency `idemp:<key>`
```json
{ "docType":"idemp", "key":"...", "result":"首次交易返回的JSON字符串", "createdAt":"ISO" }
```

## 2. 合约与交易

### 2.1 PlayerContract
| 交易 | 参数 | 规则 | 事件 |
|---|---|---|---|
| `RegisterPlayer` | playerId, nickname, nowISO, idemKey | **仅 admin/system**（防抢注 username；后端注册与 seed 均用 `ADMIN_IDENTITY`）；不存在才创建；mspId 记录调用者组织（仅展示/审计）；role=player；初始 points=**400**、rating=1000；`transferLockUntil = nowISO + 72h`（H10） | `PlayerRegistered` |
| `GrantRole` | playerId, role, nowISO, idemKey | 仅 admin | `RoleGranted` |
| `GetPlayer` | playerId | 查询（返回含 `rating`） | - |
| `AddPoints` | playerId, delta(可负), reason, nowISO, idemKey | 仅 admin/system；余额不得为负 | `PointsChanged` |
| `TransferPoints` | fromId, toId, amount, nowISO, idemKey | 调用者必须是 fromId 本人（`hf.EnrollmentID` 匹配）；amount>0；`nowISO < from.transferLockUntil` 抛 `TRANSFER_LOCKED` | `PointsChanged` |
| `ClearTransferLock` | playerId, nowISO, idemKey | **仅 admin/system**；清空 `transferLockUntil`（seed 解锁演示账号用，后端不暴露 HTTP API） | `TransferLockCleared` |
| `UpdateRating` | playerId, newRating, reason, nowISO, idemKey | 仅 system；`0 ≤ newRating ≤ 99999`（safeInt，越界抛 `INVALID_PARAM`）；与 points/wins 相互独立 | `RatingChanged`（payload 含 previous） |

### 2.2 RandomContract（承诺-揭示）
| 交易 | 参数 | 规则 | 事件 |
|---|---|---|---|
| `Commit` | eventId, purpose, playerId, commitHash, clientSeed, nowISO, idemKey, meta? | eventId 不得已存在；commitHash 须为 64 位 hex；可选 `meta`（≤256 字节 UTF-8，缺省 `''`）存入记录供链下上下文留痕 | `RandomCommitted`（payload 含 meta） |
| `RevealAndVerify` | eventId, serverSeed, nowISO, idemKey | **仅 system**（serverSeed 只在服务端）；状态须 COMMITTED；重算 `sha256(serverSeed)==commitHash` 否则抛 `SEED_MISMATCH`；写入 serverSeed、`resultHash=sha256(serverSeed+"|"+clientSeed+"|"+eventId)`；状态→REVEALED | `RandomRevealed` |
| `GetRandom` | eventId | 查询 | - |
| （内部）`consumeRandom(ctx,eventId,purpose,playerId)` | - | 供同链码其他合约调用：须 REVEALED、purpose/playerId 匹配，→CONSUMED，返回 resultHash | - |

派生规则（链下与链上一致，写入文档供复核）：第 n 个随机值（n 从 0 起）=
`HMAC-SHA256(key=serverSeed, message=clientSeed|eventId|n)` 取前 8 字节为大端整数 / 2^64 得 [0,1) 浮点。

### 2.3 PokemonContract
| 交易 | 参数 | 规则 | 事件 |
|---|---|---|---|
| `MintFromCapture` | id, playerId, speciesId, name, ivsJSON, nature, ability, shiny, movesJSON, dnaHash, eventId, nowISO, idemKey | **仅 system**（铸造属性由后端从已验证随机流派生）；`consumeRandom(eventId,'capture',playerId)` 成功才铸造；ivs 各值 0-31；**evs 初始全 0、bond 初始 50**；moves ≤4；初始 status=IDLE | `PokemonMinted` |
| `Transfer` | id, toId, nowISO, idemKey | 调用者=当前 owner（`hf.EnrollmentID` 匹配）；status=IDLE；toId 玩家存在；**易主时 bond 重置为 30**（转给自己不算易主） | `PokemonTransferred`（payload 含 bond） |
| `BondUp` | pokemonIdsJSON, delta, reason, nowISO, idemKey | 仅 system；`pokemonIdsJSON` 为 id 数组（≤100 项、非空、不得重复）；每只 `bond += delta`（`delta` 1-50，safeInt），超过 255 截断；宝可梦须存在且非 `RELEASED`（锁定中可提升，违约抛 `POKEMON_NOT_FOUND` / `BAD_STATE`）；返回更新后的宝可梦数组 | `BondChanged`（每只一条） |
| `ApplyGrowth` | id, growthJSON({level?,exp?,moves?,evs?,ivs?,speciesId?,name?}), nowISO, idemKey | **仅 system**（后端扣费/校验学习表与进化条件后代签；玩家证书不能自改 level/EV/IV/species/name）；status=IDLE；level 1-100 单调不减；moves ≤4；**evs 六项齐全、单项 0-255、总和 ≤510（safeInt 校验，非法抛 `INVALID_PARAM`）**；**ivs 为六维子集（王冠类道具），每维 0-31 整数、`new >= old`，降低抛 `IV_DECREASE`** | `PokemonGrowth`（payload 含 level/exp/evs/ivs） |
| `Release` | id, nowISO, idemKey | owner；status=IDLE；置 status=`RELEASED`、ownerId=""（保留记录供图鉴追溯，bond 不变） | `PokemonReleased` |
| `GetPokemon` | id | 查询 | - |
| `QueryByOwner` | ownerId | CouchDB 富查询 `docType=pokemon AND ownerId` | - |
| `QueryPokedex` | queryJSON（CouchDB selector 透传，需含 docType=pokemon） | 查询 | - |

### 2.4 ItemContract
| 交易 | 参数 | 规则 | 事件 |
|---|---|---|---|
| `MintItem` | id, playerId, typeId, quantity, uri, metadataHash, nowISO, idemKey | 仅 admin/system；quantity≥1；写入 `createdAt=nowISO` 后**自动合并**该 owner+typeId 的 IDLE 堆叠；返回合并后的幸存堆叠（可能不是本次铸造的 id） | `ItemMinted` + `ItemMerged` |
| `MergeStacks` | ownerId, typeId, nowISO, idemKey | owner 本人（`hf.EnrollmentID` 匹配）或 system；合并 owner 名下同 typeId 的全部 IDLE 堆叠（规则见 §1）；无可合并堆叠时返回 `null` | `ItemMerged` |
| `TransferItem` | id, toId, nowISO, idemKey | owner 本人（`hf.EnrollmentID` 匹配）；status=IDLE；整堆转移，不自动合并 | `ItemTransferred` |
| `ConsumeItem` | id, quantity, reason, nowISO, idemKey | owner 本人（`hf.EnrollmentID` 匹配）或 system；status=IDLE；扣减到 0 时保留记录 quantity=0 | `ItemConsumed` |
| `GetItem` / `QueryByOwner` | - | 查询 | - |

### 2.5 TradeContract（双方确认 + 原子结算）
| 交易 | 参数 | 规则 | 事件 |
|---|---|---|---|
| `CreateTrade` | id, fromId, toId, offerJSON, requestJSON, expiresAt, nowISO, idemKey | 调用者=fromId 本人（`hf.EnrollmentID` 匹配）；逐项校验双方资产存在、归各自所有、status=IDLE；points 校验余额；**只锁 offer**（→LOCKED_TRADE, lockRef=id），**request 仅预检不锁定**（否则任何人凭资产 id 即可锁住他人资产）；`expiresAt - nowISO ≤ 7 天`（否则 `INVALID_PARAM`，`Date.parse` 确定性解析）；from/to 积分不动仅在执行时划转；manifestHash=sha256(canonical(offer,request,from,to)) | `TradeCreated` |
| `ConfirmTrade` | id, playerId, nowISO, idemKey | 仅 from/to 且须本人（`hf.EnrollmentID` 匹配，替对方确认抛 `NOT_OWNER`）；OPEN 且未过期（nowISO<expiresAt 否则→EXPIRED 并解锁）；双方均确认后**同一交易内原子执行**：先校验 request 资产仍归 toId 且 `IDLE` 或**被本交易锁定**（旧交易兼容），否则抛 `NOT_OWNER`/`ASSET_LOCKED` 整体回滚（offer 仍锁定、交易仍 OPEN）；交换宝可梦/道具 owner、划转积分（from 收 request.points、付 offer.points，余额不足同样整体回滚）、资产解锁→IDLE、**双方宝可梦 bond 均重置为 30**、status=EXECUTED | `TradeConfirmed` / `TradeExecuted` |
| `CancelTrade` | id, playerId, nowISO, idemKey | OPEN 时 from/to 任一方本人可取消（`hf.EnrollmentID` 匹配）；解锁双方资产（新交易 request 未锁→自动跳过；旧交易 request 仍锁→一并解锁）；→CANCELLED | `TradeCancelled` |
| `ExpireTrade` | id, nowISO, idemKey | 任何人可触发；nowISO≥expiresAt 且 OPEN；解锁；→EXPIRED | `TradeExpired` |
| `GetTrade` / `QueryByPlayer` | id / playerId | 查询（后者富查询 fromId/toId） | - |

Trade 的 `offer/request` 保持 `{pokemonIds, itemIds, points}` **整堆语义不变**（不支持部分数量，不触发自动合并）。

### 2.6 BattleContract（押注锁定 + 签名结果 + 原子结算 + 仲裁）
| 交易 | 参数 | 规则 | 事件 |
|---|---|---|---|
| `CreateBattle` | id, playerA, playerB, wagerAJSON, wagerBJSON, wagerHash, nowISO, idemKey | 仅 system 或当事人（调用者 `hf.EnrollmentID` ∈ {playerA, playerB}，其余抛 `FORBIDDEN`）；两玩家不同；wager JSON 为 `{pokemonIds, items:[{id,qty}], points}`（兼容旧 `itemIds`，解析层归一为整堆 `qty=0`；两种字段都非空时视为歧义拒绝，`qty≥1` 且 safeInt）；校验 wagerHash=sha256(canonical({playerA,playerB,wagerA,wagerB}))（覆盖**归一后**的押注包）；逐项校验并锁定双方押注资产（→LOCKED_BATTLE）；**部分押注**：`qty=0`（旧格式）或 `qty=堆叠总量`→整堆锁定，`qty<总量`→原堆叠减量保持 IDLE、另建 `<parentId>#w<battleId>` 子堆叠锁定（`qty>持有量` 抛 `INSUFFICIENT_QUANTITY`）；points 立即从双方余额扣入 escrow（余额不足抛错）；→CREATED | `BattleCreated` |
| `ActivateBattle` | id, nowISO, idemKey | system；CREATED→ACTIVE | `BattleActivated` |
| `SubmitResult` | id, winnerId（或 "DRAW"）, resultHash, serverSig, nowISO, idemKey | 仅 system；ACTIVE；记录 result，serverSubmitted=true；→RESULT_SUBMITTED | `BattleResultSubmitted` |
| `ConfirmResult` | id, playerId, nowISO, idemKey | 当事人且须本人（`hf.EnrollmentID` 匹配）；RESULT_SUBMITTED；A/B 均确认后**同交易内原子结算**（见 settle 规则）；→SETTLED | `BattleConfirmed` / `BattleSettled` |
| `SettleBattle` | id, nowISO, idemKey | system；RESULT_SUBMITTED 且超时兜底（掉线不确认）时由 system 直接结算；幂等 | `BattleSettled` |
| `CancelBattle` | id, reason, nowISO, idemKey | system；仅 CREATED（从未激活）；复用 settle REFUND 全额退款（资产解锁归还、escrow 原路退回）；写入 `result.winnerId='REFUND'`、`resultHash=sha256("cancel\|<id>\|<reason>")`、`serverSubmitted=true`、`arbiterNote="CANCEL: <reason>"`；→REFUNDED（H5 房间启动失败补偿） | `BattleCancelled` / `BattleSettled` |
| `Forfeit` | id, loserId, reason, nowISO, idemKey | system；ACTIVE/RESULT_SUBMITTED；等同 winner=对方 的立即结算。**写入 `result.winnerId`（= 对方）与确定性 `resultHash=sha256("forfeit\|<id>\|<loserId>\|<reason>")`、`serverSubmitted=true`**；若已有 `SubmitResult` 的 `serverSig/resultHash` 则只补 winner、不覆盖服务器签名（C6） | `BattleSettled` |
| `Dispute` | id, playerId, reason, nowISO, idemKey | 当事人且须本人（`hf.EnrollmentID` 匹配）、未 SETTLED；→DISPUTED（资产保持锁定冻结） | `BattleDisputed` |
| `Arbitrate` | id, outcome(winnerId/"DRAW"/"REFUND"), arbiterNote, nowISO, idemKey | 仅 arbitrator（Org2MSP + role=arbitrator）；DISPUTED；按 outcome 结算或全额退款；→SETTLED/REFUNDED | `BattleArbitrated` / `BattleSettled` |
| `GetBattle` / `QueryByPlayer` | - | 查询 | - |

**settle 规则（内部函数，所有路径统一走它）**：
- 赢家：获得双方押注的全部宝可梦与道具（owner→赢家），escrow 全部积分→赢家；战绩 wins/losses +1。**易主的宝可梦 bond
  重置为 30**（赢家赢得的对手宝可梦；赢家自有宝可梦保持原值）。收到的道具堆叠解锁为
  IDLE 后按 §1 合并规则与赢家同 `typeId` 的 IDLE 堆叠归一（本交易内转移的堆叠一并参与）。
- DRAW：各自取回自己的押注资产与 escrow 积分；不记胜负；bond 不变。部分押注的子堆叠数量**并回原堆叠**（原堆叠仍存在、status=IDLE
  且 owner 未变时），否则将该子堆叠恢复为独立 IDLE 堆叠（保留 `#w<battleId>` id）。
- REFUND：同 DRAW（仲裁退款），bond 不变。
- 全部资产解锁→IDLE（lockRef 清空）、写入 settledAt、status 终态。任何一步校验失败整体抛错回滚，保证无部分结算。
- **结算事件**：`BattleSettled` payload 带 `{id, winnerId, playerA, playerB}`（Forfeit 另带 `loserId`，SettleBattle/Arbitrate 另带 `via`）；并在同一交易内为双方各发一条 `PointsChanged {playerId, delta, balance, reason:"battle:<id>"}`（DRAW/REFUND 时 delta=0）。后端排行榜靠这两个事件刷新 Redis ZSET，缺事件会导致真链榜单停在旧分数（H4）。
- 结算按 wager 引用定位锁定堆叠：整堆锁→原堆叠；拆分锁→子堆叠（原堆叠即使已被合并删除也能正确定位子堆叠）。

## 3. CouchDB 索引

`META-INF/statedb/couchdb/indexes/` 随链码打包：
- `indexOwner.json`：`["docType","ownerId"]`
- `indexTrade.json`：`["docType","fromId","toId"]`
- `indexBattle.json`：`["docType","playerA","playerB"]`
- `indexSpecies.json`：`["docType","speciesId"]`
- `indexItemStacks.json`：`["docType","ownerId","typeId","status"]`（堆叠合并查询）

堆叠合并的富查询只读已提交状态（不含本交易写入，合约在内存里补齐本交易新建/改写的堆叠），因此不依赖交易内的读己写；
该查询由上述索引支撑，缺索引时 CouchDB 会拒绝查询。

## 4. 背书策略（部署参数）

实际使用**通道默认策略**：`network/configtx.yaml` Application 级 `MAJORITY Endorsement`（两组织网络下即 Org1+Org2 双方 peer 均须背书；`LifecycleEndorsement` 同为 MAJORITY，链码定义须两组织各自 approve 才能 commit）。`scripts/deployCC.sh` 未指定链码级背书策略；早期设计稿的 `OutOf(1, 'Org1MSP.peer','Org2MSP.peer')` 未采用。课程说明：可在通道默认基础上收紧——例如 `BattleContract.Settle/Arbitrate` 类交易改用链码级/私有背书（仅 Org2 背书）作为扩展演示，P0 用默认策略。

## 5. 单元测试要求（Jest + 手写 mock harness）

测试桩为手写最小实现（`tests/helpers/harness.ts`：内存世界状态 + 事务写缓存，抛错即回滚，与 Fabric 交易语义一致；以 `mspId`/`role`/`hf.EnrollmentID` 属性模拟 Org1MSP（admin/system/player）与 Org2MSP（arbitrator/player）身份——玩家上下文用 `World.ctxAs(playerId)`，缺 `hf.EnrollmentID` 用 `World.ctx(mspId)` 验证拒绝路径），当前 102 用例。不用 `@theledger/fabric-mock-stub`：其依赖 `fabric-shim ^1.4` + TS3，与本工程 fabric-shim 2.5 / TS5 栈不兼容。

覆盖：注册（400P/72h 锁/`ClearTransferLock`）/铸币/转移/放生；Commit→Reveal→MintFromCapture 全流程（含 SEED_MISMATCH 拒绝）；EV 更新合法路径与单项 255/总和 510/负数/缺字段/非整数拒绝、旧记录无 `evs` 字段的兼容读取；**能力养成**（ApplyGrowth `ivs` 子集提升与 `IV_DECREASE`/越界/未知键/非整数/非对象拒绝且不落库）；**羁绊值 bond**（铸造默认 50、`Transfer` 易主重置 30、转给自己不重置、Trade 双方各自重置、Battle 赢家赢得的宝可梦重置而自有宝可梦保持、DRAW 不重置、`BondUp` 批量提升/255 截断/角色与参数校验/放生后拒绝/锁定中可提升、旧记录缺字段兼容）；**排位分 rating**（默认 1000、`UpdateRating` 仅 system 与 0/99999 边界、越界/非整数/不存在拒绝、旧记录缺字段兼容）；**道具堆叠归一**（mint 自动合并到最早堆叠、旧记录缺 `createdAt` 视为最早、锁定堆叠不参与、`MergeStacks` 权限与返回值、转移/交易不自动合并）；**部分数量押注**（原堆叠减量+确定性 id 子堆叠锁定、qty 越界/非正/重复/混用旧字段拒绝、旧 `itemIds` 归一为整堆、赢家收堆合并、DRAW 并回原堆叠、原堆叠易主时子堆叠独立恢复）；**随机承诺 meta**（存取、缺省空串、超 256 字节拒绝）；Trade 创建锁定→双方确认执行→余额与归属断言、取消解锁、过期退款、双花拒绝（锁定资产再 CreateTrade 抛 ASSET_LOCKED）；Battle 锁定→提交→确认结算（赢家得全部）、DRAW 退款、Forfeit、Dispute→Arbitrate、CancelBattle（CREATED 全额退款/非 system 拒绝/ACTIVE 拒绝）、越权调用拒绝（非 owner 转移/非 arbitrator 仲裁/非 system 提交结果）、幂等键重放返回相同结果不重复变更。
