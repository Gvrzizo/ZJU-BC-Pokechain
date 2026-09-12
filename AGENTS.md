# AGENTS.md — PokeChain 项目指南

基于 Hyperledger Fabric 2.5 的类宝可梦 B/S 链游（课程大作业）。GBA 红/蓝宝石像素风，宝可梦资产仅用于课程演示。

## 仓库结构与技术栈

| 目录 | 技术 | 说明 |
|---|---|---|
| `chaincode/pokemon-cc` | TypeScript, fabric-contract-api 2.5.x, Jest | 6 合约：Player/Random/Pokemon/Item/Trade/Battle |
| `network` | Fabric 2.5.9, CA 1.5.12, CouchDB 0.4.22 | 双组织（Org1 运营/Org2 仲裁）+ 单 Raft orderer，通道 `gamechannel` |
| `backend` | NestJS 10, TypeORM+pg, ioredis, Socket.IO, fabric-gateway | REST `/api/v1` + WS 命名空间 `/battle`；模块：auth/users · pokemon(+capture+**center 治疗**) · wild(野怪战斗) · items/shop(**buy/sell**) · trades · battles(**押注房 + 房名/备注/留言/请踢/屏蔽/押注模板**) · ranked(**排队扩圈/15s 接受期/机器人/积分场 arena/ELO/排行榜/羁绊**) · admin · fairness/assets/leaderboard |
| `frontend` | Vue3 + Phaser 3 + Pinia + Vite | 像素风游戏前端，nginx 反代后端；页面 `/game /bag /shop /pokedex /team /trade /lobby /ranked /battle/:id /starter /admin /fairness` |
| `scripts` | bash | prereq/common（公共库）/up/down/reset/deployCC/seed-demo/e2e-smoke |
| `docs` | 中文 | architecture / chaincode-api / backend-api / randomness / security / deployment |

**权威契约文档**：改链码或 API 前先读 `docs/chaincode-api.md` 和 `docs/backend-api.md`，改完同步更新文档。

**更新纪律（强制）**：任何改动合并前，必须同步更新本 `AGENTS.md` 的相关段落——结构/命令/**测试数**/架构决策四项，
以及受影响模块的清单与页面列表；**子代理任务完成后由主代理核对**本文件是否与代码一致（实测跑一遍三套 `npm test` 并更新计数）。
文档与代码不一致时以代码为准，但要在同一次改动里把文档改回来。

## 常用命令

```bash
# 链码
cd chaincode/pokemon-cc && npm test && npm run build      # 88 单测（8 套）+ tsc
# 后端
cd backend && npm run build && npm test                   # nest build + 295 单测（26 套，内存 mock，免外部服务）
cd backend && npm run seed                                # 演示数据（需先 build；PG/Redis 可达，mock 模式）；npm run seed:dev 免构建
# 前端
cd frontend && npm run build && npm test                  # vue-tsc + vite + 84 单测（vitest，16 个测试文件）
# 全栈演示（mock 链模式，默认）
docker compose up -d --build && ./scripts/seed-demo.sh    # 浏览器 :8080，账号 ash/gary/arbiter/admin 密码 demo1234
# 真链模式（先按根 compose 文件头 [real-fabric] 注释取消 backend 的 volumes/networks 注释）
./scripts/up.sh && ./scripts/deployCC.sh                  # 起 Fabric + 部署链码
FABRIC_MOCK=false docker compose up -d --build
./scripts/e2e-smoke.sh                                    # 端到端冒烟（注册→捕捉→交易→押注对战→结算→公平性复核，25 项断言）
BASE_URL=http://localhost:3100 ./scripts/e2e-smoke.sh     # 打本地实例（本地起 backend 时用，见「环境与服务」）
```

## 关键架构决策（改动前必知）

1. **链码确定性铁律**：禁止 `Date.now()`/`new Date`/`Math.random()`/网络调用。时间一律 `nowISO` 参数传入；随机只能来自 RandomContract 已验证的 `resultHash`。禁止 `invokeChaincode`——跨合约共用 helper 直接操作状态。
2. **承诺-揭示随机数**：`Commit(serverSeed 的 sha256)` 必须先于任何结果使用上链 → `RevealAndVerify` 链上重算 → 派生流 `HMAC-SHA256(key=serverSeed, msg=clientSeed|eventId|n)`，前 8 字节大端 / 2^64。分块布局见 `backend/src/pokemon/capture-derive.ts` 与 `docs/randomness.md`。
3. **幂等**：所有变更交易带 `idemKey`，`idemp:<key>` 命中直接返回首次结果。后端 ContractService 统一注入。
4. **资产状态机**：`IDLE | LOCKED_TRADE | LOCKED_BATTLE`（+宝可梦 `RELEASED`）。锁定资产拒绝转移/消耗/再锁定（`ASSET_LOCKED`）。结算走 BattleContract 内部统一 settle 入口，失败整体回滚，无部分结算。
5. **身份模型**：角色 `player|admin|system|arbitrator` 存 CA 属性；链码用 CID `getAttrValue('role')` + mspId 校验；仲裁要求 Org2MSP + arbitrator。后端托管用户 X.509（AES-256-GCM 存 PG），以用户证书代发交易；system 服务身份用于 CreateBattle/SubmitResult 等。
6. **双链模式**：后端 `ChainAdapter` 抽象有 Fabric 与 Mock 两实现（`FABRIC_MOCK=true` 默认）。Mock 完整复刻链码语义（真实 sha256/HMAC），课堂演示与单测都走它——**改链码行为时必须同步改 MockChainAdapter 与两边测试**。Mock 世界状态存 Redis（键前缀 `mockchain:`，`backend/src/fabric/mock-chain.store.ts`），seed 进程 / backend 进程 / 重跑共享同一份状态；单测不传 store 时退回纯内存。
7. **错误约定**：链码 `throw new Error('CODE: message')`（全大写蛇形码），后端过滤器透传为 `{statusCode, code, message}`。前端 axios 拦截器自动注入 `X-Nonce`/`X-Timestamp`（防重放）与 JWT。
8. **能力值体系**：链上只存种族值表 + IV(0-31) + EV(单项 0-255/总和 ≤510) + 等级 + 性格，最终六项能力值按第三世代官方公式在链下算（`backend/src/game-data/stats.ts`，含 25 种性格 ±10% 修正；HP 不吃性格），战斗 HP 上限/速度/伤害 A/D 与 API `stats` 字段都用该最终值；改公式须同步链码 EV 校验、MockChainAdapter、前端展示与文档。详见 `docs/backend-api.md` §2「能力值计算」。
9. **积分经济（2026-09 全面重平衡：收紧 faucet、抬升 sink、让稀有道具真正稀有）**。积分是链上游戏发行资产，只能由 `admin`/`system` 经 `PlayerContract.AddPoints` 增减（reason 可审计），口径集中在 `backend/src/pokemon/points-economy.ts`：
   - **faucet（日收入约 100–300P）**：注册 1000 / **收服 +20** / **击倒 野怪等级×1** / **放生 等级×1** / 押注赢取 / **积分场 arena**（准入青铜 20 白银 50 黄金 100 白金 200 大师 400，胜者得双方准入 + 准入 50% 补贴，每人每日补贴上限 3 次、分差 >400 与机器人场不发）；**PvP 只给经验不给积分**。
   - **sink**：训练（只加 EV，1 积分=4 EV）、付费诱饵（50/200）、商店购买（`POST /shop/buy`，价目见下）、押注托管、积分场准入、**宝可梦中心治疗（每次 10P）**。
   - **商店定价**（`backend/src/shop/shop.data.ts`，回收=半价向下取整）：精灵球 50 / 超级球 150 / 高级球 400 / 伤药 50 / 好伤药 120 / 进化石 800 / TM 1500 / 银色王冠 3000 / 金色王冠 15000 / 神奇糖果 1000；大师球非卖品。**高级球 ≈ 2-3 天积累、王冠 = 月级目标**。
   - 野怪掉落 `wild.service::grantDrop`（收服或击倒 20%：伤药/球）。发奖励一律用**确定 idemKey**（如 `<pokemonId>-reward-catch`），重放动作不会重复加分。
   - 新手礼包 `POST /users/me/starter`（注册后仅一次，御三家 speciesId 1/4/7，事件 id=`starter-<username>`，`GET /users/me` 的 `hasStarter` 由该随机事件是否 CONSUMED 判定），前端 `/starter` 页由 `frontend/src/router/guard.ts::needsStarter` 守卫。
   - 详见 `docs/backend-api.md` §3（价目表）与 §10（积分经济）。
10. **养成与升级路径**：**积分只换努力值**（`POST /pokemon/:id/train` 只加 EV，1 积分=4 EV，不改 exp/level）、**等级只靠战斗经验与神奇糖果**（野怪击倒 / 收服 +20 exp / PvP 胜 +30 / `rare-candy` +1 级）、**个体值只靠王冠**（`bottle-cap` 单项、`gold-bottle-cap` 六项 → 31）。所有经验走 `PokemonService.applyExp`（曲线 `level=floor(cbrt(exp))`，按学习表学技能，返回 `{levelsGained,movesLearned,canEvolve}`）；**升级学习表** `backend/src/game-data/learnsets.data.ts` 由 `node tools/gen-learnsets.mjs` **确定性生成**（386 族各 4-8 条），改算法只改脚本再重跑。进化 `POST /pokemon/:id/evolve`：不带 `stoneItemId` = 等级进化、带 = 进化石；详情/图鉴带 `evolution(s)` 进化链。详见 `docs/backend-api.md` §2。
11. **排位与羁绊**：`backend/src/ranked/` 负责排队匹配/ELO/排行榜（Redis `ranked:*`）与羁绊挂钩（`BondService`，对局 SETTLED 后按战果发放）。匹配窗口从 ±200 起每 10 秒扩 50（上限 ±1000），配到后双方各 15 秒接受期（`MATCH_PENDING` → `accept`/`decline`，拒绝方 30 秒内窗口重置 ±200）才建房；排队满 60 秒可打**机器人**（链上 `BOT` 玩家 + 内存 3 只队伍，出招走派生流，奖励减半、每日 5 场）；`mode:'arena'` 是**积分场**（见决策 9）。**羁绊长线化**：`Pokemon.bond`（0-255）铸造 50、**易主（转移/交易/押注被赢走）重置 30**、**PvP 胜 +2 / 负 +1 / 平 +1**（机器人场 ×0.5 向下取整）、**野怪收服 +1 / 击倒不给**、**每日每宠上限 +6**（Redis `bond:day:<pokemonId>:<yyyy-mm-dd>` 哈希记账，超出截断、重放不重复占额度）；**羁绊 ≥200 前端显示「灵魂搭档」徽章**（`frontend/src/ui/BondHearts.vue`，链上无新字段）。提升一律走 `BondUp`（system 身份，幂等键 `<battleId|sessionId>-bond-*`，255 截断）。详见 `docs/backend-api.md` §11。
12. **伤势持久化（HP 跨战斗保留）**：链上**不存 HP**——当前 HP 存链下 Redis `poke:hp:<pokemonId>`（`backend/src/pokemon/pokemon-hp.service.ts`），**缺键 = 满血**（上限 = `computeStats().hp`），越界夹到 `[0, maxHp]`，无需数据迁移，Redis 丢失只损失伤势不损失资产。写入时机：野怪会话每次落盘（`wild.service::save`）、PvP 引擎终局（`battles.service` 的 `end` 钩子写回双方参战队伍）；出战注入 `EngineMonInput.currentHp`（`wild.service::toCombatant`、`battles.service::loadTeam`、`ranked/battle-launcher::loadTeam`）。**濒死（0 HP）不能出战/不能进队伍提交**：野怪 `FAINTED`；PvP 房间 `assertTeamOwnership`（提交与押注双确认前各一次，链上资产此时尚未锁定）；**排位 `ranked.service::assertTeam` 入队即校验**（`/ranked/queue` 409 `FAINTED` 并指明是哪只，arena 同样、未扣准入）。前端 `RankedView` 队伍勾选与大厅 `WagerPicker` 的濒死成员灰显禁选并提示。恢复只有两条：伤药 `potion`/`super-potion` +20/+50（`POST /items/:id/use {targetPokemonId}`，满血抛 `HP_FULL`）与**宝可梦中心 `POST /pokemon/center/heal`（全队回满，每次 10P `reason='heal:center'`，全员满血不扣费）**；放生会清掉伤势键。API 的 `GET /pokemon` 每只带 `currentHp`/`fainted`。详见 `docs/backend-api.md` §2「伤势持久化」。

## 环境与服务

- 端口：前端 8080、后端 3000、PG 5432、Redis 6379、MinIO 9000/9001；Fabric：orderer 7050、peer0.org1 7051、peer0.org2 9051、CA 7054/8054（CouchDB 不暴露宿主机）。
- 两个独立 docker 网络：`network/docker-compose.yaml`（pokechain_net，Fabric）与根 `docker-compose.yaml`（pokechain_app_net，应用）。真链模式互联方式见根 compose 文件头 `[real-fabric]` 注释。
- 域名体系 `*.pokechain.com`（不是 example.com）。Fabric 用户证书路径：`network/organizations/`。
- **本地起实例验证（不动 compose）**：用容器里的 PG/Redis/MinIO，`PORT=3100 FABRIC_MOCK=true MINIO_MOCK=true DATABASE_URL=postgres://pokechain:pokechain@localhost:5432/pokechain REDIS_URL=redis://localhost:6379 JWT_SECRET=pokechain-dev-secret-change-me-in-prod node backend/dist/main.js`（mock 世界状态在共享 Redis `mockchain:*`，与容器里的 3000 实例共享同一份演示链状态）；冒烟用 `BASE_URL=http://localhost:3100 ./scripts/e2e-smoke.sh`。
- 字体系统：**自托管像素字体，不依赖外网 CDN**——拉丁/数字用 Press Start 2P（8×8 点阵），中文用缝合像素字体 Fusion Pixel 12px（12×12 点阵，字形上移 2 格对齐 + 行盒钉成 ascent 1em/descent 0），见 `frontend/src/styles/fonts.css` 与生成脚本 `frontend/tools/align-cjk-font.py`；字号必须取 8px/12px 的整数倍。

## 常见坑

- 本机其他项目可能装有 Fabric 2.4 二进制——`scripts/prereq.sh` 会把 2.5.9 下到 `network/bin` 并前置 PATH，不要混用。
- `up.sh`/`deployCC.sh` 幂等可重跑；锚节点已是期望值时打印"跳过更新"（INFO，非报错）；链码首次部署慢（peer 容器内 npm install + tsc）。
- `npm run seed` 全链路幂等（账号/链上角色/道具/宝可梦均固定 idemKey + 确定性 id，可安全重跑补数据）；mock 链状态在 Redis（`mockchain:*`），只有清空 Redis（`docker compose down -v`、重建 redis 容器、`redis-cli flushall`）才会丢，重跑 seed 即可恢复。
- **单测里的 ioredis-mock 在同进程内共享数据**：跨用例复用的宝可梦 id 会带上一个用例留下的链下 HP（`poke:hp:*`），
  需要满血队伍的用例要显式清理（`test/helpers.ts` 的 `seedPokemon` 已默认清掉 seed 宝可梦的 HP 键；直接 mint 的走 `makeHpService`/`redis.client.del`）。
- **别在队伍提交之后才校验伤势**：链上 `CreateBattle` 锁资产且不可回滚，所以 `battles.service::confirmWager` 在锁资产**前**会重新跑一次 `assertTeamOwnership`（含濒死检查）；`loadTeam` 只注入 HP、不再抛错，否则会留下"链上 ACTIVE、本地无引擎"的孤儿对局。
- 真链已知限制：仲裁演示走 mock（后端只接 Org1 CA）；seed 账号无托管证书，用注册页新账号；admin 映射 system 证书故真链 `GrantRole` 受限。详见 `docs/deployment.md`。
- backend Node 镜像无 curl，健康检查用 wget：`GET /api/v1/health`。

## 编码约定

- 全仓库 TypeScript + 中文文档；注释现状：backend 注释克制（英文）、frontend/chaincode 有适量中文注释——沿用所在文件风格，不写解释性废话注释。
- 后端：class-validator 全入参白名单；TypeORM 参数化；日志不记密码/私钥/serverSeed 明文。
- 前端：新页面挂 Vue Router + 路由守卫；Phaser 场景在 `src/game/scenes/`；宝可梦素材放 `frontend/public/assets/vendor/`（命名约定见 frontend/README.md），运行时 sha256 校验失败回退占位图；UI 组件复用 `src/ui/`（`HpBar` 显示当前/最大 HP、`BondHearts` 显示羁绊与灵魂搭档徽章）。
- 测试纪律：链码改交易→补 Jest 用例（手写 mock harness `tests/helpers/harness.ts`）；后端改业务→补 `backend/test/`（内存 mock 链 + ioredis-mock）；前端组件/纯函数用 vitest（Vue 组件用 `renderToString` 的 SSR 渲染测试）；提交前三套 `npm test` 全绿，并把本文件里的测试计数改到实测值。

## P2 扩展点（未实现，勿当 bug）

VRF/drand 随机预言机（RandomContract/ChainAdapter 抽象已留口）、私有数据集合、战斗回放验证页、HSM/KMS、监控告警。设计见 `docs/security.md`、`docs/randomness.md`。
