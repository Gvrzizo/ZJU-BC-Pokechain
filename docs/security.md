# PokeChain 安全设计

> 按作业安全需求七类逐节展开：①身份与权限 ②链码安全 ③随机数安全 ④对战与押注安全 ⑤链下资源安全 ⑥隐私 ⑦可用性与运维。结尾附"已知风险与课程边界"。
> 配套：`docs/architecture.md`（架构与身份体系）、`docs/randomness.md`（随机性完整论证）、`docs/chaincode-api.md` / `docs/backend-api.md`（契约）。

## 1. 身份与权限

### 1.1 双轨身份：Web 会话 + 链上身份

| 层 | 机制 | 实现 |
|---|---|---|
| Web 会话 | JWT access（15min）+ refresh（7d），refresh 白名单存 Redis `refresh:<uid>:<jti>`，刷新即轮换旧 jti 作废；登出吊销 | `backend/src/auth/auth.service.ts` |
| 口令存储 | argon2 哈希（`argon2` 包），登录 `argon2.verify`；口令永不出后端、永不记日志 | 同上 |
| 链上身份 | Fabric CA 注册+enroll 得 X.509；`role` 属性以 ecert 形式写入证书，链码 CID `getAttrValue('role')` 读取；**用户身份**由 CA 自动写入的 `hf.EnrollmentID`（= 注册用户名 = 链上 `playerId`）确定 | `backend/src/fabric/fabric-ca.service.ts`、`chaincode/.../common/cid.ts` |
| 组织归属 | MSP：玩家/运营 Org1MSP，仲裁 Org2MSP；`requireArbitrator` = Org2MSP ∧ role=arbitrator | `network/configtx.yaml`、cid.ts |

### 1.2 权限矩阵与越权校验

| 操作 | 允许的链上角色 | 链码强制点 |
|---|---|---|
| RegisterPlayer 代发 | admin, system（后端注册/seed 用 `ADMIN_IDENTITY`，防抢注 username） | `PlayerContract` requireRole |
| GrantRole | admin | `PlayerContract` requireRole |
| AddPoints / MintItem | admin, system | 同上 |
| Transfer / TransferPoints / ConsumeItem / TransferItem / MergeStacks | owner 本人（`hf.EnrollmentID` == `playerId`）或 system | `assertCallerIsPlayer` |
| RevealAndVerify / MintFromCapture / ApplyGrowth / ActivateBattle / SubmitResult / SettleBattle / Forfeit | system（养成写入也仅 system，玩家证书改不了 level/EV/IV/species/name） | requireRole('system') |
| ConfirmTrade / ConfirmResult / Dispute | 当事人**本人**（`hf.EnrollmentID` 匹配） | NOT_PARTY + `assertCallerIsPlayer` |
| CreateBattle | system 或当事人本人（`hf.EnrollmentID` ∈ {playerA, playerB}） | `getEnrollmentId` 校验 |
| Arbitrate | Org2MSP + arbitrator | `requireArbitrator` |

越权防护在**两层独立实施**：Web 层 `@Roles()` 守卫挡掉非 admin/arbitrator 的 HTTP 调用；链码层 CID 再校验一次——即使后端被绕过（如直接拿到 peer 背书），链码仍会拒绝越权交易。单测覆盖"非 owner 转移/非 arbitrator 仲裁/非 system 提交结果"全部拒绝路径。

**铸造/揭示/养成（2026-10-25 修复 C2/C3）**：`MintFromCapture`、`RevealAndVerify`、`ApplyGrowth` 三笔写入交易均为 system-only。链码仍是「信任后端传入的 IV/EV/level」，它保证的是**玩家拿自己的证书无法自铸宝可梦、无法绕过训练/王冠/糖果直接改属性**；游戏规则的完整链上校验（从 `resultHash` 派生 IV、成本校验）属 P2 扩展点。后端所有合法链路（capture/starter/train/rename/evolve/candy/stone/TM）都由 system 身份代签，`POST /pokemon/:id/moves/learn` 免费学技能入口已下线，技能只来自升级学习表与 TM。

**本人校验（2026-10-25 修复 C1）**：`assertCallerIsPlayer` 比较证书 `hf.EnrollmentID` 与 `player.playerId`，**不再比较 mspId**——所有普通玩家同属 Org1MSP，按组织校验等于「任意玩家可冒充任意玩家」。`hf.EnrollmentID` 由 Fabric CA 在 enroll 时自动写入 ecert，**不得**作为自定义属性显式注册（会被 CA 403 拒绝）；手工签发、缺少该属性的证书一律抛 `NOT_OWNER`，属预期安全行为，旧玩家记录无需迁移（`playerId` 即 enrollment ID）。

### 1.3 API 防线

| 威胁 | 防护 | 实现 |
|---|---|---|
| 重放 | 变更类请求必须带 `X-Nonce`（`^[\w-]{8,128}$`）+ `X-Timestamp`（±300s 时钟窗）；Redis `nonce:<uuid>` SET NX EX 300，重复 → 409 `REPLAY_DETECTED` | `common/interceptors/replay.interceptor.ts` |
| 暴力破解/滥用 | Redis 滑动窗口限流：默认 100 req/min/用户；登录与注册 10 req/min/IP（`@RateLimit`）→ 429 `RATE_LIMITED` | `common/guards/rate-limit.guard.ts`、`auth.controller.ts` |
| SQL 注入 | TypeORM 参数化查询，全仓库无手写 SQL 拼接 | TypeORM Repository |
| XSS | 前端 Vue 模板默认转义（无 `v-html` 渲染用户输入）；helmet 设置 CSP 等安全头 | `main.ts`、前端视图 |
| CSRF | 认证走 `Authorization: Bearer` 头而非 Cookie，跨站表单无法携带；CORS 白名单（`CORS_ORIGINS`）精确列举来源 | `main.ts` |
| 入参畸形 | 全局 `ValidationPipe({whitelist, transform})` + class-validator DTO，多余字段剥离、类型强转 | `main.ts`、各 dto |
| 越权读（BOLA） | `GET /pokemon/:id` 只返回本人资产：非本人与不存在统一 404 `NOT_FOUND`（不泄露 IV/EV/性格，也不泄露资产是否存在）；队伍校验（房间/排位）另行去重，防止「同一只 ×6 条命」 | `pokemon.service::getOneForUser`、`battles.service::assertTeamUnique` |

### 1.4 私钥托管与风险声明

用户 Fabric 私钥由后端托管：enroll 后以 `CERT_ENC_KEY`（64 hex）派生的 AES-256-GCM（随机 12B IV + authTag）加密存 `users.fabric_key_enc`（`common/utils/secret-box.util.ts`）。**风险声明**：课程环境下后端即"私钥托管所"，DB 拖库+密钥泄露=全部链上身份失陷；`CERT_ENC_KEY` 未配置时代码回退到固定的开发用派生密钥（仅适用于本地演示）。生产替代方案：HSM/KMS 托管主密钥、或改为客户端签名（私钥不出浏览器，后端只转发已签名交易）——架构上 ChainAdapter 已把签名收敛在一处，替换成本低。system 身份私钥落盘 `backend/.fabric-certs/system-key.pem`（0o600），同理属课程简化。

### 1.5 管理与仲裁操作留痕

`admin` 的 MintItem / AddPoints / GrantRole 与 `arbitrator` 的 Arbitrate 全部写入 PostgreSQL `audit_logs(actor, action, target, detail, created_at)`（`admin/admin.service.ts`、`battles/battles.service.ts`），与链上事件（`ItemMinted`/`BattleArbitrated`…）形成**链下可检索、链上不可抵赖**的双轨审计。

## 2. 链码安全

### 2.1 确定性纪律

链码禁止 `Date.now()`/`Math.random()`/网络调用；时间一律以 `nowISO` 入参传入（`assertISO` 校验格式），随机性只能来自 RandomContract 验证过的派生流（`docs/randomness.md` §1）。任何非确定性都会在 Org1/Org2 双背书时直接暴露为读写集不一致。

### 2.2 所有权与状态机校验

- 资产状态机：宝可梦/道具 `IDLE | LOCKED_TRADE | LOCKED_BATTLE`（+ 宝可梦 `RELEASED`）；锁定态拒绝转移/消耗/再锁定（`ASSET_LOCKED`）；`lockRef` 记录锁定来源，结算时校验 `lockRef==本单 id` 防止错单解锁。
- 所有权：一切转移/消耗校验 `ownerId==调用者`（或 system）；交易/对战建单时逐项校验双方资产归属与状态。
- **交易只锁发起方 `offer`（2026-10-25 修复 C5）**：`CreateTrade` 对 `request` 只做归属/`IDLE` 预检、不锁定，执行时才在同一笔交易内校验并交换；否则任何知道他人资产 id 的人都能建「请求对方资产」的交易把受害者资产锁死。旧交易（创建时锁了 request）仍可执行/取消/过期。`ttlSeconds` 上限 7 天（后端 DTO + 链码双重限制）。

### 2.3 双花 / 重放 / 溢出

| 威胁 | 防护 |
|---|---|
| 双花 | 资产进入交易/押注即锁定，锁定资产无法进入第二单；积分在 CreateBattle 时即扣入 escrow，CreateTrade 执行时逐项校验余额不足则整体回滚 |
| 重放（链上） | 每笔变更交易带 `idemKey`，`IDEMP:<key>` 命中直接返回首次结果（`withIdempotency`）；随机事件/交易/对战 id 唯一性检查（`RAND_EXISTS`/`BATTLE_EXISTS`） |
| 溢出/负数 | 数量/积分/经验全部非负整数，运算后 `Number.isSafeInteger` 与负值检查（`creditPoints`/`debitPoints` 等公共函数统一收口） |

### 2.4 原子结算

交易第二次 Confirm 与对战确认/兜底/仲裁的结算都发生在**同一笔链码交易**内：交换 owner → 划转积分 → 解锁 → 置终态，任一步失败整体抛错，Fabric 事务语义保证不产生部分结算（`settle` 统一入口，`battle.contract.ts`）。链上不存在"资产已转但积分未付"的中间态。

### 2.5 幂等 / 补偿 / 超时退款

- 幂等：idemKey（§2.3）+ 状态机幂等（重复 confirm 因状态迁移而拒绝或返回首结果）。
- 补偿：交易 `CancelTrade`/`ExpireTrade` 解锁全部资产；对战 `REFUND` 路径全额退还 escrow 与押注资产。
- 超时：交易有 `expiresAt`，过期任何人可触发 `ExpireTrade`（后端列表查询惰性清扫）；对战结果提交后 2 分钟未双确认由 system `SettleBattle` 兜底（§4）。

### 2.6 链码升级治理

链码定义的批准策略为通道级 `MAJORITY Endorsement`（Org1+Org2 各 approve 一次才能 commit，见 `scripts/deployCC.sh` 的 checkcommitreadiness 断言）。升级必须递增 version/sequence 并重新获得两组织批准——**运营方无法单方面升级链码改规则**，这是仲裁方制衡运营方的治理锚点。背书策略同理为 MAJORITY（两 peer 都背书），任一组织宕机则写路径暂停、读路径可用（§7.3）。

## 3. 随机数安全

完整方案与论证见 `docs/randomness.md`，要点摘要：

1. 链码零随机源，随机在链下生成、承诺（sha256）先于使用上链；
2. 揭示时链上重算 `sha256(serverSeed)==commitHash`，不等即 `SEED_MISMATCH` 拒绝；
3. clientSeed 玩家搅动 + eventId 绑定 + HMAC-SHA256 派生流，分块布局公开（`capture-derive.ts`）；
4. 随机事件状态机 COMMITTED→REVEALED→CONSUMED，消费一次性且绑定 purpose/playerId；
5. 任何人可经 `GET /fairness/:eventId` 独立复核全部等式；
6. 已知局限：后端揭示前可见种子（insider threat）、单生成方——升级路线（VRF/drand/阈值掷币）见 randomness.md §8。

## 4. 对战与押注安全

### 4.1 押注锁定不可复用

双方在大厅对押注清单各确认一次；第二次确认时服务端计算 `wagerHash = sha256(canonical({playerA,playerB,wagerA,wagerB}))` 并提交 `CreateBattle`：链码重算校验 wagerHash（`WAGER_HASH_MISMATCH` 防服务端/中间人改清单）、逐项校验资产归属与状态、资产全部置 `LOCKED_BATTLE`、积分立即从双方余额扣入 `escrow`。**已锁定资产不能再开房间、不能再进交易单（ASSET_LOCKED），同一资产也无法出现在双方押注中（重复即拒）**——押注在链上被"焊死"，复用即双花，被状态机拒绝。

### 4.2 结果产生：服务端权威 + 签名 + 双确认 + 兜底

- 战斗判定全部在服务端 BattleEngine 完成（客户端只发意图：`battle:action`），命中/暴击/伤害取自本局已承诺的战斗随机流（`docs/randomness.md` §4）；客户端篡改本地状态无意义——服务端状态才是真相。
- 结束：`resultHash = sha256(canonical(回合日志))`，`serverSig = secp256k1/SHA-256(resultHash)`，`SubmitResult` 仅 system 可提交；回合日志存 `battle_logs` 供回放复核。
- 双方玩家各自 `ConfirmResult`（链上记录 confirmations.A/B），双确认后同事务原子结算。
- **2 分钟兜底**（`BATTLE_SETTLE_FALLBACK_MS=120000`）：一方掉线拒不确认时，system 直接 `SettleBattle`，防止"输不起就装死"冻结对方资产。

### 4.3 异常情形结算规则表

| 情形 | 判定路径 | 结算结果 |
|---|---|---|
| 正常 KO | 引擎 outcome=winner → SubmitResult → 双确认/兜底 | 赢家得双方押注全部宝可梦/道具 + escrow 全部积分；wins/losses +1 |
| 双方同时倒下（double-KO） | 引擎 outcome=draw → SubmitResult("DRAW") → 确认/兜底 | 各自取回自己的押注资产与 escrow 积分；不记胜负 |
| 双方回合都超时（30s 均未行动） | finalize(draw, 'turn-timeout-both') | 同 DRAW |
| 单方回合超时（30s 未行动） | Forfeit(loser=超时方, 'turn-timeout') | 等同认输：对方为赢家立即结算 |
| 掉线 60s 未重连 | disconnect 计时器 → Forfeit(loser=掉线方, 'disconnect') | 对方立即结算为赢家；60s 内重连则取消计时（`playerConnected`） |
| 主动认输（按钮或战斗内 run） | REST `/battles/:id/forfeit` 或引擎 run → Forfeit(loser=自己) | 对方立即结算为赢家 |
| 结果提交后一方不确认 | 5min SettleBattle 兜底 | 按已提交结果结算 |
| 后端进程崩溃/异常中断 | 种子在 Redis 备份 24h；重启后引擎内存态丢失，玩家可 Dispute → 仲裁 | 仲裁按 outcome 结算或 REFUND 全额退款 |
| 争议 | Dispute（终态前任意时刻）→ DISPUTED，资产保持锁定冻结 | Org2 仲裁员 Arbitrate：winnerId/DRAW→按结果结算；REFUND→全额退款（REFUNDED） |

所有路径都汇入链码内部同一个 `settle` 函数，规则唯一、无旁路。

### 4.4 争议冻结与 Org2 仲裁

`Dispute` 将对局置 DISPUTED 且**资产不解锁**——冻结优先于放行，避免争议期间资产被转移销赃。`Arbitrate` 仅 Org2MSP + role=arbitrator 身份可调（链码强制），仲裁结论（outcome + note）连同事件 `BattleArbitrated` 上链，后端另写 `audit_logs`。治理上，Org2 是独立于运营方的第二组织：运营方（Org1）既当裁判又当运动员的风险由"仲裁权在 Org2 + 链码升级需双方批准"双重制衡。

### 4.5 防刷分 / 洗资产讨论

| 手法 | 现状评估 | 已有限制 | 后续可加强 |
|---|---|---|---|
| 大小号互刷战绩/转移积分 | 可能：两个账号对战，小号故意输 | CreateBattle 拒绝 playerA==playerB（同人不同号仍可行）；战绩只是链上计数，无真钱价值 | 同 IP/同设备指纹检测（链下）；对战积分抽水；信誉分 |
| 押注自买自卖洗钱 | 积分可经对战/交易在账号间移动 | 全部流转链上留痕（TransferPoints/TradeExecuted/BattleSettled 事件可审计）；初始积分仅注册 **400** + admin 发放；**注册后 72h 转账锁**（`TRANSFER_LOCKED`，含交易支付方） | 链上行为分析、单日转出限额（链码层可加） |
| 脚本批量注册农场 | 注册即得 **400** 积分，且 72h 内不可转出 | 转账锁 + 注册接口 10 req/min/IP 限流 | 邮箱/手机验证、邀请制（课程外） |
| 利用掉线规则恶心对手 | 故意拖 30s/掉线 | 超时即判负，拖时间只会输 | — |

结论：课程范围内刷分无损他人资产（只能刷自己的两个号），且全链可审计；真上线需叠加链下风控，这是明确的边界外事项。

## 5. 链下资源安全

| 环节 | 措施 | 实现 |
|---|---|---|
| 资源确权 | 链上只存 `uri + metadataHash`（Item/Asset），大文件本体在 MinIO | `ItemContract.MintItem`、`assets` 模块 |
| 完整性校验 | 前端 BootScene 拉 `/assets/manifest`（`[{uri,sha256,size}]`），对 vendor 素材用 Web Crypto 重算 sha256，**校验失败自动回退程序化占位像素图**，游戏不被毒素材阻断 | `frontend/src/game/scenes/BootScene.ts`、`utils/hash.ts` |
| MinIO 权限 | bucket `pokechain-assets`；分发走预签名 URL（限时）；access/secret key 仅后端持有 | `backend/src/assets/assets.service.ts` |
| 防盗链/滥用（建议项） | 生产建议：预签名 URL 短时效 + Referer/UA 策略 + CDN 前置 + 对象级限流；课程环境 MinIO 与后端同机，未启用 | 部署建议（`docs/deployment.md`） |
| 日志脱敏 | 不记录口令、私钥、未揭示的 serverSeed；`users` 实体序列化剔除 passwordHash/fabric*Enc 字段；nestjs 日志级别 error/warn/log | `auth.service.ts` sanitize、`main.ts` |

## 6. 隐私

### 6.1 现状：最小上链

链上只放资产台账与公平性证据：宝可梦（含 IV/性格等游戏数值——属于资产本体，必须公开以供验证）、交易/对局单、随机承诺与揭示值。**口令哈希、证书私钥、捕捉会话、房间状态、聊天、好友关系全部留在链下**；链上不存任何现实身份信息（playerId 即用户名）。链上事件 payload 只含业务主键与结果，不夹带敏感数据。

### 6.2 扩展设计：私有数据集合（PDC）

Fabric Private Data Collection 可在不改架构的前提下增强隐私，两个已识别的场景：

| 场景 | 集合设计 | 数据放置 | 效果 |
|---|---|---|---|
| 隐藏阵容 | `collectionOrg1Only`（或按玩家对） | 出战队伍构成、备用宝可梦的 IV/技能搭配进 PDC，链上主账本只存 `sha256(阵容)` | 对手在开战前无法刺探完整阵容；开战时后端出示明文+哈希供核对 |
| 押注策略 | 对战双方双边集合 `collectionAandB` | wager 明细在双方集合内可见，主账本存 wagerHash（现状已如此，PDC 把"明细"从公开状态移入私有侧） | 第三方只能看到押注哈希与结算结果，看不到押了什么 |

PDC 的 transient 写入+哈希上链与本系统既有的 wagerHash/dnaHash 模式同构，属于自然演进；代价是背书节点需配置 gossip 私有数据分发，课程环境未启用，作为设计扩展说明。

## 7. 可用性与运维安全

### 7.1 应用层韧性

- 限流（§1.3）削峰；Redis 不可用时防重放/限流**降级放行**（fail-open，登录等 IP 类限流除外仍生效）——课程环境优先可用性，生产应改 fail-close 并告警。
- 捕捉会话（1h TTL）、战斗房间（1h TTL）、战斗种子备份（24h TTL）均有界，防 Redis 无限膨胀。
- 战斗计时器（30s 回合 / 60s 掉线 / 5min 结算兜底）保证任何对局**必然终止**，资产不会永久锁定。
- 后端崩溃恢复：链上状态（CREATED/ACTIVE/RESULT_SUBMITTED/DISPUTED）是真相源；内存中的引擎态丢失后，玩家可 Dispute，由仲裁 REFUND——最坏情况是退款，不会错账。

### 7.2 监控告警建议（课程环境未启用，生产清单）

| 指标 | 来源 | 告警建议 |
|---|---|---|
| peer/orderer 容器存活、账本高度 | `docker`、peer operations 端口（9443/9444/8443，已开 prometheus） | 高度停滞 >2min |
| 链码容器（dev-peer0.*）异常退出 | docker events | 出现即告警 |
| 后端 5xx/429 比例、JWT 失败率、REPLAY_DETECTED 计数 | 应用日志/指标 | 突增告警（可能受攻击） |
| DISPUTED 对局积压数 | 链上查询/audit_logs | >0 提醒仲裁员 |
| Redis/PG/MinIO 可用性与容量 | 各自 exporter | 不可用即告警（降级策略随之切换） |

### 7.3 掉线 / 网络分区 / 节点故障处理规则

| 故障 | 影响 | 系统行为与恢复 |
|---|---|---|
| 玩家浏览器掉线 | 战斗中 | 60s 重连窗口（重连自动 `battle:join` 恢复），超时判负；非战斗中无影响 |
| 后端宕机 | 全部 API | 进程内引擎/计时器丢失；链上状态不变；重启后业务以链上为准继续，未结对局走 Dispute/仲裁退款 |
| Redis 宕机 | 会话/房间/限流 | 防重放/限流降级放行；进行中的捕捉会话与房间丢失（链上资产不受影响）；恢复后重建 |
| 单 peer 宕机（任一组织） | 写路径 | MAJORITY 背书需双方 → 写暂停；读路径（本组织 peer）可用；peer 恢复后自动同步区块 |
| orderer 宕机 | 出块停止 | 账本只读；单 Raft 节点恢复后续出块（课程接受单点；生产升 3/5 节点 Raft） |
| CouchDB 宕机 | 对应 peer | peer 跟随不可用，同上规则 |
| 网络分区（宿主机 vs 容器网） | 后端连不上 peer | gateway submit 超时（endorse 15s/submit 5s/commitStatus 60s 截止）返回错误；idemKey 保证重试安全 |
| 整体环境损坏 | — | `./scripts/reset.sh` 全量重建（证书+通道+链码）；`down.sh --purge` 清产物；Mock 模式（FABRIC_MOCK=true）作为无链降级演示路径 |

### 7.4 一键部署与可恢复

`scripts/up.sh` / `deployCC.sh` 幂等（重复执行不重建通道/不重复提交链码），`reset.sh` = down --purge → up → deployCC 全量重来；演示数据 `npm run seed` 全链路幂等（账号按用户名跳过，链上角色/道具/宝可梦均走固定 idemKey + 确定性 id，可安全重跑，见 `backend/README.md`）。详见 `docs/deployment.md`。

## 8. 已知风险与课程边界（诚实清单）

| # | 风险/简化 | 性质 | 边界说明 |
|---|---|---|---|
| 1 | 用户私钥后端托管（AES-256-GCM + DB），未用 HSM/KMS；`CERT_ENC_KEY` 缺省有开发回退值 | 课程简化 | §1.4 已声明，生产必须替换 |
| 2 | 后端揭示前可见 serverSeed，内幕者可预知结果；单生成方随机 | 方案局限 | randomness.md §7，升级路线 §8 |
| 3 | 单节点 orderer、每组织单 peer | 课程拓扑 | 无容错，仅演示；生产多节点 Raft + 多 peer |
| 4 | 默认口令/密钥明文出现于配置（CA admin/adminpw、CouchDB、PG postgres:postgres、JWT dev 默认值） | 课程简化 | 全走 `.env`，生产必须全部轮换 |
| 5 | 防重放/限流在 Redis 宕机时 fail-open | 可用性优先取舍 | §7.1，生产改 fail-close |
| 6 | TypeORM `synchronize=true`（无迁移） | 课程简化 | 生产改 migrations，防启动即改表 |
| 7 | 战斗引擎在服务端内存，崩溃后当局无法续打（资产安全，体验有损） | 架构取舍 | §7.1 兜底=仲裁退款 |
| 8 | `system` 身份权力大（可 Reveal/Mint/Submit/Settle），其私钥保护=服务器文件权限 | 课程简化 | 生产拆分为最小权限多身份 + HSM |
| 9 | 刷分/小号互打仅审计可发现，无主动风控 | 边界外 | §4.5 |
| 10 | 宝可梦形象/名称版权 | 课程演示用途 | 仓库不含版权素材，占位图程序化生成 |
