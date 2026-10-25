# PokeChain 可验证随机数设计（承诺-揭示 + HMAC 派生流）

> 配套契约：`docs/chaincode-api.md` §2.2（RandomContract）、`docs/backend-api.md` §2/§5/§6
> 实现位置：链码 `chaincode/pokemon-cc/src/contracts/random.contract.ts`、`src/common/state.ts`（consumeRandom）、`src/common/crypto.ts`；后端 `backend/src/common/utils/crypto.util.ts`（DeriveStream）、`backend/src/pokemon/capture-derive.ts`、`backend/src/battles/battle-manager.service.ts`

## 1. 为什么 Fabric 链码不能自己"掷骰子"

Fabric 采用 **execute-order-validate（先执行-后排序-再验证）** 架构：同一笔交易提案会被发送到多个背书节点（本网络为 Org1+Org2 两个 peer）分别执行，只有各节点**读集/写集完全一致**的提案才能通过背书策略并被最终提交。这带来两条硬约束：

1. **链码执行必须确定性**。`Math.random()`、`Date.now()`、系统时间、网络调用、随机 GUID 等在两个 peer 上几乎必然产生不同结果 → 读写集不一致 → 背书失败（ENDORSEMENT_POLICY_FAILURE）或更糟的状态分叉。
2. **没有任何"链上公共随机源"可用**。以太坊式的 blockhash 在 Fabric 中不存在；交易时间戳由客户端生成、区块时间由排序节点写，二者要么不可控要么可被排序方操纵，都不能作为公平随机源。

因此本系统所有随机性的设计基线是：

- 链码内部**绝不产生随机数**（`docs/chaincode-api.md` §0.1 明令禁止，连时间戳都以 `nowISO` 参数由调用方传入）；
- 随机数在**链下生成**，但其**承诺先于使用上链**、**揭示经链上重算验证**、**消费由链上状态机约束**——把"不可信链下随机"变成"可审计、不可抵赖、不可篡改的可验证随机"。

## 2. 总体方案：承诺-揭示（Commit-Reveal）+ HMAC-SHA256 派生流

### 2.1 角色与三方职责分离

| 角色 | 谁承担 | 职责 | 不能做什么 |
|---|---|---|---|
| 生成方 | 后端服务（CaptureService / BattleManagerService） | 用 CSPRNG 生成 serverSeed，先提交承诺，事后揭示 | 承诺后更换种子（链上重算会发现）；拒绝揭示（种子不揭示则资产流程走不下去，且承诺本身已上链留痕） |
| 使用方 | 玩家（提供 clientSeed、发起捕捉/对战） | 搅动随机结果，使生成方无法单方面决定输出 | 预测输出（揭示前 serverSeed 对其不可见） |
| 验证方 | 链码（两组织 peer 共同背书）+ 任何第三方（/fairness 页面） | 揭示时链上重算 `sha256(serverSeed)==commitHash`；铸造/结算前校验随机事件已被正确消费 | — |

### 2.2 一次随机事件的完整生命周期

```
生成方(后端)                链上 RandomContract                 使用方(玩家)
 │ serverSeed ← randomBytes(32)（CSPRNG，hex 64 字符）
 │ commitHash = sha256hex(serverSeed)
 │ clientSeed ← 玩家可选提供（^[0-9a-f]{8,64}$，否则服务端 randomBytes(16)）
 │ eventId    ← ev_<uuid>
 │
 │ ① Commit(eventId, purpose, playerId, commitHash, clientSeed)
 │──────────────────────────────▶  写 rand:<eventId>，status=COMMITTED
 │                                 （eventId 不得重复 → 承诺唯一）
 │        【关键：承诺上链先于任何随机数的使用】
 │
 │ 链下派生（见 §3）：rand(n) = HMAC-SHA256(serverSeed, clientSeed|eventId|n)
 │ 决定遇敌种类/等级 → 返回预览（IV 等敏感位此时不揭晓）
 │
 │                          ② RevealAndVerify(eventId, serverSeed)
 │                              （仅在结算后：捕捉投中 / 战斗终态 / 放弃后 sweep）
 │──────────────────────────────▶  链上重算 sha256(serverSeed) == commitHash？
 │                                 不等 → 抛 SEED_MISMATCH，状态不变（拒绝）
 │                                 相等 → 落盘 serverSeed，
 │                                 resultHash = sha256(serverSeed|clientSeed|eventId)
 │                                 status=REVEALED
 │
 │ ③ 业务合约消费：MintFromCapture 内部调 consumeRandom(eventId,'capture',playerId)
 │──────────────────────────────▶  校验 REVEALED + purpose/playerId 匹配
 │                                 status=CONSUMED，返回 resultHash
 │                                 （同一事件只能被消费一次 → 不可重复铸宠）
 │
 │ ④ 任何人 GET /api/v1/fairness/:eventId 取全量数据本地复核（§7）
```

> **揭示时机（H9，2026-10-25）**：捕捉/野怪战斗**不再在第一次投球时揭示**，改为结算后揭示——快速捕捉投中时、野怪战斗进入终态（CAUGHT/WILD_FAINTED/PLAYER_FAINTED/RAN/TIMEOUT）时、或玩家放弃后由后端 5 分钟 sweep 在会话过期时补揭示。`/fairness` 对 `COMMITTED` 事件只返回承诺与 clientSeed（`serverSeed` 为空、`revealed:false`），避免拿到种子后推算后续投球/AI 行为。

### 2.3 状态机

```
            Commit                 RevealAndVerify              consumeRandom
   (none) ───────────▶ COMMITTED ───────────────▶ REVEALED ─────────────────▶ CONSUMED
                          │                          ▲
                          │ SEED_MISMATCH 抛错，状态不变（可重试正确种子）
                          ▼
                     仍 COMMITTED
```

| 状态 | 含义 | 允许的迁移 |
|---|---|---|
| COMMITTED | 承诺已上链，serverSeed 未公开 | →REVEALED（重算通过） |
| REVEALED | 种子已公开并经链上验证，resultHash 已落盘 | →CONSUMED（被授权业务合约消费） |
| CONSUMED | 随机事件已被用于铸造/判定，终态 | 无（终态） |

防重放细节：`Commit` 对重复 eventId 抛 `RAND_EXISTS`；`RevealAndVerify` 要求严格 COMMITTED；`consumeRandom` 要求严格 REVEALED。再叠加所有变更交易的 `idemKey` 幂等（重复提交返回首次结果，见 `docs/chaincode-api.md` §0.3），重放/竞态均无法造成二次消费。

### 2.4 派生算法（链上契约文档化，前后端字节级一致）

第 n 个随机值（**n 从 0 起**）：

```
rand(n) = uint64_be( HMAC-SHA256(key = serverSeed,
                                  msg = "${clientSeed}|${eventId}|${n}")[0..8) ) / 2^64   ∈ [0,1)
```

- HMAC（而非单纯哈希拼接）避免长度扩展类误用，key 固定为保密的 serverSeed；
- message 绑定 `clientSeed`（玩家搅动）、`eventId`（事件唯一性，跨事件不可移植）、`n`（流内序号）——三者任一变化则整条流改变；
- 取前 8 字节大端无符号整数除以 2^64，得到 [0,1) 均匀浮点。JS `Number` 精度 53 bit < 64 bit，存在理论上的粒度损失（2^-53 级），对游戏判定无实际影响，已在测试中用黄金向量锁定行为。
- 链上锚点 `resultHash = sha256(serverSeed|clientSeed|eventId)` 与该流同源：验证 resultHash 即验证"这条流确实是承诺的那条流"。

实现互验：后端 `DeriveStream`（`backend/src/common/utils/crypto.util.ts`）与链码 `common/crypto.ts` 共用同一公式；单测含黄金向量与 SEED_MISMATCH 拒绝用例；前端 /fairness 页面用 Web Crypto 独立重算（§7）。

## 3. 派生流的分块布局（capture-derive.ts，n 的实际含义）

**一个 RandomCommit 事件覆盖一次遇敌 + 其后的野怪战斗与全部捕捉尝试**，因此契约文档中的简版 "rand(0..8)" 在实现中偏移为分块布局（`backend/src/pokemon/capture-derive.ts`，该布局同时通过 `GET /fairness/:eventId` 的 `captureLayout` 字段对外公示）：

| n | 含义 | 计算 |
|---|---|---|
| 0 | 野生宝可梦种类 | 区域野生池的**加权索引**：`target = rand × 总权重`，取累计权重区间覆盖 target 的种族。**普通区**：池 = `stage ≤ zone.maxStage` **∧ 种族属性 ∈ zone.habitats**，权重按捕获率 60/30/10、种族值总量 ≥500 再 ×0.3；**传说区**：池 = `poolSpeciesIds` 指定的传说种族（等权 1），与普通池互不相交 |
| 1 | 野生**等级** | `zone.minLevel + floor(rand × (zone.maxLevel − zone.minLevel + 1))`，即区域内均匀；**只由区域决定，与队伍等级无关**；付费诱饵带内 +2（tier 1）/ +5（tier 2）并封顶 `zone.maxLevel`（**传说区禁用诱饵**，其等级带本身就窄：Lv40 固定 / Lv45 固定 / Lv45-50） |
| 第 k 次投球（k=1,2,…）：base = 2 + (k−1)×10 | | |
| base+0 | 捕捉判定 | 成功 ⟺ `rand < p`，`a = ((3×maxHP−2×curHP)×catchRate×ballBonus)/(3×maxHP)`，`p = min(1, a/255)`（大师球 ballBonus=255 → p=1 必中；快速捕捉等价于满血 curHP=maxHP） |
| base+1 .. base+6 | 个体值 IV：hp/atk/def/spatk/spdef/speed（**快速捕捉路径**；野怪战斗用 20000 区，见下） | `floor(rand×32)` → 0..31 |
| base+7 | 性格（快速捕捉路径） | `NATURES[floor(rand×25)]`（25 种性格表） |
| base+8 | 闪光（快速捕捉路径） | `rand < shinyChance`：基准 **1/4096**；付费诱饵 tier 2 **×4 → 1/1024**（同一条流、同一个槽位，只改判定阈值，购买记录见 `RandomCommit.meta={zone,lureTier,cost}`） |
| base+9 | 失败时的摇晃次数 | `1 + floor(rand×3)` → 1..3 |
| 野怪战斗个体样本（开场派生一次，整场固定并用于铸造）：base = 20000 | | |
| +0 .. +5 | 野怪 IV 六维 | `floor(rand×32)` |
| +6 | 野怪性格 | `NATURES[floor(rand×25)]` |
| +7 | 野怪闪光 | `rand < shinyChance`（同上，诱饵 tier 2 → 1/1024） |
| 野怪战斗第 t 回合（t=1,2,…）：base = 30000 + (t−1)×16 | | |
| +0 | 野怪 AI 选招 | `moves[floor(rand × 技能数)]` |
| +1 .. +5 | 我方一次攻击的五个掷点 | 麻痹检查（仅麻痹者，`< 0.25` → 本回合不能行动）/ 命中 / 暴击 / 伤害浮动 / 追加效果（仅带 stat/status 效果的技能，`rand×100 < chance`） |
| +6 .. +10 | 野怪一次攻击的五个掷点 | 同上（顺序一致） |
| +11 | 速度并列先手裁决 | `rand < 0.5` → 我方先手（麻痹速度减半参与比较） |
| +12 .. +15 | 预留 | 未来扩展（野怪换宠 / 多段攻击 / 额外特效），不与既有槽位冲突 |
| 野怪战斗掉落（仅野怪战斗，结算时读一次）：base = 40000 | | |
| +0 | 是否掉落 | `rand < 0.2` → 掉落（20%）；否则 `drop=null`，本场不再读 +1 |
| +1 | 掉落品类 | `< 0.6` 伤药 / `< 0.9` 精灵球 / 其余 超级球（60% / 30% / 10%），数量固定 ×1 |

掉落只在**收服成功**（`CAUGHT`）与**击倒野怪**（`WILD_FAINTED`）两个终态结算时派生；两者是同一 eventId 的互斥收尾，因此共用 +0/+1 两个槽位（`POST /wild/:id/action` 的幂等返回不会重复掉落，掉落走 `MintItem` 的确定性 idemKey `<sessionId>-drop`）。状态返回的 `drop` 字段（`{typeId,name,nameZh,quantity,itemId}`，无掉落为 `null`）即本场已发放的实物。

回合块由 8 槽扩为 **16 槽**（2026-09 特效系统上线）：五个掷点/次攻击 + AI 选招 + 平速裁决 = 12 槽，余 4 槽预留。槽位是**按索引寻址**的固定窗口：某槽是否被消费取决于该回合的实际状态（是否麻痹、是否投球/换宠），审计者从会话日志里的状态与动作即可复算同一批槽位；换宠/强制换宠不消耗任何掷点，因此"session.turn 指向下一个将消费掷点的回合块"这一不变式始终成立。

设计理由：

- **分块而非顺序消耗**：第 k 次投掷的结果只取决于 (serverSeed, clientSeed, eventId, k)，与前面投掷多少次无关 → 审计者可以只复核"第 3 次投掷"而不必重放整个会话；失败重试也不会"消耗掉好运"，每次投掷的索引是确定公开的。
- **每块 10 个槽位**：为一个 attempt 的全部属性预留固定窗口，未来加属性（如性别、体型）只需扩窗口语义而不打乱已有索引。
- **遇敌与投掷同事件**：种类/等级在 Commit 后立即派生并展示预览，但 IV/性格/闪光只在捕捉成功后才揭晓——预览不泄露高价值信息，且全流程一次承诺即可覆盖，减少链上交易数。
- **野怪战斗独立区段（20000 / 30000）**：战斗回合的掷点与投球判定互不干扰（否则"多打几回合"会挪动 attempt 块的位置）；两个偏移量与 attempt 块天然不重叠（块要达到 n=20000 需要 2000 次投球）。野怪个体在开场固定（而非每次投球重抽），**战斗里遇到的野怪与最终捕捉到的是同一只**，既保证 HP 显示与铸造结果自洽，也堵住"故意投失重刷个体/闪光"的刷子玩法。
- **战斗掉落独立区段（40000）**：掉落与回合掷点、投球判定互不干扰，只在收服/击倒结算时读 +0/+1 两槽——"多打几个回合""投失几个球"都不会改变掉落结果，且掉落物与它所属的战斗在派生流上一一对应（同一 eventId 完整可复核）。
- **区域等级带 + 付费诱饵都在同一槽位**：等级仍只读 `rand(1)`，映射函数按区域（7 个普通区 `route-grass` Lv2-6 / `forest` Lv4-10 / `route-mid` Lv8-16 / `cave` Lv12-20 / `coast` Lv15-25 / `route-north` Lv17-28 / `volcano` Lv20-30，`docs/backend-api.md` §2 公示）取值，**与玩家队伍等级彻底脱钩**——不存在"抓高级怪→野怪更强"的滚雪球；诱饵是"在同一掷点上加常数（带内 +2/+5，封顶区域上界）/换闪光阈值"——不新增槽位、不可在看过后挑选，加成范围在购买前即已确定。
- **传说区复用同一套槽位（不新增随机）**：6 个传说区（`sky-pillar`/`seafloor`/`magma`/`ruins`/`southern-island`/`birth-island`）的派生布局与普通区**完全一致**——`rand(0)` 在固定传说池内等权抽一个种族（`ruins` 三神柱各 1/3）、`rand(1)` 落在窄等级带（Lv40/45 固定或 Lv45-50），**没有额外的"出不出传说"掷点**：进区即必出该区传说，稀缺性由**钥匙价格（1500P，一次性）+ 每人每区一只**保证，而不是靠低概率。钥匙校验（`KEY_REQUIRED`）、"已拥有"校验（`LEGENDARY_OWNED`）与诱饵拒绝（`LURE_NOT_ALLOWED`）都在 `Commit` 之前完成，被拒时链上不留痕、也没有任何掷点被消费。
- **区域与栖息地写进 `Commit.meta`**：`meta` 恒含 `zone`（规范 id，如 `{"zone":"coast"}` 或 `{"zone":"sky-pillar"}`，付费档追加 `lureTier`/`cost`），因此 n=0 的加权抽样（普通区的"阶段门槛 ∧ 栖息地属性"池、传说区的固定池）与 n=1 的等级带都能被第三方从链上记录独立复算——没有 meta 里的区域，n=0 的"加权索引"就是不可复核的。
- **付费留痕上链**：`Commit` 的可选 `meta`（≤256 字节）恒含区域，付费档追加 `{"lureTier":n,"cost":c}`，与扣费交易 `AddPoints(-c,'lure:tierN')` 一一对应；`GET /fairness/:eventId` 返回该字段，任何人可核对"只付了 0 的遇敌不可能享受 tier 2 的等级/闪光加成"。
- **快速捕捉路径**（`POST /capture/attempt`，兼容/冒烟用）继续使用 attempt 块内的 IV/性格/闪光槽位；两条路径共用同一份 attempt 计数与块索引，互不冲突。

补充：种子脚本 `backend/src/scripts/seed.ts` 用同一 DeriveStream 按 rand(1..8) 布局铸造演示宝可梦（不走 attempt 分块），属于演示数据的简化路径，与捕捉主流程布局不冲突。

## 4. 各业务场景如何消费派生流

| 场景 | 事件 purpose | 消费点 | 消费方式 |
|---|---|---|---|
| 遇敌 | capture | `POST /capture/encounter` | rand(0) 区域野生池加权索引（普通区：`stage ≤ zone.maxStage` ∧ 属性 ∈ 栖息地，权重 60/30/10，种族值总量 ≥500 ×0.3；传说区：固定传说池等权）、rand(1) 带内等级（`zone.minLevel + floor(rand × 带宽)`，诱饵带内 +2/+5 封顶区域上界、传说区禁用诱饵；`zone` 与付费档写入 Commit.meta）；展示预览 |
| 捕捉判定 | capture（同一事件） | `POST /wild/:id/action {type:'ball'}` 与快速捕捉 `POST /capture/attempt` | 块内 +0：`rand < p`，`p = min(1, a/255)`，`a = ((3×maxHP−2×curHP)×catchRate×ballBonus)/(3×maxHP)`；球倍率 精灵球×1 / 超级球×1.5 / 高级球×2 / 大师球×255（`game-data/items.data.ts`，255 → p=1 必中）。快速捕捉等价于满血投球 |
| 个体值 IV / 性格 / 闪光 | 同上 | 捕捉成功时铸造 | 野怪战斗取 20000 区（开场固定，战斗 HP 与铸造结果同源）；快速捕捉取块内 +1..+6 / +7 / +8。闪光阈值可被付费诱饵 tier 2 放大 4 倍（1/4096 → 1/1024），槽位不变 |
| 特性 | — | 铸造 | **不耗随机**：取 species 表固定 ability（P0 简化） |
| 失败反馈 | 同上 | 捕捉失败返回 | 块内 +9 摇晃次数 1..3 |
| 付费诱饵 | 同上 | `POST /capture/encounter {lureTier}` | **不耗随机**：链码 `AddPoints(-cost,'lure:tierN')` 扣费 + `Commit.meta="{zone,lureTier,cost}"` 上链留痕（`/fairness` 可核对） |
| 野怪战斗 | capture（同一事件） | `POST /wild/:id/action`（`wild/wild-battle.ts`） | 30000 区每回合 16 槽：野怪 AI 选招、双方各五个掷点（麻痹/命中/暴击/浮动/追加效果）、平速裁决；伤害/命中/暴击/能力阶级/异常状态与 PvP 共用 `battle-math.ts` |
| 战斗掉落 | capture（同一事件） | 收服成功 / 击倒野怪的结算 | 40000 区：+0 是否掉落（`rand < 0.2`）、+1 品类（60% 伤药 / 30% 精灵球 / 10% 超级球），掉落经 `MintItem` 上链（idemKey `<sessionId>-drop`，重放不重复发放） |
| 战斗判定 | battle | BattleEngine 全程 | 见下 |

战斗事件的派生流由引擎**顺序消耗**（`DeriveStream.next()`）：

| 顺序 | 用途 | 说明 |
|---|---|---|
| 每次攻击 1 | 麻痹检查 | 仅当攻击方处于麻痹状态时消耗：`rand < 0.25` → 本回合无法行动（不产生 move 事件） |
| 每次攻击 2 | 命中判定 | `rand×100 ≥ move.accuracy` → miss |
| 每次攻击 3 | 暴击判定 | `rand < 1/16` → 伤害 ×1.5 |
| 每次攻击 4 | 伤害浮动 | `0.85 + rand×0.15` 乘入伤害公式 |
| 每次攻击 5 | 追加效果 | 仅当技能带 `stat`/`status` 效果时消耗：`rand×100 < chance` → 触发（drain/recoil 不消耗掷点，命中即按比例结算） |
| 速度并列时 | 先手裁决 | `rand < 0.5` 决定 A/B 先手（麻痹速度减半参与比较） |

回合末的灼伤/中毒扣血（`maxHP/16`）不消耗掷点，写入事件流（`status-damage`）供审计复核。

伤害公式（服务端权威，`backend/src/battles/engine/battle-engine.ts`）：
`damage = max(1, floor( floor(((2×level/5+2)×power×atk/def)/50) + 2 × 克制倍率 × (crit?1.5:1) × randFactor ))`，克制查 6 系克制表（normal/dragon 双向中立）。

战斗随机事件的时序与捕捉不同：**开战时 Commit（purpose='battle'），整场战斗的掷点都来自这条流，战斗结束时才 RevealAndVerify**。这样战斗过程中 serverSeed 对双方玩家均不可见（无法预测下一次命中/暴击），而战后种子揭示+回合日志（battle_logs 落库，resultHash=sha256(canonical(回合日志))）使整场判定可逐步重放复核。战斗种子另在 Redis `battle:seed:<battleId>` 备份 24h，防后端进程崩溃导致种子丢失无法揭示（揭示是结算的前置），结算后即删除。

## 5. 安全性质论证

| 性质 | 机制 | 论证 |
|---|---|---|
| 防预测 | serverSeed 32 字节 CSPRNG；揭示前只有 sha256 承诺上链 | sha256 抗原像 ⇒ 玩家/对手在揭示前得不到种子；HMAC 伪随机性 ⇒ 即使见过同一事件的 rand(0)/rand(1)（种类/等级已公开），也无法推算后续槽位 |
| 防操纵（生成方） | 承诺先于使用；clientSeed 搅动；链上重算 | 后端 Commit 后想换种子 ⇒ 揭示时 sha256 不等，SEED_MISMATCH 拒绝；想在 Commit 前挑选种子 ⇒ clientSeed（可玩家提供）+ eventId（uuid）都在承诺时固定，后端无法预知最终流，定向构造需枚举 2^128 级以上输入 |
| 防操纵（使用方） | 种子由服务端生成；clientSeed 格式受限且仅搅动 | 玩家不提供 serverSeed，无法决定流的基值；选 clientSeed 等于"洗一次牌"而非"挑一副牌"，对均匀性无偏向 |
| 防篡改 | 承诺/揭示/消费全部上链，双组织背书 | 任何一方篡改 rand 记录都需同时控制 Org1+Org2 背书；resultHash 与派生流同源，流改则 resultHash 对不上 |
| 防重放 | eventId 唯一 + 状态机 + idemKey 幂等 + 消费一次性 | 重复 Commit 拒绝；重复 Reveal 拒绝；CONSUMED 后不可再消费；同一 idemKey 重放返回首次结果不变更状态 |
| 可审计 | commitHash/serverSeed/clientSeed/resultHash 全量公开；派生算法文档化 | 任何人可用 /fairness 接口与前端页面独立重算全部三个等式与任意 rand(n)，无需信任后端 |
| 不可抵赖 | 战斗结果 resultHash + serverSig(secp256k1) 上链 | 服务端对回合日志签名，事后无法否认其提交的结果；玩家 ConfirmResult 即对结果的链上认可 |

**职责分离小结**：生成方（后端）不知道玩家何时使用、不能换种子；使用方（玩家）看不见种子、搅得动但定不了；验证方（两组织背书的链码 + 公开复核入口）独立重算。三方中任意单方作恶都会被另外两方发现，这正是"生成方/使用方/验证方分离"的落点。

## 6. 前端 /fairness 复核步骤

页面路由 `/fairness`（`frontend/src/views/FairnessView.vue`），输入捕捉返回的 eventId（或战斗事件 `ev_battle_<battleId>`）：

1. 拉取 `GET /api/v1/fairness/:eventId` → 返回链上 RandomCommit（commitHash/clientSeed/resultHash/状态；**COMMITTED 阶段 serverSeed 为空且 `revealed:false`**）、派生算法说明文本、服务端 secp256k1 公钥。结算后再次查询才拿到 `serverSeed` 做完整复算。
2. Web Crypto 重算 `sha256(serverSeed)`，与 commitHash 比对 —— 验证"揭示的种子就是承诺的种子"。
3. 重算 `sha256("${serverSeed}|${clientSeed}|${eventId}")`，与 resultHash 比对 —— 验证"链上锚定的流身份"。
4. 重算 HMAC-SHA256 派生流：捕捉事件按 §3 分块布局复核种类/等级/某次投掷的判定/IV/性格/闪光；战斗事件按 §4 顺序复核麻痹/命中/暴击/浮动/追加效果，并可用 `sha256(canonical(回合日志))==resultHash` 与 secp256k1 公钥验 serverSig；付费诱饵的 `event.meta`（`{zone,lureTier,cost}`）可与扣费交易、等级/闪光阈值变化互证，区域字段则是复算 n=0 加权抽样与 n=1 等级带的前置输入。
5. 页面逐项打勾展示，任一不等即标红——复核不依赖后端返回的"结论"，只用后端返回的"证据"。

## 7. 局限性（诚实声明）

1. **后端在揭示前看得到 serverSeed**。承诺-揭示保证"不能换、必须揭示"，但不保证"没偷看"：运营方内部人员理论上可在揭示前读取 Redis/内存中的种子，提前知道捕捉结果或战斗掷点（ insider threat ）。本系统用"会话 TTL、揭示后删除、日志不记种子"缩小暴露面，但无法根除。
2. **拒绝揭示（reveal withholding）**：后端可以选择永不揭示（如预感到结果不利）。缓解：不揭示则 MintFromCapture/结算无法推进，玩家资产虽被锁定但可随时 Dispute/取消，且 COMMITTED 记录永久留在链上作为作恶证据；战斗侧有 2 分钟 SettleBattle 兜底与仲裁通道；玩家放弃的捕捉由 `capture:pending` 每 5 分钟 sweep 在会话过期后补揭示（H9）。
3. **单生成方**：随机性熵源集中在后端一处，本质上是"可审计的中心化随机"，而非"去中心化随机"。
4. **浮点粒度**：uint64→double 的 2^-53 粒度损失（§2.4），对游戏无影响，但严格密码学抽签场景不可接受。

## 8. 升级路线与代码扩展点

| 方案 | 原理 | 解决什么 | 接入点 |
|---|---|---|---|
| VRF（ecvrf-secp256k1） | 生成方用私钥对 (clientSeed\|eventId) 计算 VRF 输出+证明，任何人用公钥验证输出唯一且正确 | 生成方无法挑选输出（VRF 输出由私钥与输入唯一确定），把"承诺哈希"升级为"可验证函数"；配合承诺公钥上链，可进一步弱化"预计算"空间 | 替换 `DeriveStream` 的熵源：`RandomContract.Commit` 参数增加 `vrfProof`，链码或后端验证证明；`backend/src/fabric/chain.adapter.ts` 的 commitRandom/revealAndVerify 签名是天然扩展点 |
| drand 公共随机信标 | 定期拉取 drand 联盟的轮次随机（BLS 阈值签名，链外可验），以 `rand_beacon(round)` 作为 serverSeed 的替代/混合熵源 | 根除"单生成方可见种子"与"拒绝揭示"——熵来自外部阈值网络，无人可提前知道、无人可扣押 | `CaptureService.encounter` / `BattleManagerService.startBattle` 中种子生成处；承诺内容改为 (drandRound, drandSignature)，揭示改为出示信标轮次 |
| 阈值签名 / 多方掷币（commit-reveal XOR） | 运营方与玩家（或 Org1/Org2 双方）各自提交承诺，双方揭示后 XOR 得最终种子 | 生成方单方不可决定结果，抗击内幕最强 | `RandomContract` 增加第二承诺字段与双方揭示状态机；MockChainAdapter 同步复刻以便测试 |
| 链上 PDC（私有数据集合） | serverSeed 揭示前写 Org1 私有集合 | 种子暂存的机密性从 Redis 移到链上 | `chaincode` 的 RandomContract + 集合配置文件 |

落地优先级建议：P0（现状，承诺-揭示）→ P1 接入 drand 混合熵（改动最小，只在种子生成点）→ P2 VRF 替换派生基值 → P3 多方掷币/阈值签名。所有升级都收敛在两个扩展点内：**链码 `RandomContract`**（承诺/揭示/消费的状态机骨架不变，只换承诺内容与验证逻辑）与**后端 `ChainAdapter` 抽象**（Fabric/Mock 双实现同步演进，业务编排层无感）。
