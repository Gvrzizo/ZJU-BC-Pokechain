# AGENTS.md — PokeChain 项目指南

基于 Hyperledger Fabric 2.5 的类宝可梦 B/S 链游（课程大作业）。GBA 红/蓝宝石像素风，宝可梦资产仅用于课程演示。

## 仓库结构与技术栈

| 目录 | 技术 | 说明 |
|---|---|---|
| `chaincode/pokemon-cc` | TypeScript, fabric-contract-api 2.5.x, Jest | 6 合约：Player/Random/Pokemon/Item/Trade/Battle |
| `network` | Fabric 2.5.9, CA 1.5.12, CouchDB 0.4.22 | 双组织（Org1 运营/Org2 仲裁）+ 单 Raft orderer，通道 `gamechannel` |
| `backend` | NestJS 10, TypeORM+pg, ioredis, Socket.IO, fabric-gateway | REST `/api/v1` + WS 命名空间 `/battle`；模块：auth/users · pokemon(+capture+**center 治疗**) · wild(野怪战斗) · items/shop(**buy/sell**) · trades · battles(**押注房 + 房名/备注/留言/请踢/屏蔽/押注模板**) · ranked(**排队扩圈/15s 接受期/机器人/积分场 arena/ELO/排行榜/羁绊**) · admin · fairness/assets/leaderboard |
| `frontend` | Vue3 + Phaser 3 + Pinia + Vite | 丰缘像素菜单（统一主题/导航/卡片）+ 原作瓦片/完整 2×2 大树/1×2 小树/岩壁方向块/整栋建筑拼接（`native-map.ts` / `world-art.ts`）+ 原作四向人物（自绘仅缺图回退），nginx 反代后端；页面 `/game /bag /shop /pokedex /team /trade /lobby /ranked /battle/:id /starter /admin /fairness /login /register` |
| `scripts` | bash | prereq/common（公共库）/up/down/reset/deployCC/seed-demo/e2e-smoke |
| `docs` | 中文 | architecture / chaincode-api / backend-api / randomness / security / deployment / **setup（环境复刻）** / **visual-design（视觉与地图约定）** |

**权威契约文档**：改链码或 API 前先读 `docs/chaincode-api.md` 和 `docs/backend-api.md`，改完同步更新文档。

## Agent 环境复刻（干净 clone 后的速查清单）

```bash
node scripts/fetch-assets.mjs                    # 宝可梦 sprite/叫声/道具图标（PokeAPI，幂等可重跑）
python3 frontend/tools/build-world-assets.py     # 世界瓦片（需 Pillow；输出路径已固定为 frontend/public/...，与 cwd 无关）
docker compose up -d --build && ./scripts/seed-demo.sh
./scripts/e2e-smoke.sh                           # 25 项断言全绿 = 环境就绪
```
注意：`frontend/public/assets/vendor/`（版权素材）、`network/organizations`、`network/bin` 不在 git 内；跳过素材也能跑（前端回退程序化占位图）。人类读者的完整版见 `docs/setup.md`。

**本轮验证（2026-10-25）**：重新摆放镇/草原/森林/海岸/孤岛树木，纠正此前把树底连接块叠成第三行的错误；完整大树为 2×2、小树为 1×2，使用显式位置和同一份碰撞占地，取消残格补半截树冠。实测链码 95 单测（8 套）、后端 373 单测（32 套）、前端 200 单测（33 个文件）全绿，另有 4 项离线 Python 切片回归测试全绿，前端构建通过；本地前端容器已重建并浏览器复核树木布局。此前 2026-10-21 已验证三端构建、端到端 25/25；2026-10-18 的免测试例外仅属于此前改造。视觉约定与生成提示词见 `docs/visual-design.md`、`frontend/art/prompts.json`。

**更新纪律（强制）**：任何改动合并前，必须同步更新本 `AGENTS.md` 的相关段落——结构/命令/**测试数**/架构决策四项，
以及受影响模块的清单与页面列表；**子代理任务完成后由主代理核对**本文件是否与代码一致（实测跑一遍三套 `npm test` 并更新计数）。
文档与代码不一致时以代码为准，但要在同一次改动里把文档改回来。
**Git 纪律**：仓库已初始化（main 分支）。每完成一个功能/修复批次：三套测试全绿 → 更新本文件 → `git add -A && git commit`（中文约定式提交，如 `feat(battle): 实时战斗日志`）；不把 `node_modules/`、构建产物、`network/organizations`、`frontend/public/assets/vendor/`（版权素材，本地投放）提交入库。

## 常用命令

```bash
# 链码
cd chaincode/pokemon-cc && npm test && npm run build      # 95 单测（8 套）+ tsc
# 后端
cd backend && npm run build && npm test                   # nest build + 373 单测（32 套，内存 mock，免外部服务）
cd backend && npm run seed                                # 演示数据（需先 build；PG/Redis 可达，mock 模式）；npm run seed:dev 免构建
# 前端
cd frontend && npm run build && npm test                  # vue-tsc + vite + 200 单测（vitest，33 个测试文件）
# 世界素材切片回归（Python 3 + Pillow，无需外部素材/网络）
python3 -m unittest discover -s frontend/tools -p 'test_*.py' # 4 项
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
5. **身份模型**：角色 `player|admin|system|arbitrator` 存 CA 属性；链码用 CID `getAttrValue('role')` + mspId 校验；仲裁要求 Org2MSP + arbitrator。**「本人」校验用 CA 自动写入的 `hf.EnrollmentID`（= 注册用户名 = 链上 `playerId`，`common/cid.ts::getEnrollmentId`），不用 mspId**——所有玩家同属 Org1MSP，按组织校验等于没校验；缺该属性的证书一律 `NOT_OWNER`，不回退 mspId。`RegisterPlayer` 仅 `admin|system`（防抢注 username）。**链上养成写入（`MintFromCapture`/`RevealAndVerify`/`ApplyGrowth`）仅 system**：玩家证书不能自铸或自改 level/EV/IV/species/name。后端托管用户 X.509（AES-256-GCM 存 PG），以用户证书代发交易；system 服务身份用于 CreateBattle/SubmitResult 等。
6. **双链模式**：后端 `ChainAdapter` 抽象有 Fabric 与 Mock 两实现（`FABRIC_MOCK=true` 默认）。Mock 完整复刻链码语义（真实 sha256/HMAC），课堂演示与单测都走它——**改链码行为时必须同步改 MockChainAdapter 与两边测试**。Mock 世界状态存 Redis（键前缀 `mockchain:`，`backend/src/fabric/mock-chain.store.ts`），seed 进程 / backend 进程 / 重跑共享同一份状态；单测不传 store 时退回纯内存。
7. **错误约定**：链码 `throw new Error('CODE: message')`（全大写蛇形码），后端过滤器透传为 `{statusCode, code, message}`。前端 axios 拦截器自动注入 `X-Nonce`/`X-Timestamp`（防重放）与 JWT。
8. **能力值体系**：链上只存种族值表 + IV(0-31) + EV(单项 0-255/总和 ≤510) + 等级 + 性格，最终六项能力值按第三世代官方公式在链下算（`backend/src/game-data/stats.ts`，含 25 种性格 ±10% 修正；HP 不吃性格），战斗 HP 上限/速度/伤害 A/D 与 API `stats` 字段都用该最终值；**羁绊加成**：非 HP 五项再 ×(1 + bond/255 × 5%)（满羁绊 +5%，向下取整，`computeStats` 的 bond 参数，PvP/野怪战斗均已接入；API 返回 `bondBonus` 百分比）。改公式须同步链码 EV 校验、MockChainAdapter、前端展示与文档。详见 `docs/backend-api.md` §2「能力值计算」。
9. **积分经济（2026-09 全面重平衡：收紧 faucet、抬升 sink、让稀有道具真正稀有）**。积分是链上游戏发行资产，只能由 `admin`/`system` 经 `PlayerContract.AddPoints` 增减（reason 可审计），口径集中在 `backend/src/pokemon/points-economy.ts`：
   - **faucet（日收入约 100–300P）**：注册 1000 / **收服 +20** / **击倒 野怪等级×1** / **放生 等级×1** / 押注赢取 / **积分场 arena**（准入青铜 20 白银 50 黄金 100 白金 200 大师 400，胜者得双方准入 + 准入 50% 补贴，每人每日补贴上限 3 次、分差 >400 与机器人场不发）；**PvP 只给经验不给积分**。
   - **sink**：训练（只加 EV，1 积分=4 EV）、付费诱饵（50/200）、商店购买（`POST /shop/buy`，价目见下）、押注托管、积分场准入、**宝可梦中心治疗（每次 10P）**。
   - **商店定价**（`backend/src/shop/shop.data.ts`，回收=半价向下取整）：精灵球 50 / 超级球 150 / 高级球 400 / 伤药 50 / 好伤药 120 / 进化石 800 / TM 1500 / 银色王冠 3000 / 金色王冠 15000 / 神奇糖果 1000；大师球非卖品。**高级球 ≈ 2-3 天积累、王冠 = 月级目标**。
   - 野怪掉落 `wild.service::grantDrop`（收服或击倒 20%：伤药/球）。发奖励一律用**确定 idemKey**（如 `<pokemonId>-reward-catch`），重放动作不会重复加分。
   - 新手礼包 `POST /users/me/starter`（注册后仅一次，御三家 speciesId 1/4/7，事件 id=`starter-<username>`，`GET /users/me` 的 `hasStarter` 由该随机事件是否 CONSUMED 判定），前端 `/starter` 页由 `frontend/src/router/guard.ts::needsStarter` 守卫。
   - 详见 `docs/backend-api.md` §3（价目表）与 §10（积分经济）。
10. **养成与升级路径**：**积分只换努力值**（`POST /pokemon/:id/train` 只加 EV，1 积分=4 EV，不改 exp/level）、**等级只靠战斗经验与神奇糖果**（野怪击倒 / 收服 +20 exp / PvP 胜 +30 / `rare-candy` +1 级）、**个体值只靠王冠**（`bottle-cap` 单项、`gold-bottle-cap` 六项 → 31）。所有经验走 `PokemonService.applyExp`（曲线 `level=floor(cbrt(exp))`，按学习表学技能，返回 `{levelsGained,movesLearned,canEvolve}`；链上 `ApplyGrowth` 仅 system 身份代签）；**升级学习表** `backend/src/game-data/learnsets.data.ts` 由 `node tools/gen-learnsets.mjs` **确定性生成**（386 族各 4-8 条），改算法只改脚本再重跑。进化 `POST /pokemon/:id/evolve`：不带 `stoneItemId` = 等级进化、带 = 进化石；详情/图鉴带 `evolution(s)` 进化链。详见 `docs/backend-api.md` §2。
11. **排位与羁绊**：`backend/src/ranked/` 负责排队匹配/ELO/排行榜（Redis `ranked:*`）与羁绊挂钩（`BondService`，对局 SETTLED 后按战果发放）。匹配窗口从 ±200 起每 10 秒扩 50（上限 ±1000），配到后双方各 15 秒接受期（`MATCH_PENDING` → `accept`/`decline`，拒绝方 30 秒内窗口重置 ±200）才建房；排队满 60 秒可打**机器人**（链上 `BOT` 玩家 + 内存 3 只队伍，出招走派生流，奖励减半、每日 5 场）；`mode:'arena'` 是**积分场**（见决策 9）。**羁绊长线化**：`Pokemon.bond`（0-255）铸造 50、**易主（转移/交易/押注被赢走）重置 30**、**PvP 胜 +2 / 负 +1 / 平 +1**（机器人场 ×0.5 向下取整）、**野怪收服 +1 / 击倒不给**、**每日每宠上限 +6**（Redis `bond:day:<pokemonId>:<yyyy-mm-dd>` 哈希记账，超出截断、重放不重复占额度）；**羁绊 ≥200 前端显示「灵魂搭档」徽章**（`frontend/src/ui/BondHearts.vue`，链上无新字段）。提升一律走 `BondUp`（system 身份，幂等键 `<battleId|sessionId>-bond-*`，255 截断）。详见 `docs/backend-api.md` §11。
12. **伤势持久化（HP 跨战斗保留，仅野怪/PvE）**：链上**不存 HP**——当前 HP 存链下 Redis `poke:hp:<pokemonId>`（`backend/src/pokemon/pokemon-hp.service.ts`），**缺键 = 满血**（上限 = `computeStats().hp`），越界夹到 `[0, maxHp]`，无需数据迁移，Redis 丢失只损失伤势不损失资产。**PvP（排位/房间/机器人）一律满血出战、赛后不回写**（`battle-manager::startBattle` 统一 `withFullHealth()`，竞技不消耗真实伤势）；写入时机只剩野怪会话落盘（`wild.service`）；出战注入 `EngineMonInput.currentHp` 仅野怪路径（`wild.service::toCombatant`）。**濒死（0 HP）不能出战/不能进队伍提交**：野怪 `FAINTED`；PvP 房间 `assertTeamOwnership`（提交与押注双确认前各一次，链上资产此时尚未锁定）；**排位 `ranked.service::assertTeam` 入队即校验**（409 `FAINTED` 并指明是哪只，arena 同样、未扣准入）。前端 `RankedView` 队伍勾选与大厅 `WagerPicker` 的濒死成员灰显禁选并提示。恢复只有两条：伤药 `potion`/`super-potion` +20/+50（`POST /items/:id/use {targetPokemonId}`，满血抛 `HP_FULL`）与**宝可梦中心 `POST /pokemon/center/heal`（全队回满，每次 10P `reason='heal:center'`，全员满血不扣费）**；放生会清掉伤势键。API 的 `GET /pokemon` 每只带 `currentHp`/`fainted`。详见 `docs/backend-api.md` §2「伤势持久化」。
13. **多地图世界与遇敌**（`frontend/src/game/maps/` 15 张数据驱动地图 + `backend/src/game-data/encounter.data.ts`）：未白镇（安全区，宝可梦中心/道具店/NPC）+ 7 个普通区（草原 Lv2-6/森林 Lv4-10/山径 Lv8-16/洞窟 Lv12-20/海岸 Lv15-25/高原 Lv17-28/火山 Lv20-30，stage 门槛递增）+ 6 个传说区（天空之柱/海底洞窟/熔岩洞窟/古代遗迹/南方孤岛/诞生岛）。**栖息地过滤**：每区只出对应属性的宝可梦（18 属性全覆盖，池 29-78 种）；稀有度按捕获率加权（常见 60/少见 30/稀有 10，种族值 ≥500 再 ×0.3）；等级只取带内随机，**与玩家队伍等级彻底脱钩**；付费诱饵带内 +2/+5 封顶（传说区禁诱饵）。**传说门控**：进特殊区需对应钥匙道具（6 把，商店 5000P，持有即通行不消耗，`KEY_REQUIRED`）；每人每池限一只（已拥有则 `LEGENDARY_OWNED`，放生/转手后可再捕）；池内仅对应传说（烈空坐/盖欧卡/固拉多/三神柱/拉帝亚斯欧斯/代欧奇希斯），固定高等级。别名 `south/mid/north`→三个 route 区（e2e 兼容）。派生槽 n=0=区域加权索引、n=1=带内等级，`Commit.meta` 带 `{"zone":...}`。段位显示名：新人训练家/精英训练家/道馆馆主/四天王/联盟冠军（内部 id 不变）。世界素材：`native-map.ts` 直接拼接原作 metatile，道路/岸线按象限过渡，`wall` 连续岩壁按 `wallTiles` 选择完整方向块（门/楼梯保持墙体连续，窄凸起用巨石）；`rock` 独立石块不再合成岩壁，陆地巨石由原作前景叠在对应地面（图集保留位 1024），无海水底色。树木由 `maps/trees.ts` 明确摆放并写入 `MapDef.trees`：大树 2×2（468/469 + 484/485 收口），小树 1×2（14 树冠 + 22 树干）；476/477 是林带连接块，不与 484/485 上下重复叠加。边界使用完整大树，内部少量小树点缀，放不下时留出入口空隙，不把残格铺成半截树冠矩阵；布局只落在完整草地上并避让 NPC/出生点/传送点/路牌，碰撞与图片共用占地；整栋建筑与碰撞占地一致；`world-art.ts` 只负责 Phaser 缓存。`frontend/tools/build-world-assets.py` 固定 pokeemerald 版本，输出 5 张多行图集（覆盖 14 种 biome）及 51 张人物/建筑/战斗图片到 `frontend/public/assets/vendor/world/`（不入库，干净 clone 需重跑）。`manifest.json` v2 记录语义映射、邻接块、完整岩壁方向块和 sha256；NPC/主角优先原作，16×32 成人完整放大至 32×64，16×16 小孩按比例放大为 32×32 后脚底对齐到透明 32×64 画布，不抽行、不拉高、不裁头。水/岩浆使用原作动画首帧，缺素材才回退程序化；塔柱由原作石柱前景与塔内地板叠加。未白镇建筑按原作尺寸落位，天空之柱调整柱间空隙，地图连通性与传送规则沿用。详见 `docs/randomness.md` §3、`docs/backend-api.md` §2。
14. **房间与排位队伍规则**：出战队伍限 **1-6 只**（房间/排位统一 `assertTeamSize`，`INVALID_TEAM_SIZE`）；房主可 `DELETE /battles/rooms/:id`（仅 WAITING，有人先 kick）；房间详情带 `teamDetailA/B` 富化阵容（任何人可看）；排位 `MATCH_PENDING` 时返回对手阵容（**裁剪掉 IV/EV/性格/羁绊**，仅 name/level/shiny/stats）。宝可梦改名 `POST /pokemon/:id/rename`：首次免费、之后 50P（PG 表 `pokemon_rename` 计数），昵称存链上 name 字段、进化后保留。PvP 战斗实时日志：引擎 `publicState().log` 逐回合推送结构化事件，前端 `game/battle-log.ts` 渲染中文文案（i18n 名称在前端，故文案不后端生成）。
15. **世界交互细节**：地图数据工具 `maps/builders.ts`、显式树木布局 `maps/trees.ts`（blob/pond/road/flowerCluster；road 端点按左上角精确铺设，不额外向最小坐标外扩格），改图必须跑 `maps.test.ts` 的连通性/落点硬约束并渲染截图自查（启动前端 dev 后打开 `/tools/world-preview.html`，共享游戏的 `native-map.ts`，可一次预览全部 15 张图）。**跑鞋**：`running-shoes` key 道具（未白镇 `(9,18)` 面向南的「妈妈」NPC 赠送，`POST /users/me/running-shoes` 幂等领取），按住 Shift 移动与动画 ×2（`game/running.ts`）。**HUD 避让**：玩家进入左上区域（x<宽/2 且 y<高/3）时 WorldHud 平滑移到右上（`stores/world.ts::hudAvoidsPlayer`）。**游戏页保活**：App.vue `KeepAlive include GameView`，切走 sleep（loop+音频），20 分钟内回来原地续玩，超时销毁重建（`GameView` 的 `KEEP_ALIVE_TTL_MS` + `data-game-build`）。

16. **统一视觉规范**：全站主题/间距/焦点/响应式在 `frontend/src/styles/pixel.css`；`PixelIcon` 用于导航，`ItemArtwork` 仅道具缺图回退。跑鞋使用 GPT Image 生成的 `public/assets/generated/items/running-shoes.png`（32×32、透明底），登录/注册共用 `generated/ui/hoenn-welcome.png`（384×256）；原图和完整提示词保存在 `frontend/art/`，仅做最近邻缩放/限色，没有 SVG 重描。其余道具与宝可梦沿用 vendor 素材。人物按脚底对齐，原作 32×64/帧画布（小孩内容 32×32、透明补齐）；兼容旧 32×32 与自绘回退 32×40。战斗背景使用原作草地 240×112，整数 4 倍绘制；HUD/状态框沿用统一主题。页面路由不变。详见 `docs/visual-design.md`。

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
- 前端 nginx 同时监听 IPv4/IPv6（`listen 80` / `[::]:80`），使容器 `localhost` 健康检查可达；world manifest 不缓存，图片 URL 带内容哈希以更新素材。
- backend Node 镜像无 curl，健康检查用 wget：`GET /api/v1/health`。

## 编码约定

- 全仓库 TypeScript + 中文文档；注释现状：backend 注释克制（英文）、frontend/chaincode 有适量中文注释——沿用所在文件风格，不写解释性废话注释。
- 后端：class-validator 全入参白名单；TypeORM 参数化；日志不记密码/私钥/serverSeed 明文。
- 前端：新页面挂 Vue Router + 路由守卫；Phaser 场景在 `src/game/scenes/`；宝可梦素材放 `frontend/public/assets/vendor/`（命名约定见 frontend/README.md），运行时 sha256 校验失败回退占位图；UI 组件复用 `src/ui/`（`HpBar` 显示当前/最大 HP、`BondHearts` 显示羁绊与灵魂搭档徽章）。
- 测试纪律：链码改交易→补 Jest 用例（手写 mock harness `tests/helpers/harness.ts`）；后端改业务→补 `backend/test/`（内存 mock 链 + ioredis-mock）；前端组件/纯函数用 vitest（Vue 组件用 `renderToString` 的 SSR 渲染测试）；提交前三套 `npm test` 全绿，并把本文件里的测试计数改到实测值。

## P2 扩展点（未实现，勿当 bug）

VRF/drand 随机预言机（RandomContract/ChainAdapter 抽象已留口）、私有数据集合、战斗回放验证页、HSM/KMS、监控告警。设计见 `docs/security.md`、`docs/randomness.md`。
