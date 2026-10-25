# PokeChain 后端 API 规范（NestJS）

Base URL：`/api/v1`　认证：`Authorization: Bearer <JWT>`（access 15min + refresh 7d，Redis 存 refresh 白名单）。
防重放：变更类请求头带 `X-Nonce: <uuid>` + `X-Timestamp`，Redis `nonce:<uuid>` SET NX EX 300，重复拒绝 409。
限流：Redis 滑动窗口，默认 100 req/min/用户，登录接口 10 req/min/IP。
统一错误：`{ "statusCode":401, "code":"NOT_OWNER", "message":"..." }`。链码/适配器抛出的 `CODE: message` 本身没有 HTTP status，全局过滤器按 `backend/src/common/utils/errors.ts::CHAIN_HTTP_STATUS` 映射为稳定语义（权限 403、锁定/状态冲突 409、入参/余额 400、实体不存在 404；业务层已抛 `AppException` 的路径以自带 status 为准）；未收录的 code 保持 500，避免把真 bug 伪装成 4xx（H8，2026-10-25）。

## 1. Auth / Users

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/register` | `{username,password,nickname}` → ① PostgreSQL 建用户（argon2 哈希）② Fabric CA 注册+enroll 得 X.509（私钥证书 AES-256-GCM 加密存 DB）③ 提交链码 `RegisterPlayer`（用 admin 身份代发，playerId=用户名）。返回 `{user, accessToken, refreshToken}` |
| POST | `/auth/login` | `{username,password}` → 校验 + 发 token |
| POST | `/auth/refresh` | `{refreshToken}` → 轮换 |
| POST | `/auth/logout` | 吊销 refresh |
| GET | `/users/me` | 当前用户资料 + 链上积分（Player.points）合并返回；`hasStarter` 标记是否已领取新手御三家 |
| POST | `/users/me/starter` | **新手礼包（注册后仅一次）**：`{speciesId: 1\|4\|7}`（妙蛙种子/小火龙/杰尼龟）→ `Commit(purpose='capture', meta='{"starter":true}')` → `RevealAndVerify` → 派生流定 IV/性格/闪光 → `MintFromCapture`（level 5，idemKey=`starter-<username>`）→ 发礼包（精灵球×5 + 伤药×2，`MintItem` 自动合并）。重复调用 409 `STARTER_ALREADY_CLAIMED`，并发双击 409 `STARTER_IN_PROGRESS`，非法 speciesId 400 `INVALID_SPECIES`。详见 §10 |
| PATCH | `/users/me` | `{nickname?, avatarUri?}` |
| GET | `/users/:id/profile` | 公开资料：昵称/头像/等级/战绩/积分 |
| GET/POST/DELETE | `/friends` `/friends/:id` | 好友（P1） |
| GET/POST/DELETE | `/blacklist` `/blacklist/:id` | 黑名单（P1） |

角色：`player|admin|arbitrator`，注册时默认 player；CA 注册属性写入 `role`，链码 CID 校验。

## 2. 宝可梦 / 捕捉

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/pokemon?owner=me` | 我的宝可梦（链上 QueryByOwner，Redis 缓存 5s；每只附带 `evs`、`stats` 六项能力值、**羁绊战斗加成百分比 `bondBonus`**（见下「能力值计算」）、**当前 HP `currentHp`/`fainted`**（链下伤势，见下）、**改名次数 `renameCount`**（链下 PG，见下「改名」）与进化链 `evolution`/`evolutions`） |
| GET | `/pokemon/:id` | 详情（同上附带 `evs`、`stats`、`bondBonus`、`currentHp`/`fainted`、`renameCount` 与进化链）。**仅本人可读**：IV/EV/性格/羁绊属私密养成数据，非本人与不存在统一 404 `NOT_FOUND`（2026-10-25 修复 H1 BOLA，调用方无法据此枚举他人资产） |
| GET | `/pokedex` | 图鉴（species 静态表 + 我拥有数 + **出现区域 `habitatOf`**：该种族会出现的区域 id 列表（栖息地反查，含传说区；从不出现的为 `[]`）+ `legendary` 标记；区域详情/中文名见 `GET /capture/zones`） |
| GET | `/capture/zones` | **区域表**（前端渲染 + 调试）：`{default, aliases, zones:[{id, name（中文名）, minLevel, maxLevel, maxStage, habitats, legendary, keyTypeId, keyNameZh, lureAllowed, poolSize}]}`——普通区给等级带/阶段门槛/栖息地属性/池规模，传说区给所需钥匙 typeId 与中文名（`lureAllowed=false`）。完整表见下「区域与栖息地野生池」 |
| POST | `/capture/encounter` | `{clientSeed?, lureTier?, zoneId?}` 随机遇敌：服务端生成 serverSeed+eventId，**先提交链码 `RandomContract.Commit`**，再从已验证派生流决定 species/等级（种类 `n=0`、等级 `n=1`）。**区域**：`zoneId` ∈ 普通区 7 个（`route-grass`/`forest`/`route-mid`/`cave`/`coast`/`route-north`/`volcano`）+ 传说区 6 个（`sky-pillar`/`seafloor`/`magma`/`ruins`/`southern-island`/`birth-island`），缺省 `route-grass`、非法抛 `INVALID_ZONE`、旧 id 别名 `south`/`mid`/`north` 归一为 `route-grass`/`route-mid`/`route-north`（响应与 `Commit.meta.zone` 一律记规范 id）；每区固定**等级带** + **阶段门槛** + **栖息地属性**（池见下「区域与栖息地野生池」），`等级 = zone.minLevel + floor(rand(1) × 带宽)`，**与玩家队伍等级彻底脱钩**。**传说区额外门控**：需要对应钥匙（`sky-key`/`ocean-key`/`magma-key`/`ruins-key`/`island-key`/`birth-key`）否则 403 `KEY_REQUIRED`（消息带 typeId 与中文名）；门控通过后、`Commit` 前**消耗恰好 1 把**（`ConsumeItem` reason=`legendary-key`，idemKey=`<eventId>-legendary-key`）——**钥匙是一次性门票**，快速捕捉与野怪战斗都从这次遇敌开始，不会二次消耗；`Commit` 失败时尽力退还 1 把（idemKey=`<eventId>-legendary-key-refund`）。本人已拥有该区任一传说（含锁定中）否则 409 `LEGENDARY_OWNED`；**禁止付费诱饵**（400 `LURE_NOT_ALLOWED`，不扣费），闪光仍按基准 1/4096 判定。**付费诱饵 `lureTier`**（仅普通区）：0 免费 / 1 = 50 积分（带内 +2 级）/ 2 = 200 积分（带内 +5 级、闪光概率 ×4 → 1/1024），加成**封顶 `zone.maxLevel`**；付费经链码 `AddPoints(-cost, reason='lure:tierN')` 原子扣减（余额不足抛 `INSUFFICIENT_POINTS`），并把 `{zone,lureTier?,cost?}` 写入 `RandomCommit.meta` 上链留痕（`GET /fairness/:eventId` 的 `event.meta` 可见，审计可据此复算 `n=0/n=1`）。返回 `{eventId, zone:{id,name,minLevel,maxLevel,maxStage,habitats,legendary,keyTypeId,keyNameZh}, wild:{speciesId,name,nameZh,level,previewSpriteUri,catchRate}, lure:{tier,cost,levelBonus,shinyMultiplier}, captureChances:[{itemId,typeId,name,nameZh,quantity,ballBonus,chance}], commitHash, clientSeed}`（`captureChances` 是本人 IDLE 球堆叠在**满血投球**下的成功率，快速捕捉降级界面直接用，前端不再复算公式）；`eventId` 是后续**野怪战斗**（主流程）或**快速捕捉**（兼容路径）的唯一凭据 |
| POST | `/wild/start` | `{eventId, partyPokemonId?}` 开启服务端权威的**野怪战斗（PvE 捕捉主流程）**：队伍取链上 owner 名下 `status=IDLE` **且非濒死（0 HP）**的宝可梦（等级降序，并列取最早获得），首发默认等级最高者，可用 `partyPokemonId` 指定（非法/非 IDLE 抛 `INVALID_PARTY_POKEMON`，**指定濒死成员抛 `FAINTED`，全队濒死同样 `FAINTED`**）。**以链下当前 HP 出战**（伤势持久化，见下）。野怪个体由派生流野怪区域固定。返回会话 id 与初始状态（含队伍列表、各球当前捕捉成功率）。同一 `eventId` 幂等（重复 start 返回同一会话） |
| POST | `/wild/:id/action` | `{action:{type:'move',moveId}\|{type:'ball',ballItemId}\|{type:'switch',targetPokemonId}\|{type:'run'}}` → 推进一个回合并返回新状态。规则见下文「野怪战斗」。已结束/超时的会话只返回终态（幂等，不再消耗球） |
| GET | `/wild/:id` | 当前会话状态（重进战斗界面用；仅会话所有者可读） |
| POST | `/capture/attempt` | **快速捕捉（兼容路径，e2e-smoke.sh 依赖）**：`{eventId, ballItemId}` → ① 校验球归属并 `ConsumeItem` ② 按捕捉公式判定 ③ **投中后才 `RevealAndVerify`** 并 `MintFromCapture`，失败返回 `{success:false, shakes:n}` 且事件保持 `COMMITTED`。成功额外返回 `catchReward`（+20 积分，见 §10）。全程幂等（idemKey=eventId+'-attempt-'+n）。**等价于满血投球**：`p = captureProbability(1,1,catchRate,ballBonus)`；同一 eventId 的野怪战斗已结束时拒绝（`WILD_BATTLE_FINISHED`）。玩家放弃的遭遇由 `capture:pending` 定时 sweep 在会话过期后揭示（H9） |
| POST | `/pokemon/:id/train` | **特训（只加努力值）**：链码 `AddPoints(-cost)` + `ApplyGrowth(evs += cost×4)`；**不改 exp/level**（等级只靠战斗经验与神奇糖果、个体值只靠王冠类道具，见下「集中升级路径」）。已满 510 EV 抛 `EV_MAXED`（不扣积分）；交易/对战锁定中 `ASSET_LOCKED`(409)（**先拒绝，不扣积分**，H7） |
| POST | `/pokemon/:id/evolve` | 进化：**不带 `stoneItemId` = 等级进化**（EVOLUTIONS 里纯等级分支且等级达标，不消耗道具）；**带 = 进化石进化**（消耗 1 个对应石头）。两种路径都 `ApplyGrowth(speciesId 变更)` 并按新种族学习表补学技能。返回更新后的详情（含新进化链）。改过名的宝可梦进化后保留昵称；交易/对战锁定中 `ASSET_LOCKED`(409)（**石头不消耗**，H7） |
| POST | `/pokemon/:id/rename` | `{name}` **改名（昵称）**：第一次免费，之后每次 **50 积分**（`AddPoints(-50, reason='rename:<pokemonId>:<ordinal>')`）+ 链上 `ApplyGrowth({name})`。昵称 1-12 个字符（trim + 折叠空白后按码点计，中英文均可），拒绝控制字符与 `<>&"'`；非本人（含已放生）`NOT_OWNER`(403)、交易/对战锁定中 `ASSET_LOCKED`(409)、格式非法 `INVALID_NAME`(400)、余额不足 `INSUFFICIENT_POINTS`(400)。返回 `{name, renameCount, charged}`，见下「改名」 |
| POST | `/pokemon/:id/release` | `Release`（前端二次确认）；成功后 +等级×1 积分（reason=`reward:release:<pokemonId>`，见 §10），并清掉该宝可梦的伤势键；交易/对战锁定中 `ASSET_LOCKED`(409)，不发放奖励 |
| POST | `/pokemon/center/heal` | **宝可梦中心**：全队回满，每次 **10 积分**（`AddPoints(-10, reason='heal:center')`）。只治疗本人 `IDLE` 的宝可梦；全员满血时**不扣费**（`charged=false`）。返回 `{cost, charged, points, healed:[{pokemonId,speciesId,name,before,after,maxHp}]}`（见下「伤势持久化」） |

**技能获取（2026-10-25 收紧）**：只有两条路径——**升级学习表**（`applyExp` 跨过学习等级时自动学会，见下「升级与进化」）与**技能机 TM**（`POST /items/:id/use` 的 `tm` 分支，消耗 1 个 TM）。原先的 `POST /pokemon/:id/moves/learn`（免费学任意技能）已下线，链上 `ApplyGrowth` 也只接受 system 证书，玩家无法绕过 TM/学习表改技能。

**能力值计算（实现口径，第三世代官方公式，2026-09 经 Bulbapedia "Stat"/"Nature" 核实）**

链上只存 **种族值（game-data/species.data 静态表）+ 个体值 IV + 努力值 EV + 等级 + 性格**；最终六项能力值由
`backend/src/game-data/stats.ts` 的 `computeStats(species.base, ivs, evs, level, nature)` 在链下计算，
**API 返回宝可梦详情/列表时附带 `stats:{hp,atk,def,spatk,spdef,speed}`（链上不存最终值，避免与成长/进化不同步）**。

```
HP        = floor((2×种族值 + IV + floor(EV/4)) × 等级 / 100) + 等级 + 10
其他五项  = floor( ( floor((2×种族值 + IV + floor(EV/4)) × 等级 / 100) + 5 ) × 性格修正 )
```

- **性格修正**：有利项 `1.1`、不利项 `0.9`、无修正 `1.0`（仅作用于非 HP 五项，HP 不吃性格）。
  25 种性格表（↑有利 / ↓不利，与官方一致）：

  | 性格 | 修正 | 性格 | 修正 | 性格 | 修正 | 性格 | 修正 | 性格 | 修正 |
  |---|---|---|---|---|---|---|---|---|---|
  | hardy 勤奋 | 无 | lonely 怕寂寞 | ↑攻击↓防御 | brave 勇敢 | ↑攻击↓速度 | adamant 固执 | ↑攻击↓特攻 | naughty 顽皮 | ↑攻击↓特防 |
  | bold 大胆 | ↑防御↓攻击 | docile 坦率 | 无 | relaxed 悠闲 | ↑防御↓速度 | impish 淘气 | ↑防御↓特攻 | lax 乐天 | ↑防御↓特防 |
  | timid 胆小 | ↑速度↓攻击 | hasty 急躁 | ↑速度↓防御 | serious 认真 | 无 | jolly 爽朗 | ↑速度↓特攻 | naive 天真 | ↑速度↓特防 |
  | modest 内敛 | ↑特攻↓攻击 | mild 慢吞吞 | ↑特攻↓防御 | quiet 冷静 | ↑特攻↓速度 | bashful 害羞 | 无 | rash 马虎 | ↑特攻↓特防 |
  | calm 温和 | ↑特防↓攻击 | gentle 温顺 | ↑特防↓防御 | sassy 自大 | ↑特防↓速度 | careful 慎重 | ↑特防↓特攻 | quirky 浮躁 | 无 |

- **EV 规则**：单项 `0–255`、六项总和 `≤510`；每 4 点 EV 加 1 点能力值（等级 100 时单项最多约 +63）。
  铸造（捕捉）时 EV 全 0；`POST /pokemon/:id/train`（**特训，只加 EV**）每 1 点花费给 **4 EV**，按「主攻项（物攻/特攻取种族值高者）→ 速度 → 防御 → 另一攻 → 特防 → HP」
  顺序逐项填到 255 再溢出，总和封顶 510（链码 `ApplyGrowth` 二次校验，非法抛 `INVALID_PARAM`；服务端满额抛 `EV_MAXED`）。
  **积分不再换等级**：训练不改 `exp`/`level`（回归断言见 `backend/test/pokemon-stats.spec.ts`）。
- **旧数据兼容**：`evs` 字段上线前铸造的链上记录缺失该字段，读写时一律按全 0 处理，无需迁移。
- **羁绊加成（2026-09 新增，仅战斗内生效）**：最终能力值的**非 HP 五项**再乘 `1 + bond/255 × 5%`（向下取整），
  即满羁绊（255）+5%、羁绊 128 约 +2.5%、刚铸造的 50 约 +1%；**HP 不吃羁绊**（避免血/双攻/双防全面膨胀）。
  `computeStats(base, ivs, evs, level, nature, bond?)` 的第 6 参是羁绊值，缺省 0（无加成）；
  详情/列表接口另外附带 `bondBonus`（加成百分比，两位小数，如 `2.51`），`stats` 本身仍是**不含羁绊**的基础最终值。
  前端队伍页把它显示为「羁绊加成 +x.x%」（`team.bondBonus`），战斗引擎在出战时才把加成算进六项数值（见 §11.2）。
- 战斗引擎（`backend/src/battles/engine/battle-engine.ts`）的 HP 上限、速度先手判定、伤害公式中的 A/D **全部使用上述最终能力值**（含性格修正、EV 与羁绊加成）；
  伤害公式本身不变：`floor( floor(((2×等级/5+2)×威力×A/D)/50) + 2 × 克制 × 暴击 × 随机(0.85–1) )`。

**伤势持久化（HP 跨战斗保留，链下 Redis，2026-09 新增；仅 PvE）**

`POST /pokemon/center/heal`：**全队回满，每次 10 积分**（`AddPoints(-10, reason='heal:center')`；全员满血不扣费，`charged=false`）。

- **链上不存 HP**（延续原口径）：HP 是每场战斗都在变的高频非关键状态，上链会让每个回合都产生交易。
  当前 HP 存链下 Redis `poke:hp:<pokemonId>`（`backend/src/pokemon/pokemon-hp.service.ts`），
  **缺键 = 满血**（上限由 `computeStats` 的 `stats.hp` 算出），因此首次读取无需数据迁移；
  越界/脏数据一律夹到 `[0, maxHp]`。Redis 丢失只损失"伤势"（全员满血），不损失任何资产。
- **适用范围（2026-09 调整）**：伤势**只影响野怪战斗（PvE）**——野怪战斗每次会话落盘时写回参战队伍 HP，
  开局由 `wild.service::toCombatant` 注入当前 HP。**PvP 一律满血满状态出战**（普通押注房、排位、机器人场）：
  `battles.service::loadTeam` 不带伤势，`BattleManagerService.startBattle` 统一剥掉任何 `EngineMonInput.currentHp`
  （竞技只比养成与策略）；**对局结束不回写** `poke:hp`——PvP 的胜负不改变任何链下伤势。
- **出战限制**：濒死（0 HP）不能出战——野怪队伍里直接剔除（全队濒死抛 409 `FAINTED`，指定濒死首发同样 `FAINTED`）；
  PvP/排位队伍提交（`assertTeamOwnership`）与押注双确认前的二次校验都抛 409 `FAINTED`（链上资产此时尚未锁定，
  校验的仍是链下当前 HP：伤药/宝可梦中心治好之前不能报名 PvP）。
- **恢复途径**：①伤药 `potion` +20 / 好伤药 `super-potion` +50（`POST /items/:id/use {targetPokemonId}`，不超上限、
  满血抛 409 `HP_FULL` 且不消耗道具）；②宝可梦中心（每次 10P，全员回满，全员满血不扣费）。
- **展示口径**：`GET /pokemon` / `GET /pokemon/:id` 每只附带 `currentHp`（缺键=满血）与 `fainted`；
  前端队伍页/交换面板用 `HpBar` 展示当前/最大值，濒死标红并禁用出战。

**改名（昵称，链下 PG 计数 + 链上 `name`，2026-09 新增）**

- 链上 `name` 就是显示名（铸造时写入种族 slug，如 `pikachu`）；改名只更新它（`ApplyGrowth({name})`），
  **"第一次免费、之后每次 50P" 的次数**存链下 PG 表 `pokemon_rename(pokemon_id PK, count)`
  （`backend/src/pokemon/entities/pokemon-rename.entity.ts`，`count` = 已完成改名次数，0 = 从未改名）。
- **昵称规则**（`backend/src/pokemon/pokemon-name.ts`）：trim + 折叠内部空白后 **1-12 个字符**（按 Unicode 码点计，
  中英文均可）；**拒绝控制字符**（含换行/制表/零宽）与 **HTML 特殊字符 `<>&"'`**——与 battles 的 `sanitizeRoomText`
  同为"先清洗后落链"，区别是昵称**拒绝而非转义**（转义后的 `&amp;` 会与玩家输入不一致）。
- **计费与幂等**：第 `ordinal` 次改名（`ordinal = 已改名次数 + 1`，`ordinal = 1` 免费）的
  `AddPoints(-50, reason='rename:<pokemonId>:<ordinal>')` 与 `ApplyGrowth({name})` 分别使用确定性幂等键
  `<id>-rename-<ordinal>-charge` / `<id>-rename-<ordinal>`（**链上幂等记录是全局命名空间，两笔必须用不同的键**）；
  中途失败后重试不会重复扣分。链上 `name` 已等于目标昵称时视为空操作（不扣费、不计数、不发交易）。
- **校验顺序与错误码**：昵称格式 `INVALID_NAME`(400) → 归属 `NOT_OWNER`(403) → `status=IDLE` `ASSET_LOCKED`(409)
  → 余额不足 `INSUFFICIENT_POINTS`(400，`AddPoints` 前预检，此时链上 `name` 与计数都不变)。
- **响应**：`POST /pokemon/:id/rename` 返回 `{name, renameCount, charged}`（`renameCount` = 改名后的累计次数、
  `charged` = 本次是否为付费改名（`ordinal > 1`；命中幂等键的重放不会重复扣费）；`GET /pokemon` / `GET /pokemon/:id` 每只附带 `renameCount` 供前端显示"首次免费 / 本次 50P"；
  改名成功后列表缓存 `cache:pokemon:<owner>` 立即失效。
- **展示口径**：队伍/战斗/捕捉界面**昵称优先**——前端 `useI18n.monName(speciesId, name)` 在链上 `name` 与种族名不同时
  直接显示昵称（`frontend/src/composables/useI18n.ts`）；图鉴页只按 speciesId 显示种族名，队伍详情同时给出种族名。
  改过名的宝可梦**进化后保留昵称**（未改名的仍按旧口径更新为新种族名）。

**升级学习表（`backend/src/game-data/learnsets.data.ts`，自动生成）**

`LEARNSETS: Record<speciesId, {level, moveId}[]>` 覆盖全部 386 个种族、每族 **4-8 条**记录；升级时**跨过阈值即学**（`oldLevel < level ≤ newLevel`）：

- **技能池优先级**（去重保序）：本系 STAB（按威力升序，最多 6 条）→ **最终形态专属**的副属性池（主属性映射一个代表性副属性：
  火→飞行 让喷火龙学 wing-attack、草→毒 让妙蛙花学 sludge-bomb）→ 该种族 `defaultMoves` 里剩下的招牌技能（卡比兽 crunch、拉普拉斯 ice-beam）
  → 一般属性兜底；条数 `clamp(前三层去重条数, 4, 8)`。
- **等级 = 威力梯度 + 进化阶段偏移**：`levelOfPower = 1 + floor((威力 − 40) × 39 / 70)`（威力 ≤40 → Lv1、90 → Lv28、110 → Lv40、120 → Lv45），
  再加 `12 × 进化阶段`（0/1/2，沿 EVOLUTIONS 回溯）；同一张表内等级严格递增（同级按「本系优先、威力、声明顺序」顺延）。
  例：小火龙 `ember Lv1 → fire-fang Lv14 → blaze-kick Lv26 → flamethrower Lv28 → fire-blast Lv40`；
  火恐龙整体 +12；喷火龙整体 +24 且多出 `wing-attack Lv36` / `fly Lv53`——**进化型与基础形态的学习表必然不同**。
- **升级学技能**：`moves < 4` 直接追加；已满 4 个**替换最早学的非最新技能**（`moves` 数组即学习顺序、新技能追加在尾部，
  故队首 = 最早学的；本批刚学会的不参与替换）。实现见 `backend/src/pokemon/learnset.ts`。
- 重新生成：`cd backend && node tools/gen-learnsets.mjs`（解析仓库内静态数据，确定性、不联网、重跑无 diff）。

**集中升级路径 `PokemonService.applyExp(pokemon, gain)`（所有经验来源都走它，`backend/src/pokemon/pokemon.service.ts`）**

exp 曲线维持 `level = floor(cbrt(exp))`（只升不降、封顶 100）；升级时按学习表学技能，返回 `{levelsGained, movesLearned, canEvolve}`（`canEvolve` = 已满足**等级进化**条件，前端据此显示「可以进化！」）。经验来源：

| 来源 | 经验 | 实现 |
|---|---|---|
| 野怪击倒 | `max(5, floor(种族值总量 × 野怪等级 / 50))` | `wild/wild.service.ts::grantExp`（幂等键 `<sessionId>-exp`） |
| **收服成功** | **出战宝可梦 +20** | `wild/wild.service.ts::grantCaptureExp`（收服结算时发放，随机事件已消费，不重复） |
| PvP 胜利 | 参战队伍每只 +30 | 接线点 `PokemonService.grantBattleWinExp(playerId, pokemonIds, battleId)`（幂等键 `<battleId>-exp-<pokemonId>`），由 battles 结算调用 |
| 神奇糖果 | +1 级（exp 补到 `(level+1)³`） | `POST /items/:id/use`，见 §3 |

**进化（详情返回进化链，`POST /pokemon/:id/evolve` 支持两种路径）**

- **等级进化**：不带 `stoneItemId` → 取 EVOLUTIONS 里 `from = 当前种族`、无 `stoneTypeId` 且 `等级 ≥ minLevel` 的分支（不消耗道具）；
  没有纯等级分支的种族（如皮卡丘）抛 `NO_EVOLUTION`，有分支但等级不够抛 `LEVEL_TOO_LOW`。
- **进化石进化**：带 `stoneItemId`（雷之石/水之石/火之石，见 §3）→ 校验石头归属/种类/对应分支 + 等级，消耗 1 个石头。
- 两种路径都走链码 `ApplyGrowth(speciesId)`，并按**新种族学习表补学**已达等级的技能（Lv36 小火龙→火恐龙→喷火龙时补学 `wing-attack`）。
- 详情/列表附带 `evolution: {fromSpeciesId, targetSpeciesId, targetName, targetNameZh, minLevel, stoneTypeId?, levelOk, canEvolveNow}`
  与 `evolutions[]`（全量分支，伊布 5 条线都在内；「现在能进化」的排最前）。石头线 `canEvolveNow=false`（还要看是否持有并使用石头），
  `levelOk` 单独给出便于前端显示「还差 N 级」；`GET /pokedex` 的每个种族也带 `evolutions`（按等级 0 计算，只展示条件）。

**捕捉公式（官方风格，服务端权威，`backend/src/pokemon/capture-derive.ts::captureProbability`）**

```
a = ((3×maxHP − 2×curHP) × catchRate × ballBonus) / (3×maxHP)        // 野怪当前血量参与计算
p = min(1, a / 255)                                                   // 大师球（ballBonus ≥ 255）恒为 1
```

- `catchRate` 为**官方种族捕获率（3–255，越大越好抓）**，见 `backend/src/game-data/species.data.ts`（皮卡丘 190、卡比兽 25、御三家/快龙/伊布系 45、雷丘 75 等）；球倍率：精灵球 ×1、超级球 ×1.5、高级球 ×2、大师球 ×255（`game-data/items.data.ts`）。
- **野怪 HP 越低 p 越高**：满血时 `p = catchRate×ballBonus/765`，1 HP 时 `p ≈ min(1, catchRate×ballBonus/255)`。
- 判定：`p` 先由服务端算出并随状态返回（前端按钮上显示百分比），命中判定用该 attempt 派生块的 `+0` 槽（`rand < p`）；失败时的摇晃次数取 `+9` 槽（1..3）。逐次投球的判定与参数（attempt 序号、掷点、阈值）都在状态 log 里留痕，可用 `GET /fairness/:eventId` 复核。
- **快速捕捉（`POST /capture/attempt`）等价于满血投球**：`p = captureProbability(1, 1, catchRate, ballBonus)`，其余派生布局与野怪战斗一致。
- IV 六维 = `floor(rand(1..6)*32)`；nature = 表[rand(7)*25]；shiny = `rand(8) < shinyChance`（基准 1/4096，诱饵 tier 2 → 1/1024）；技能 = species 默认技能表（快速捕捉路径）。野怪战斗路径的个体样本来自野怪区域（见下），**战斗中看到的野怪与最终捕捉到的是同一只**（同样的 IV/性格/闪光，不给"重投刷个体"留口子）。

**野怪战斗（PvE 捕捉主流程，`backend/src/wild/`）**

- **会话模型**：`POST /capture/encounter` → `POST /wild/start {eventId, partyPokemonId?}` 建会话（Redis `wild:<sessionId>`，TTL **15 分钟**；`wild:event:<eventId>` 为幂等索引）。超时后任何动作返回 `TIMEOUT` 终态，Redis 自动回收；同一 eventId 只能开一场（重复 start 返回同一会话）。
- **队伍与首发**：队伍 = 链上 owner 名下 `status=IDLE` **且非濒死**的宝可梦（**等级降序**，并列取 `createdAt` 更早、再并列取 id 字典序）；首发默认等级最高者，`partyPokemonId` 可指定（濒死成员会被拒绝）。锁定中（交易/对战）与已释放的宝可梦不参战。**野怪战斗不锁定资产**（无押注），也不与 PvP 共享任何状态；**双方以链下 Redis 的当前 HP 出战**（伤势持久化，见上），每次会话落盘时把参战队伍 HP 写回 Redis。队伍整场会话固定并随状态返回（`party[]`）。
- **回合规则**：玩家 `move`（出战宝可梦的真实技能表）→（野怪存活则）野怪 AI 出招，**最终能力值 speed 决定先手**（麻痹速度减半，平速用该回合派生流的 tie-break 槽）；命中/暴击/伤害/能力阶级/异常状态与 PvP 引擎**共用同一批纯函数**（`backend/src/battles/engine/battle-math.ts`）；野怪 AI 每回合从自己技能表按派生流随机选一个技能。回合末灼伤/中毒按 `maxHP/16` 扣血（不消耗掷点）。
- **换宠**：`{type:'switch', targetPokemonId}` → **主动换宠消耗本回合**（野怪随后出招一次，换入者吃当回合伤害）；**濒死强制换宠**：出战宝可梦倒下且队伍还有健康成员 → 会话保持 `ACTIVE`、`mustSwitch=true`，此时只接受 `switch`（其它动作抛 `MUST_SWITCH`），换上后不额外挨打，可继续战斗；全队倒下才 `PLAYER_FAINTED`。换下的宝可梦保留自己的 HP/异常状态/能力阶级。
- **投球**：`ball` 动作消耗该球（`ConsumeItem`，idemKey=`eventId-attempt-n`，与快速捕捉共用投球计数）→ 按上式判定（**失败不揭示**）。成功 → 先 `RevealAndVerify` 再 `MintFromCapture`（idemKey=`eventId-mint`，`eventId` 状态机 COMMITTED→REVEALED→CONSUMED）并结束战斗，同时发放收服奖励 +20 积分（reason=`reward:catch:<pokemonId>`，见 §10）与**出战宝可梦 +20 exp + 羁绊 +1**（经验走集中升级路径：`expGained=20`、可能升级并学技能；羁绊经 `BondService`，reason=`bond:wild-catch:<sessionId>`，幂等键 `<sessionId>-bond-catch`，受**每日每宠 +6** 上限约束）；失败 → 野怪反击（投球消耗了玩家这一回合），可继续投球，每次投球消费一个 attempt 派生块。**结算后揭示（H9）**：战斗进入终态（CAUGHT / WILD_FAINTED / PLAYER_FAINTED / RAN / TIMEOUT）才 reveal，避免首球后拿到 serverSeed 预判后续判定；玩家中途放弃的遭遇由 `CaptureService` 的 5 分钟 sweep 在会话过期后揭示。
- **结束分支**：野怪 HP 归零 → `WILD_FAINTED`（不可再捕捉，出战宝可梦经 `ApplyGrowth` 获得经验 `max(5, floor(种族值总量×野怪等级/50))`，等级按 `floor(cbrt(exp))` 只升不降，幂等键 `<sessionId>-exp`；**击倒不再给羁绊**（BOND_WILD_FAINT = 0）；**普通区**发放击倒奖励 野怪等级×1 积分，reason=`reward:wild-faint:<sessionId>`；**传说区固定 0 积分、不发 `reward:wild-faint`**（避免"买钥匙刷分"））；我方全队倒下 → `PLAYER_FAINTED`（参战队伍留在 0 HP，需治疗）；`run` → `RAN`（必定成功，不消耗球，随机事件保持 COMMITTED，已受伤的 HP 照常写回）；超时 → `TIMEOUT`。
- **状态返回**：`{sessionId, eventId, turn, status, finished, attempts, expiresAt, expGained, expGainedBy, levelsGained, movesLearned, canEvolve, bondGain, bondGainBy, catchReward, faintReward, activeIndex, mustSwitch, wild:{speciesId,name,nameZh,type,level,shiny,hp,maxHp,moves,status,stages,catchRate}, mine:{pokemonId,speciesId,name,nameZh,type,level,shiny,hp,maxHp,exp,bond,status,stages,moves:[{id,name,type,power,accuracy,category,effectText}]}, party:[{pokemonId,speciesId,name,nameZh,type,level,shiny,hp,maxHp,exp,status,fainted,active}], captureChances:[{itemId,typeId,name,nameZh,quantity,ballBonus,chance}], log:[{turn,events}], captured}`。`catchReward`/`faintReward` 是本次会话已发放的积分（未发放为 0；**传说区击倒 `faintReward` 恒 0**），结算面板据此显示 "+20P / +等级×1 P"（传说区不显示击倒积分）；`expGained`/`expGainedBy` 是本次发放的经验与获得者，`levelsGained`/`movesLearned`/`canEvolve` 是集中升级路径的结果（收服 +20 或击倒经验），结算面板据此显示"升到 Lv N / 学会了 X / 可以进化"；`bondGain`/`bondGainBy` 是本会话已发放的羁绊（收服 +1，击倒 0，上限外为 0；失败只记日志不影响主流程）、`mine.bond` 是出战宝可梦当前链上羁绊，结算面板显示"羁绊 +N ♥"。`captureChances` 每次返回都按野怪当前 HP 重算——前端球按钮上的百分比即此值；技能按钮的悬停说明用 `mine.moves[].effectText`。
- **技能特效（PvP 与野怪共用，`battle-math.ts` + `game-data/moves.data.ts`）**：每个技能带中文 `effectText` 与可选结构化 `effect`（最多一个，命中后按 `chance` 掷点触发）：
  1. `stat` 能力阶级（±6，乘率正阶 `(2+s)/2`、负阶 `2/(2−s)`；如 `crunch` 20% 使目标防御 −1、`psychic` 10% 使目标特防 −1；`self` 方向支持剑舞类自强化）；
  2. `status` 异常状态（`brn`/`psn` 回合末扣 `maxHP/16`；`par` 速度减半且 25% 概率不能行动；同类不叠加、异类不覆盖，写入战斗状态，换宠保留）；
  3. `drain` 按伤害比例回复自身；`recoil` 按伤害比例反伤自身；
  4. 纯伤害技能 `effect: null`（`hyper-beam`/`solar-beam` 等高威力招只标注"简化引擎不模拟充能回合"）。
  掷点顺序（PvP 顺序消费 / 野怪固定槽位，见下）：麻痹检查（仅麻痹者）→ 命中 → 暴击 → 伤害浮动 → 追加效果（仅 `stat`/`status`）。
- **无队伍降级路径**：账号名下没有任何 `IDLE` 宝可梦时 `/wild/start` 抛 `NO_TEAM_POKEMON`，前端自动降级为"直接投球"（`POST /capture/attempt`，满血判定）并在界面上说明原因——保证新账号仍能抓到第一只宝可梦；`POST /capture/encounter` 额外返回 `wild.catchRate`（审计/调试）与 `captureChances`（按满血投球算好的球列表成功率）——降级界面直接展示后者，不在前端复算捕捉公式。
- 错误码：`WILD_SESSION_NOT_FOUND`(404)、`WILD_BATTLE_FINISHED`(409，快速捕捉路径对已结束会话)、`MUST_SWITCH`(409，濒死必须先换宠)、`FAINTED`(409，队伍提交/野怪出战遇到 0 HP 宝可梦)、`KEY_REQUIRED`(403，传说区缺钥匙)、`LEGENDARY_OWNED`(409，已拥有该区传说)、`EVENT_CONSUMED`(409)、`NOT_OWNER`(403)、`INVALID_ACTION`/`UNKNOWN_MOVE`/`NO_TEAM_POKEMON`/`NOT_A_BALL`/`INSUFFICIENT_QUANTITY`/`INVALID_PARTY_POKEMON`/`INVALID_SWITCH`/`SWITCH_TO_ACTIVE`/`SWITCH_TO_FAINTED`/`INVALID_LURE_TIER`/`LURE_NOT_ALLOWED`/`INVALID_ZONE`/`INSUFFICIENT_POINTS`(400)。

**区域与栖息地野生池（`backend/src/game-data/encounter.data.ts`，2026-09 重做遇敌模型）**

野怪不再"任何等级都能遇到任何怪"，也不再跟随队伍等级浮动。遇敌时前端把 `zoneId` 随 `POST /capture/encounter` 传给后端（缺省 `route-grass`，非法抛 `INVALID_ZONE`，旧 id `south`/`mid`/`north` 作为**兼容别名**归一为 `route-grass`/`route-mid`/`route-north`）：

| 区域 | id | 等级带 | 阶段门槛 | 栖息地属性 | 池规模 |
|---|---|---|---|---|---|
| 101 号道路·草丛 | `route-grass` | **Lv2-6** | `stage ≤ 0` | normal / bug / grass / electric / flying | 74 |
| 橙华森林 | `forest` | **Lv4-10** | `stage ≤ 0` | bug / grass / flying / poison / **fairy** | 42 |
| 104 号道路·丘陵 | `route-mid` | **Lv8-16** | `stage ≤ 1` | normal / flying / fighting / ground | 78 |
| 石之洞窟 | `cave` | **Lv12-20** | `stage ≤ 1` | rock / ground / poison / dark / **ghost** / **ice** | 73 |
| 108 号水道·海滨 | `coast` | **Lv15-25** | `stage ≤ 1` | water | 59 |
| 冠军之路 | `route-north` | **Lv17-28** | `stage ≤ 2` | flying / dragon / steel / fighting / **psychic** | 47 |
| 烟囱山 | `volcano` | **Lv20-30** | `stage ≤ 2` | fire / ground / rock | 58 |

- **入池条件 = 阶段门槛 ∧ 栖息地属性**：普通区的池 = `WILD_TABLE`（全部非传说种族）里 `stage ≤ zone.maxStage` **且**种族属性命中 `zone.habitats` 的那些，按图鉴 id 升序、按稀有度加权。因此**去哪片区域决定了能遇到什么**：水系只在海滨、火系只在烟囱山、龙/钢/格斗/超能在冠军之路、毒/妖精在森林、幽灵与冰系在洞窟（**18 属性全部有栖息地**）。
- **属性口径（重要）**：图鉴数据只存**主属性**（`tools/gen-pokedex.mjs` 取 PokeAPI 第一属性，战斗也是单属性模型），栖息地过滤因此按主属性判定——双属性种族按其第一属性归类（波波 normal/flying 算一般、超音蝠 poison/flying 算毒）。过滤器本身按"属性集合"实现（`speciesTypes()`），日后引入副属性表只需改这一个函数。
- **空池兜底**：若某区栖息地过滤后为空（数据缺失/新属性），退回"只看阶段门槛"的池，保证遇敌永不空转。当前数据下不会触发（`backend/test/encounter-zone.spec.ts` 断言每区池非空且属性自洽、池规模与上表一致）。
- **覆盖缺口（2026-09 补全后）**：栖息地集合已覆盖**全部 18 属性**，因此**每个基础形态（`stage = 0`）都能在野外遇到**；仍有 **64 个进化型**（stage ≥ 1，如皮卡丘/妙蛙草/水箭龟/雷丘/九尾）因为所在区域的门槛更低而不出现在野生池里，只能靠**进化**获得——这是"门槛"设计的正常结果，不是数据缺口。`GET /pokedex` 的 `habitatOf: []` 即"不出现在野外"，据此可自查（386 个种族里 306 个可野外遇到：370 个野生种族 − 64 个进化型）。
- **进化阶段 `stage`**：沿 `species.data.ts` 的 `EVOLUTIONS` 回溯（与 `tools/gen-learnsets.mjs` 同口径）——0 = 基础形态、1 = 一段进化、2 = 二段进化（皮丘→皮卡丘→雷丘 ⇒ 皮卡丘 1、雷丘 2；伊布 0、水伊布 1）。
- **稀有度权重**（加权抽样的权重，`rarityWeight()`）：官方捕获率 `≥200` 常见 **60** / `80–199` 少见 **30** / `<80` 稀有 **10**；**种族值总量 ≥500**（`baseStatTotal ≥ RARE_BST`，准神/高种族值）在上述档位上再 **×0.3**（即 18/9/3）。例：波波（255）60 权重，妙蛙花（45、BST 525）3 权重——**出率差 20 倍**。
- **等级**：`level = zone.minLevel + floor(rand(1) × (zone.maxLevel − zone.minLevel + 1))`，**只由区域决定**；付费诱饵在带内 `+2`（tier 1）/ `+5`（tier 2）并**封顶 `zone.maxLevel`**；闪光阈值口径不变（基准 1/4096，tier 2 → 1/1024）。
- **上链留痕**：`Commit.meta` 恒含 `zone`（规范 id，免费档也写，`{"zone":"sky-pillar"}`），付费档追加 `{"lureTier":n,"cost":c}`——审计者据此在 `/fairness` 复算 `n=0` 的加权抽样与 `n=1` 的等级。
- **为什么与队伍等级脱钩**：旧口径 `clamp(队伍最高等级 − 2 + floor(rand×5), 2, 100)` 会让"抓高等级野怪 → 队伍等级上涨 → 野怪等级继续上涨"滚雪球，养成失去意义；现在区域固定出货，成长的意义回到**选择去哪片区域**与培育本身。

**传说区（一次性钥匙门控 + 每人每池一只，2026-09 新增；2026-10 H11 钥匙改为一次性）**

| 区域 | id | 传说 | 等级带 | 池规模 | 钥匙 |
|---|---|---|---|---|---|
| 天空之柱 | `sky-pillar` | 烈空坐 #384 | **Lv45-50** | 1 | `sky-key` 天空之钥 |
| 海底洞窟 | `seafloor` | 盖欧卡 #382 | **Lv45-50** | 1 | `ocean-key` 海洋之钥 |
| 熔岩洞窟 | `magma` | 固拉多 #383 | **Lv45-50** | 1 | `magma-key` 熔岩之钥 |
| 古代遗迹 | `ruins` | 雷吉洛克 #377 / 雷吉艾斯 #378 / 雷吉斯奇鲁 #379 | **Lv40（固定）** | 3 | `ruins-key` 遗迹之钥 |
| 南方孤岛 | `southern-island` | 拉帝亚斯 #380 / 拉帝欧斯 #381 | **Lv40（固定）** | 2 | `island-key` 岛之钥 |
| 诞生之岛 | `birth-island` | 代欧奇希斯 #386 | **Lv45（固定）** | 1 | `birth-key` 诞生岛船票 |

- **池固定、等权**：传说区的池由 `poolSpeciesIds` 显式指定（**不**经阶段门槛与稀有度加权，权重统一为 1，`ruins` 三神柱各 1/3），池内只有传说种族；这些种族 `inWild = true`（**只经传说区出现**，绝不进普通区池，`legendary` 标记区分），Kanto/城都传说与基拉祈 `inWild = false`（仍未开放遭遇）。
- **钥匙门控（一次性，H11）**：创建遇敌前校验本人名下是否存在 `status=IDLE`、`quantity ≥ 1` 的对应 key typeId 堆叠；缺钥匙抛 403 `KEY_REQUIRED`，消息带所需 typeId 与中文名（如 `天空之柱需要天空之钥（sky-key）才能进入，背包里没有可用的钥匙`）。锁定中（押注/交易托管）或数量为 0 的堆叠不算持有。门控通过后、`Commit` 之前消耗**恰好 1 把**（`ConsumeItem`，reason=`legendary-key`，idemKey=`<eventId>-legendary-key`）：**快速捕捉与野怪战斗都从 `POST /capture/encounter` 开始，只扣这一次**；`Commit` 失败时用 `MintItem` 尽力退还 1 把（idemKey=`<eventId>-legendary-key-refund`，退款失败只告警）。
- **每人每池一只**：本人**当前拥有**该区任一种族（`QueryByOwner` 按 speciesId 过滤，**含锁定中**的个体）即 409 `LEGENDARY_OWNED`（如 `你已经拥有 烈空坐，传说仅此一只（放生或交易走后可再来）`）。口径是"看当前归属，不看历史"：**放生**（`ownerId` 置空）或**交易/押注转手**后即可再捕；其他玩家持有不影响你（稀缺性由钥匙价格 + 每人一只共同保证）。
- **传说区禁用诱饵**：`lureTier > 0` 一律 400 `LURE_NOT_ALLOWED`，不扣费也不留 Commit；闪光判定仍按基准 1/4096（不享受 tier 2 的 ×4）。
- **校验先于扣钥匙/Commit**：钥匙/归属/诱饵三项校验都在 `Commit`、扣钥匙与扣费之前完成，被拒时不建事件、不消耗钥匙、不扣分、链上不留痕。
- **传说区击倒 0 积分**：野怪战斗会话记录遇敌 `zoneId`（`wild-session.ts`）；`WILD_FAINTED` 只在普通区发放 等级×1（reason=`reward:wild-faint:<sessionId>`），传说区 `faintReward=0`。收服奖励 +20 不受影响。

**`GET /capture/zones`（区域表，前端渲染 + 调试）**

无需参数，返回 `{default:'route-grass', aliases:{south,mid,north}, zones:[...]}`；每个区域条目：

`{id, name（中文名）, minLevel, maxLevel, maxStage, habitats:[属性], legendary:bool, keyTypeId|null, keyNameZh|null, lureAllowed:bool, poolSize}`

`poolSize` 即该区加权池的种族数（上表"池规模"），`lureAllowed = !legendary`；前端据此渲染区域选择/传说区钥匙提示，无需再查道具表。

**分块派生布局（实现口径，`backend/src/pokemon/capture-derive.ts`）**：一个 eventId 覆盖一次 encounter **加其后的野怪战斗与全部 attempt**；`n=0` 野生种类（**区域野生池的加权索引**：权重区间累计和落入 `rand(0)×总权重`；普通区池 = 阶段门槛 ∧ 栖息地属性，传说区池 = 固定传说种族等权，池与权重见上「区域与栖息地野生池」）、`n=1` 野生**等级** `zone.minLevel + floor(rand × 带宽)`（诱饵带内 +2/+5，封顶 `zone.maxLevel`；传说区禁用诱饵、等级带本身就窄/固定）；第 k 次投球（k=1,2,…）使用块 `base = 2+(k-1)*10`：`+0` 捕捉判定（`rand < p`，p 见上式）、`+1..+6` IV 六维 `floor(rand*32)`、`+7` 性格（25 种索引）、`+8` 闪光（`rand < shinyChance`，基准 1/4096、诱饵 tier 2 → 1/1024）、`+9` 失败摇晃 `1+floor(rand*3)`（1..3）；野怪战斗区域 `base = 20000`（`+0..+5` IV、`+6` 性格、`+7` 闪光，整场会话固定并用于铸造）与回合块 `base = 30000+(t-1)*16`（`+0` 野怪 AI 选招、`+1..+5` 我方 麻痹/命中/暴击/浮动/追加效果、`+6..+10` 野怪同五项、`+11` 平速裁决、`+12..+15` 预留）。该布局经 `GET /fairness/:eventId` 对外公示，完整论证见 `docs/randomness.md` §3。

## 3. 道具

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/items?owner=me` | 我的道具 |
| POST | `/items/:id/use` | `{targetPokemonId?, forgetMoveId?, stat?}` 药水/进化石/技能机/培养道具：链下校验效果 → `ConsumeItem` + `ApplyGrowth`。培养类道具见下表 |
| GET | `/shop` | 商店商品表：`{points, maxQty, items:[{typeId,name,nameZh,kind,uri,price,sellPrice,available}]}`。`points` 是当前链上积分（前端顶栏/商店页共用）；`available=false` 是**库存标记**——非卖品（`master-ball`，仅奖励发放，`price=null`）；`maxQty` 为单次买卖数量上限（99） |
| POST | `/shop/buy` | `{typeId, qty, idemKey?}` 积分购买：链码 `AddPoints(-total, reason='shop:buy')` → `MintItem`（同 typeId 自动合并堆叠）。`qty` 1..99；非卖品 `NOT_FOR_SALE`；余额不足 `INSUFFICIENT_POINTS`(400，由链上 `AddPoints` 拒绝，扣减不落链)。`idemKey`（`^[\w-]{8,128}$`，可选）由客户端在重试时复用：`AddPoints`/`MintItem` 两笔交易按它派生确定性链上幂等键，重放不会重复扣分/发货 |
| POST | `/shop/sell` | `{itemId, qty, idemKey?}` 按半价回收：`ConsumeItem(qty, reason='shop:sell')` + `AddPoints(+refund, reason='shop:sell')`。回收价 = 购买价 ÷ 2 向下取整（最低 1）；非卖品/未定价 `NOT_SELLABLE`；非本人 `NOT_OWNER`(403)；`status≠IDLE`（交易/对战锁定中）`ASSET_LOCKED`(409)；`qty` 超过堆叠数量 `INSUFFICIENT_QUANTITY`(409)——后三者由链上 `ConsumeItem` 校验（服务层转成对应 HTTP 状态），因此**同一 `idemKey` 的重试会直接返回首次结果**，不会被"堆叠已减量"误判。`idemKey` 语义同上（`ConsumeItem`/`AddPoints` 成对幂等） |
| POST | `/admin/items/mint` | admin：`MintItem`（演示发道具） |

**道具获取途径（实现口径）**

| 途径 | 内容 | 实现 |
|---|---|---|
| 新手礼包 | 精灵球×5 + 伤药×2（注册后一次） | `POST /users/me/starter`（§1、§10） |
| 商店购买 | 积分买入任意在售道具（见下表；**传说区钥匙 1500P/把，一次性，不可回收**） | `POST /shop/buy`（`backend/src/shop/`） |
| 野怪战斗掉落 | 收服成功或击倒野怪时 **20%** 掉落一件（60% 伤药 / 30% 精灵球 / 10% 超级球），数量 ×1 | `backend/src/wild/wild.service.ts::grantDrop`，派生布局见 `docs/randomness.md` §3（40000 区）；战斗状态返回 `drop` 字段 |
| 传说区钥匙 | `sky-key`/`ocean-key`/`magma-key`/`ruins-key`/`island-key`/`birth-key`（`kind='key'`）：**一次性消耗品**——创建对应传说区遇敌时消耗 1 把（§2）；**不可使用**（`NOT_USABLE`）、**不可回收**（`NOT_SELLABLE`） | `backend/src/game-data/items.data.ts` + `backend/src/shop/shop.data.ts` |
| admin 投放 | 任意（演示/补偿） | `POST /admin/items/mint` |

**道具使用效果（`backend/src/items/items.service.ts`，全部 `ConsumeItem` + `ApplyGrowth`）**

> **锁定校验（H7，2026-10-25）**：所有效果道具的目标宝可梦都必须**本人所有且 `status=IDLE`**；交易/对战锁定中统一 409 `ASSET_LOCKED`，且在 `ConsumeItem`/`AddPoints` **之前**拒绝——道具与积分不会被白白消耗。

| typeId | 入参 | 效果 | 错误码 |
|---|---|---|---|
| `potion` / `super-potion` | `{targetPokemonId}` | **链下回血 +20 / +50**（伤势持久化，见 §2）：不超当前上限、满血抛 `HP_FULL`（不消耗道具）；链上只记一次 `ConsumeItem`，返回 `{effect:{healAmount}, hp:{before,after,maxHp,healed}}` | `TARGET_REQUIRED`（缺目标）/ `HP_FULL` |
| `thunder-stone` / `water-stone` / `fire-stone` | `{targetPokemonId}` | 按 EVOLUTIONS 的石头分支进化（等级达标才行） | `TARGET_REQUIRED` / `NOT_OWNER` / `NOT_A_STONE` / `NO_EVOLUTION` / `LEVEL_TOO_LOW` |
| `tm-*` | `{targetPokemonId, forgetMoveId?}` | 教技能（满 4 招必须给 `forgetMoveId`） | `TARGET_REQUIRED` / `MOVE_KNOWN` / `FORGET_REQUIRED` |
| `bottle-cap` | `{targetPokemonId, stat}` | **指定一项个体值升满 31**（链码只允许升、降抛 `IV_DECREASE`） | `STAT_REQUIRED`（缺 `stat`）/ `IV_MAXED`（该项已是 31） |
| `gold-bottle-cap` | `{targetPokemonId}` | **六项个体值一起升满 31** | `IV_MAXED`（六项都已是 31） |
| `rare-candy` | `{targetPokemonId}` | **等级 +1**（exp 补到 `(level+1)³`，走 §2「集中升级路径」：学技能 + 返回 `canEvolve`） | `LEVEL_MAXED`（100 级） |

培养类道具的定位（§2「集中升级路径」）：**积分只换努力值（训练）、等级只靠战斗经验与神奇糖果、个体值只靠王冠类道具**——
三者各自独立，避免"花积分堆等级"的失衡。已满额的道具在消耗前就被拒绝（不浪费道具）。

**商店价目表**（`backend/src/shop/shop.data.ts`；回收价 = 半价向下取整，最低 1）

| typeId | 名称 | 购买价 | 回收价 | typeId | 名称 | 购买价 | 回收价 |
|---|---|---|---|---|---|---|---|
| `poke-ball` | 精灵球 | 50 | 25 | `tm-thunderbolt` | 十万伏特技能机 | 800 | 400 |
| `great-ball` | 超级球 | 150 | 75 | `tm-flamethrower` | 喷射火焰技能机 | 800 | 400 |
| `ultra-ball` | 高级球 | 400 | 200 | `tm-surf` | 冲浪技能机 | 800 | 400 |
| `potion` | 伤药 | 50 | 25 | `bottle-cap` | 银色王冠 | 1200 | 600 |
| `super-potion` | 好伤药 | 120 | 60 | `gold-bottle-cap` | 金色王冠 | 6000 | 3000 |
| `thunder-stone` | 雷之石 | 800 | 400 | `rare-candy` | 神奇糖果 | 1000 | 500 |
| `water-stone` | 水之石 | 800 | 400 | `sky-key` | 天空之钥 | **1500** | **不回收** |
| `fire-stone` | 火之石 | 800 | 400 | `ocean-key` | 海洋之钥 | **1500** | **不回收** |
| `master-ball` | 大师球 | 非卖品（**传说图鉴 6/6 奖励**） | 不回收 | `magma-key` | 熔岩之钥 | **1500** | **不回收** |
| | | | | `ruins-key` | 遗迹之钥 | **1500** | **不回收** |
| | | | | `island-key` | 岛之钥 | **1500** | **不回收** |
| | | | | `birth-key` | 诞生岛船票 | **1500** | **不回收** |

**传说区钥匙（`kind='key'`，2026-09；2026-10 H11 改为一次性）**：6 把钥匙各自对应一个传说区（§2「传说区」），**每把只够创建一次传说区遇敌**（`POST /capture/encounter` 时消耗；快速捕捉与野怪战斗共用这次遇敌，不重复扣）。
定位是**一次性门票**（1500P ≈ 日收入 100–300P 的 5–15 天积累）与**可交易的消耗品**（道具可经交易转手，但商店**不回收钥匙**——否则"买入→卖回"会凭空造出积分；`POST /items/:id/use` 也一律 `NOT_USABLE`，避免误点白白消耗门票）。`master-ball` 与钥匙在 `GET /shop` 里分别表现为"非卖品"与"可买不可卖"，前端据此隐藏卖出按钮。

**定价口径（2026-10 P2 回调，与 §10 的 faucet 配套）**：休闲玩家日收入约 **100–300P**（野怪 + 排位），
因此 1 个精灵球 ≈ 半日收入、高级球 400 ≈ **1-2 天积累**、银色王冠 1200 / 金色王冠 6000 ≈ **周/月级目标**，
TM 800（原 1500：360 个野生种里约 88% 已有 ≥90 威力招式，高价 TM 缺乏决策价值；H13），
**传说区钥匙 1500 = 数日目标**（一把钥匙换一次传说区遇敌机会，且每人在每区只能持有一只传说）；
回收（半价）只用于回血，不构成 faucet，**钥匙不回收**以维持稀缺性。旧价目（精灵球 20 / 高级球 150 / 王冠 1000）在 faucet 收紧后会让
稀有道具失去稀缺感，故整体重定价——数值与文案同步在 `backend/test/shop.spec.ts` 锁定。

商店的积分口径与 §10 一致：买方扣分 `reason='shop:buy'`、卖方返分 `reason='shop:sell'`，两笔都由 system 身份经 `PlayerContract.AddPoints` 提交，可审计。

## 4. 交易

> **锁资产语义（2026-10-25 修复 C5）**：创建交易只锁发起方的 `offer`；`request` 在创建时只预检归属与 `IDLE`，确认执行时才在同一笔交易内校验并交换。取消/过期仍解锁双方（兼容旧交易里被锁的 `request`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/trades` | `{toPlayerId, offer:{pokemonIds,itemIds,points}, request:{...}, ttlSeconds}` → `CreateTrade`（服务端算 manifestHash、expiresAt）。**`ttlSeconds` 上限 7 天**（`@Max(7*24*3600)`，链码同样兜底），且**只锁定发起方的 `offer`**——`request` 只做归属/IDLE 预检，接收方在确认前仍可自由使用/转移（2026-10-25 修复 C5） |
| POST | `/trades/:id/confirm` | 双方各调一次 `ConfirmTrade`；第二次确认时链上原子执行。若此时 `request` 资产已被转走/锁定，整笔回滚：抛 `NOT_OWNER`/`ASSET_LOCKED`，发起方 `offer` 保持锁定、交易仍 `OPEN` |
| POST | `/trades/:id/cancel` | `CancelTrade` |
| GET | `/trades/:id` / GET `/trades?box=in|out` | 查询 |

## 5. 对战与押注

### REST
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/battles/rooms` | `{mode:'1v1', name?, note?, wager, teamPokemonIds}` 创建房间（房主=A；房名/备注见下；`teamPokemonIds` **1-6 只且不得重复**——同一只宝可梦不能占多个槽位，否则等于 6 条命；违反 400 `DUPLICATE_TEAM`） |
| GET | `/battles/rooms` | 大厅列表（Redis 缓存，5s；`wagerA/wagerB` 为归一后的押注包，`name/note/joinMessage` 为房名/备注/加入者留言，见下） |
| POST | `/battles/rooms/:id/join` | `{wager, teamPokemonIds, message?}` 加入（=B；队伍 **1-6 只且不得重复**（`DUPLICATE_TEAM` 400）；`message` 为给房主的留言 ≤100 字） |
| GET | `/battles/rooms/:id` | 房间详情：房间本体 + **双方押注富化明细** `wagerDetailA/wagerDetailB` + **双方出战队伍富化明细** `teamDetailA/teamDetailB`（"查看押注"/"查看队伍"弹窗，任何人可看） |
| PATCH | `/battles/rooms/:id` | 房主改 `{name?, note?}`（仅房主、押注双确认前） |
| DELETE | `/battles/rooms/:id` | 房主删除房间（**仅 WAITING**：还没人加入；有人加入 → 409 `ROOM_NOT_EMPTY`，先 `kick`；`ACTIVE`/`FINISHED` → 409 `ROOM_NOT_OPEN`）。房间记录、大厅索引与大厅缓存一并清理 |
| POST | `/battles/rooms/:id/kick` | 房主请离加入者 `{playerId}`：房间回 WAITING（仅双方确认押注前） |
| POST | `/battles/rooms/block` | 屏蔽玩家 `{playerId}`（默认 30 分钟）：其加入我创建的房间 → 403 `BLOCKED_BY_HOST` |
| DELETE | `/battles/rooms/block/:playerId` | 解除屏蔽（幂等） |
| GET | `/battles/rooms/blocks` | 我的屏蔽名单 `[{playerId, blockedAt, expiresAt, remainingMs}]` |
| GET | `/battles/templates` | 常用押注模板 `{templates:[{id, name, note, wager, createdAt}]}`（每用户最多 10 个） |
| POST | `/battles/templates` | 存模板 `{name(≤30), note?, wager}`；超过 10 个 → 409 `TEMPLATE_LIMIT` |
| DELETE | `/battles/templates/:id` | 删模板（非本人 / 不存在 → 404 `TEMPLATE_NOT_FOUND`） |
| POST | `/battles/:id/wager/confirm` | 双方确认押注清单；第二次确认时：**先生成 battleId 并把房间置 `STARTING`** → 链码 `CreateBattle`（锁定+escrow）→ `ActivateBattle` → 创建 Socket.IO 房间；任何一步失败按 H5 规则补偿（见下「启动失败补偿」），不会把资产锁在链上而本地没有 battleId |
| POST | `/battles/:id/result/confirm` | 双方各确认一次对战结果 → 链码 `ConfirmResult`；第二次确认即 SETTLED（押注资产交付）。前端收到 `battle:end` 后自动调用，见下 |
| POST | `/battles/:id/forfeit` | 主动认输 → 链码 `Forfeit(loser=自己)` |
| POST | `/battles/:id/dispute` | `{reason}` → `Dispute` |
| POST | `/battles/:id/arbitrate` | arbitrator：`{outcome, note}` → `Arbitrate` |
| GET | `/battles/moves` | 技能元数据（静态表）：`{moves:[{id, name, type, power, accuracy, category, effectText}]}`（`accuracy` 为百分比 0-100；`effectText` 是效果说明，效果表未收录时为空串），战斗界面按 id 索引展示 威力/命中/属性/说明 |
| GET | `/battles/:id` | 对局详情（链上状态 + 链下回放摘要）：`{battle, live, roomId}`（`roomId` 供结算面板"查看押注"；房间已清理时为 `null`） |
| GET | `/battles/:id/replay` | 回合日志 + resultHash 供复核（P1） |

#### 排位房（ranked，契约与规则详见 §11）

排位赛复用同一套房间/引擎流程，差别只有三点：**wager=0**（不押注资产，只争 rating）、双方由服务端**自动加入并自动确认押注**（排位房跳过手动"确认押注"步骤）、链上 `SETTLED` 后由后端按 ELO 更新双方 rating 并给参战队伍加羁绊。

- 配对成功后**先进入 15 秒接受期**（`MATCH_PENDING`，双方各自 `POST /ranked/queue/accept`，见 §11.1），双方都接受才按上面的房间流程创建 battle（`playerA`=先入队者），`battle:activated` 推送与普通房一致；拿不到推送时前端轮询 `GET /ranked/queue/status` 的 `battleId` 进入 `/battle/:id`。
- 结算面板的**排位分 / 羁绊变化**（rating before→after、每只宝可梦 bond before→after）由 `GET /ranked/battles/:battleId/outcome` 提供（附加 `bot` / `arena` 字段），链上应用完成前返回 `{status:'PENDING'}`。
- 押注 DTO 对排位房不适用（押注包恒为 `{pokemonIds:[],items:[],points:0}`）；结算仍走 `SubmitResult → 双方 ConfirmResult → SETTLED`（2 分钟兜底 SettleBattle 同样有效）。
- 积分场（`mode:'arena'`）与机器人场（排队 60 秒后 `POST /ranked/queue/accept-bot`）复用同一引擎；机器人场没有房间（`roomId=null`），rating 增益 0、羁绊/经验减半，规则见 §11.1。

#### 押注 DTO（wager）

```jsonc
// POST /battles/rooms（另带 mode:'1v1'）、POST /battles/rooms/:id/join 请求体
{
  "wager": {
    "pokemonIds": ["p_xxx"],                     // 押注宝可梦（须本人 IDLE）
    "items": [{ "id": "i_xxx", "qty": 3 }],      // 道具按数量押注：qty ≥ 1，整堆 = qty = 堆叠总量
    "points": 50                                 // 押注积分（默认 0）
  },
  "teamPokemonIds": ["p_xxx"]                    // 出战队伍（1-6 只，须本人 IDLE 且非濒死宝可梦）
}
```

- **两种形态**：请求体是用户输入形态（`items:[{id,qty}]`，前端统一显式给 `qty`）；房间列表/详情响应（`wagerA/wagerB`）与链上 `Battle.wager` 同形态——`CreateBattle` 前先 `normalizeWagerBundle` 归一为 `{pokemonIds, items, points}`，`wagerHash` 覆盖**归一后**的对象。`GET /battles/:id` 的 `battle.wagerA/B` 取自链上记录，旧记录可能带 `qty=0`（旧格式整堆标记）。
- 旧格式 `itemIds:["i_xxx"]`（整堆押注）仍兼容，解析层归一为 `items:[{id, qty:0}]`；`items` 与 `itemIds` 不可混用（`INVALID_PARAM`）。服务端在创建/加入房间时把整堆语义解析为**显式数量 = 该堆叠当前持有量**，因此房间响应始终是显式 `qty ≥ 1`。
- **服务层预检**（给友好错误；链码 `CreateBattle` 仍是权威校验）：每个 `items[].id` 必须是**本人的 IDLE 堆叠**，且 `qty ≤ 当前持有量`。
- **部分数量押注**：`qty < 堆叠总量` 时 `CreateBattle` 把原堆叠减量（保持 IDLE），另建 `<parentId>#w<battleId>` 子堆叠并锁定；`qty = 堆叠总量`（或旧整堆）→ 原堆叠整体锁定。子堆叠 id 规则见 `docs/chaincode-api.md` §1 Item。
- **结算与堆叠合并**：赢家收下双方锁定的全部堆叠，收到/取回的堆叠与赢家同 `typeId` 的 IDLE 堆叠**自动合并**（最早创建的堆叠存活）；DRAW/REFUND 时子堆叠数量并回原堆叠（原堆叠已易主/非 IDLE 时该子堆叠恢复为独立 IDLE 堆叠）。
- 押注相关错误码（统一 `{statusCode, code, message}`）：

| code | HTTP | 场景 |
|---|---|---|
| `INVALID_PARAM` | 400 | wager 结构非法（`items`/`itemIds` 混用、资产重复、`qty` 非正整数等）；`PATCH /battles/rooms/:id` 未给任何字段 |
| `INVALID_TEAM_SIZE` | 400 | 出战队伍不是 **1-6 只**（创建/加入房间、排位入队同一口径） |
| `DUPLICATE_TEAM` | 400 | 出战队伍里有重复的宝可梦 id（创建/加入房间、排位入队同一口径；2026-10-25 修复 H2） |
| `ITEM_NOT_FOUND` | 404 | 押注道具不存在 |
| `NOT_OWNER` | 403 | 押注道具 / 出战宝可梦不属于本人 |
| `ASSET_LOCKED` | 409 | 押注道具 / 宝可梦已被锁定（交易或对战） |
| `FAINTED` | 409 | 出战队伍里有 0 HP 的宝可梦（伤势持久化：队伍提交与押注双确认前各校验一次，链上资产此时尚未锁定） |
| `INSUFFICIENT_QUANTITY` | 409 | `qty` 超过该堆叠当前持有量 |
| `ROOM_NOT_OPEN` / `ROOM_NOT_READY` / `SAME_PLAYER` | 409 | 非 WAITING 房间加入 / 房间未就绪 / 加入自己的房间；房名备注与请离在 `ACTIVE`/`FINISHED` 后同样返回 `ROOM_NOT_OPEN` |
| `NOT_HOST` | 403 | 非房主调用 `PATCH`/`DELETE /battles/rooms/:id` 或 `POST /battles/rooms/:id/kick` |
| `ROOM_NOT_EMPTY` | 409 | `DELETE /battles/rooms/:id` 时房间里已有挑战者（`JOINED`）——先 `kick` 再删 |
| `PLAYER_NOT_IN_ROOM` | 409 | 请离的目标不是当前加入者（`playerB`） |
| `BLOCKED_BY_HOST` | 403 | 被房主屏蔽（30 分钟有效期内）后 `join` 该房主的房间 |
| `TEMPLATE_LIMIT` | 409 | 押注模板超过 10 个 |
| `TEMPLATE_NOT_FOUND` | 404 | 删除不存在 / 不属于自己的模板 |

#### 房间体验扩展（队伍规模 / 删房间 / 看队伍 / 房名备注 / 请离 / 屏蔽 / 押注模板）

- **出战队伍规模 1-6 只**：`POST /battles/rooms`、`POST /battles/rooms/:id/join` 的 `teamPokemonIds` 与排位 `POST /ranked/queue` 同一口径，超出/为空 → 400 `INVALID_TEAM_SIZE`（服务层校验，先于资产归属校验；`CreateBattle` 前的 `confirmWager` 会再跑一次同一个断言）。前端 `WagerPicker` 与 `RankedView` 在第 7 只时拒选并提示（`components/team-picker.ts::TEAM_SIZE_MAX`）。
- **房主删除房间**（`DELETE /battles/rooms/:id`）：仅房主、**仅 `WAITING`**（没有任何挑战者）时可删——房间记录、`battle:rooms` 索引与大厅缓存一并清理，响应 `{deleted:true, roomId}`。有挑战者（`JOINED`）→ 409 `ROOM_NOT_EMPTY`（提示先 `kick`，避免把对手的报名直接抹掉）；`ACTIVE`/`FINISHED` → 409 `ROOM_NOT_OPEN`（资产已链上锁定/已结算，只能走对局流程）。非房主 403 `NOT_HOST`，重复删除 404 `ROOM_NOT_FOUND`。前端大厅自己房间卡片上的"删除房间"按钮带二次确认。
- **互看出战队伍**：房间详情返回 `teamDetailA/teamDetailB`（队伍富化明细，**任何登录用户都能看，含旁观者**——不要求是房间当事人，也不要求押注已确认），前端大厅卡片 / 加入 / 确认面板的"查看队伍"弹窗（`TeamInspectDialog`）直接展示。字段口径与押注富化完全一致（见下），因此 IV/EV/性格不在响应里，`bond` 是公开的展示值。
- **房名与备注**（`name` ≤30 字、`note` ≤100 字）：创建房间可带，房主可用 `PATCH /battles/rooms/:id {name?, note?}` 修改（仅房主、押注双确认前；空串 = 清空）。服务端统一 **trim + HTML 转义**（`& < > " '` 转义、控制字符折叠），落库/落 Redis 的即转义后的文本；大厅列表与房间详情原样返回，前端用文本插值渲染（不再有二次注入面）。超长由 DTO 直接 400。
- **加入者留言**（`join.message` ≤100 字，可选）：随房间返回（`joinMessage`，房主与加入者都能在确认面板看到），房间回 `WAITING`（被请离/重开）时清空；同样 trim + 转义。
- **房主拒绝权**（`POST /battles/rooms/:id/kick {playerId}`）：仅房主、且仅在**双方确认押注前**（房间 `WAITING`/`JOINED`；双确认即链上 `CreateBattle` 锁定资产，此后只能 forfeit/结算）。成功后房间回 `WAITING` 并清空 `playerB/wagerB/teamB/joinMessage`，**双方确认状态一并重置**（押注清单变了，房主需重新确认）。被请离者通过其房间列表轮询（5s，发现"我不再是 B 且房间回 WAITING"）或 `battle:room-kicked {roomId, hostId, playerId}` 推送（服务端推给 `user:<playerId>` 房间）收到提示。
- **屏蔽名单**（`POST /battles/rooms/block {playerId}` / `DELETE /battles/rooms/block/:playerId` / `GET /battles/rooms/blocks`）：按**屏蔽者维度**存 PG `player_blocks`，默认 TTL 30 分钟（`BATTLE_BLOCK_TTL_MS` 覆盖，过期记录读取时惰性清理）。有效期内被屏蔽者 `join` **该房主创建的任何房间**都返回 403 `BLOCKED_BY_HOST`；屏蔽不改变已在房间内玩家的状态（要走人用"请离"），也不能屏蔽自己（`INVALID_PARAM`）。
- **押注模板**（`GET/POST/DELETE /battles/templates`）：存 PG `wager_templates`，每用户最多 10 个（超出 409 `TEMPLATE_LIMIT`），内容 = 名称（≤30）+ 备注（≤100）+ 归一后的押注清单（与链上 `Battle.wager` 同形态）。模板只保存"当时的清单"，资产会随易主/消耗过期——载入时前端按当前背包裁剪（剔除不在背包/非 IDLE 的项、数量夹到持有量），创建/加入房间仍以链上校验为准。
- **房间详情**（`GET /battles/rooms/:id`）：房间本体 + **双方押注富化** `wagerDetailA/B` + **双方出战队伍富化** `teamDetailA/B`，供大厅卡片 / 加入 / 确认面板的"查看押注"、"查看队伍"弹窗一键展示：

```jsonc
{
  // ...BattleRoom 全字段（含 name / note / joinMessage / wagerA / wagerB / teamA / teamB / confirmations / status）
  "wagerDetailA": {
    "points": 25,
    "pokemon": [{
      "id": "p_xxx", "name": "pikachu", "speciesId": 25, "nameZh": "皮卡丘",
      "level": 20, "shiny": false, "bond": 55,
      "stats": { "hp": 44, "atk": 35, "def": 28, "spatk": 30, "spdef": 30, "speed": 41 },
      "unavailable": false           // 链上已读不到（已消耗/易主清理）时为 true，其余字段为 null
    }],
    "items": [{ "id": "i_xxx", "typeId": "poke-ball", "name": "Poké Ball", "nameZh": "精灵球", "qty": 3, "held": 5, "unavailable": false }],
    "totals": { "pokemon": 1, "itemQty": 3, "points": 25 }
  },
  "wagerDetailB": null,              // 未加入时为 null
  "teamDetailA": [{                  // 房主出战队伍（id 顺序 = teamA 顺序）
    "id": "p_xxx", "name": "pikachu", "speciesId": 25, "nameZh": "皮卡丘",
    "level": 20, "shiny": false, "bond": 55,
    "stats": { "hp": 44, "atk": 35, "def": 28, "spatk": 30, "spdef": 30, "speed": 41 },
    "unavailable": false
  }],
  "teamDetailB": null                // 未加入时为 null（字段口径与 teamDetailA 相同）
}
```

- `stats` 用与 `GET /pokemon/:id` 相同的口径（种族值 + IV + EV + 等级 + 性格，见 §2「能力值计算」）；`qty` 是押注数量、`held` 是该堆叠当前持有量（`0` = 已不在链上）。`wagerDetail*` / `teamDetail*` 的宝可梦一项**只有公开字段**（`id/name/speciesId/nameZh/level/shiny/bond/stats/unavailable`）——`name` 是链上名字（改名后即玩家昵称），`stats` 是最终六项能力值，**IV/EV/性格不出现在任何房间响应里**。

### WebSocket（Socket.IO，命名空间 `/battle`，JWT 鉴权）
- 客户端→服务端：`battle:join {battleId}`、`battle:action {battleId, seq, action}`。`battle:join` 先回 `battle:state`（带 `you`），若当前有未结算回合再补发 `battle:turn {awaitingPlayerIds, deadline}`——刷新/重连后立即恢复出招按钮与倒计时（H15）；鉴权用动态 token（每次重连取当前 accessToken，H16）。
- `action` 用**资产 id** 而非引擎槽位：`{type:'move', moveId:'thunderbolt'}`、`{type:'switch', targetPokemonId:'p_xxx'}`、`{type:'run'}`；服务端按对局 state 解析成引擎槽位（引擎原生 `moveIndex`/`toIndex` 仍接受，内部/测试用，与 id 形式二选一）。`item` 类型暂不支持：服务端直接拒绝 `ITEM_NOT_SUPPORTED`，**不消耗回合**（避免旧行为里道具动作吞掉一次行动）。
- `battle:error` 常见 code：`BAD_ACTION`（action.type 缺失/未知）、`UNKNOWN_MOVE`（技能不属于出战宝可梦）、`UNKNOWN_POKEMON`（换宠目标不在队伍）、`INVALID_MOVE_INDEX` / `INVALID_SWITCH_INDEX`、`SWITCH_TO_ACTIVE` / `SWITCH_TO_FAINTED` / `MUST_SWITCH`、`ACTION_ALREADY_SUBMITTED`、`ITEM_NOT_SUPPORTED`、`BATTLE_FINISHED`、`BATTLE_NOT_LIVE`、`NOT_PARTY`、`UNAUTHORIZED`；前端 `BATTLE_ERROR_TEXT` 映射为中文提示，未收录的 code 原样展示。
- 服务端→客户端：`battle:state {fullState}`（每回合广播，服务端权威）、`battle:turn {awaitingPlayerId, deadline}`、`battle:entry {awaitingPlayerIds, deadline, graceMs}`（入场宽限期内的等待方）、`battle:end {winnerId, resultHash, txId}`、`battle:error {code}`、`battle:activated {roomId, battleId}`（押注双确认、战斗激活后向双方 `user:<playerId>` 房间推送——**先确认方没有携带 battleId 的 REST 响应，靠该推送自动进入 `/battle/:id`**；大厅视图需长连 `/battle` 监听）、`battle:room-kicked {roomId, hostId, playerId}`（房主请离后推给被请离者 `user:<playerId>` 房间；大厅视图同时用 5s 轮询兜底发现被请离，见 §5 房间体验扩展）
- **实时战斗日志（2026-09 新增）**：`battle:state.state.log` 是**每个已结算回合**的完整事件数组
  `[{turn, actions:{A,B}, events:[{kind, side?, detail}]}]`，随每次 `battle:state` 全量推送（含单方已出手、
  回合未结算时的推送——那时新回合尚未入 log）；`battle:join` 的快照同样带全量 log，重连后日志不丢。
  `kind` ∈ `switch|move|miss|damage|faint|run|win|paralyzed|status|status-damage|stat|drain|recoil`，
  `detail` 除各自字段（move/damage/eff/crit/roll/healed…）外，**攻击/受击/异常/能力阶级事件都带
  `pokemonId`（受影响单位）与 `attacker`/`defender`（出手方/目标方 id）**——服务端只下发 id，
  前端 `frontend/src/game/battle-log.ts` 用 `useI18n` 的 `monName`/`moveName` 换成当前语言的名字后，
  在 `BattleView` 的「战斗日志」面板逐行滚动展示（"喷火龙 使用了 喷射火焰！/ 效果绝佳！对 皮卡丘 造成 87 点伤害 /
  皮卡丘 陷入了灼伤！/ 皮卡丘 倒下了！"）。`log` 同时是 `resultHash` 的哈希对象（`canonical(回合日志)`），
  与 `GET /battles/:id/replay` 的落库内容一致，可事后复核。
- **PvP 满血出战**：实时对局（房间/排位/机器人）双方都以**满血满状态**开局并**不回写**链下 HP
  （`poke:hp` 只被野怪战斗读写，见 §2「伤势持久化」）；濒死校验仍在**报名/提交队伍**时生效。
- 规则：**服务端权威**计算（简化回合制：速度决定先手、属性克制表、命中/暴击用该 battle 的 RandomCommit 派生流、**能力阶级/异常状态已落地**（见 §2「技能特效」，burn/psn/par 三种，掷点顺序 麻痹→命中→暴击→浮动→追加效果））；每回合 30s 超时 → 超时方判负走 `Forfeit`；掉线 60s 未重连判负；结束后服务端 `SubmitResult(resultHash=sha256(canonical(回合日志)), serverSig=secp256k1 签名)` → **前端双方客户端收到 `battle:end` 后自动** `ConfirmResult`（结算面板显示"已确认 x/2，等待对方确认"；自动确认失败时给手动"确认结算"按钮；SETTLED 后提示"押注已交付"并刷新背包/积分）→ 二次确认即链上 SETTLED；2 分钟（`BATTLE_SETTLE_FALLBACK_MS`）无人确认时服务端 `SettleBattle` 兜底。
- **入场宽限（`BATTLE_ENTRY_GRACE_MS`，默认 90s）**：战斗激活后双方各自 `battle:join` 视为到场，**双方都到齐才启动 30s 回合计时**（宽限期内不发 `battle:turn`）；宽限结束时仍有一方未到场 → 该方 `Forfeit` 判负（押注归对方，非 DRAW），双方都没到场才判 DRAW。战斗开始后掉线仍按 60s 判负。
- **房间生命周期**：房间在其 battle 进入终态（SETTLED/REFUNDED）后立即置为 FINISHED 并从 `GET /battles/rooms` 列表剔除（含引擎自行结束的路径与重启/结算兜底后的对账）；`ACTIVE` 房间仅对当事双方显示"回到战斗"重连入口，重连失败（`BATTLE_NOT_LIVE`）时前端提示"该对局已结束或已清理"并自动退回大厅、刷新列表。瞬态 `STARTING`（已生成 battleId、正在链上建局/起引擎）与补偿失败的 `FAILED` 不进入大厅列表，避免出现点不进去的房间。
- **启动失败补偿（H5，2026-10-25）**：押注双确认后先落 `battleId + STARTING` 再调链。`CreateBattle` 失败时先读链：链上确认不存在 → 房间回 `JOINED`、清 `battleId`，双方可重试；结果未知（网络超时/链不可读）或链上已存在 → 走补偿。`ActivateBattle`/读队伍/起引擎失败 → 按链上状态补偿：`CREATED` 调 `CancelBattle` 全额退款（→REFUNDED）、`ACTIVE` 调 `settleAbandoned` 以 DRAW 退款（→SETTLED）。补偿成功房间置 `FINISHED`；补偿本身失败（链不可读）置 `FAILED` 并保留 `battleId`，由对账重试，资产不会永久冻结。
- **重启对账**：内存引擎随进程消失后，后端启动即按链上状态对账 Redis 房间——`SETTLED`/`REFUNDED`/`DISPUTED`/链上已无此 battle → 关房出列；`RESULT_SUBMITTED` → 直接 `SettleBattle` 兜底；`CREATED`（含 `STARTING`/`FAILED` 残留）→ `CancelBattle` 全额退款（→REFUNDED，`resultHash=sha256("cancel|<id>|server-restart")`）；`ACTIVE`（引擎已丢）→ `SubmitResult(DRAW)` + `SettleBattle` 按"服务中断"退款（resultHash 前缀 `server-restart`，链下半审计日志 `battle.reconcile`）；双方资产/积分原路退回并解锁；单个房间失败仅记日志，不阻塞启动。运行期 `GET /battles/rooms` 对"`ACTIVE` 但本进程无引擎且超过 `BATTLE_RECONCILE_STALE_MS`（默认 10 分钟）"以及"`STARTING` 但本进程无引擎"的房间隐藏并触发一次后台对账（未超时的 ACTIVE 房间保留"回到战斗"入口，供重启后短时间内重连）。
- 战斗 RandomCommit：wager 双方确认后由服务端 `Commit(purpose='battle')`，结束时 `RevealAndVerify`，保证全程判定可审计。

## 6. 资源与公平性

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/assets/manifest` | 前端资源清单 `[{uri, sha256, size}]`（MinIO 签名 URL，前端下载后校验哈希） |
| POST | `/assets/register` | admin：登记资源 `metadataHash+URI` |
| GET | `/fairness/:eventId` | 返回 RandomCommit + 派生算法说明 + `serverPublicKey`/`serverKeyId`（公钥指纹），供任何人复核。**H9：`COMMITTED` 阶段不返回 `serverSeed`/`resultHash`**（响应带 `revealed:false` 与说明），结算后（`REVEALED`/`CONSUMED`）才返回完整数据；战斗事件在结算时揭示。**H19**：`SERVER_SIGNING_KEY` 固定时 `serverKeyId` 跨重启不变，`battle_logs.serverKeyId` 记录当次签名密钥。**P2-3 战斗披露**：`eventId` 形如 `ev_battle_<battleId>` 时额外返回 `battle:{battleId, winnerId（链上）, resultHash（battle_logs 的回合日志哈希，缺失时回退链上）, serverSig（DER hex）, serverKeyId, turnLog（battle_logs.turns_json，缺失为 null）}`；前端用 `sha256(canonicalize(turnLog))` 复算 resultHash 并用 secp256k1 验签（签名为对 `sha256(resultHash bytes)` 的 ECDSA DER）。`COMMITTED`/随机事件本身仍按 H9 裁剪 |
| GET | `/leaderboard` | 积分榜（Redis ZSET 缓存；监听链上 `PointsChanged`/`PlayerRegistered`/`BattleSettled`，事件里的 `playerId`/`playerA`/`playerB`/`winnerId`/`fromId`/`toId` 都会触发重读对应玩家余额刷新） |

## 7. PostgreSQL 表（链下）

`users(id, username, password_hash, nickname, avatar_uri, role, fabric_cert_enc, fabric_key_enc, created_at)`
`friendships / blacklists`（P1）
`battle_logs(id, battle_id, turns_json, result_hash, server_sig, server_key_id, created_at)`（`server_key_id` = 签名公钥指纹，H19；空串=旧记录）
`audit_logs(id, actor, action, target, detail, created_at)`（admin/arbitrator 操作留痕）
`chat_messages`（P1）

## 8. Fabric 集成约定

- `backend/src/fabric/`：`FabricGatewayService`（连接 `peer0.org1:7051`，identity=admin/system 服务身份 + 按用户加载其证书代发交易）、`ContractService`（按 §docs/chaincode-api.md 逐方法封装 submit/evaluate，统一注入 idemKey=crypto.randomUUID()）、`EventListenerService`（监听链上事件 → Redis pub/sub → Socket.IO 推送给前端刷新资产）。
- 用户交易代发模式：后端用用户托管证书签名（课程环境私钥加密存 DB，文档说明 HSM/KMS 风险）；system 身份（`system` 用户，CA 属性 role=system）用于 CreateBattle/SubmitResult 等。
- 连接配置经 `.env` 注入：`FABRIC_PEER_ENDPOINT` / `FABRIC_PEER_TLS_CERT_PATH` / `FABRIC_PEER_HOST_ALIAS` 直连 peer（TLS 证书取自 `network/organizations/`）；`FABRIC_CONNECTION_PROFILE` 变量保留但当前实现未消费。

## 9. 安全基线

helmet、CORS 白名单、class-validator 全入参、TypeORM 参数化、argon2、JWT 短时效、nonce 防重放、限流、日志脱敏（不记密码/私钥/seed 明文——serverSeed 仅在 reveal 前存内存/KMS，reveal 后上链公开）。前端会话：refresh 请求固定 5s 超时（H17，避免首屏守卫挂起）、Socket.IO 每次（重）连用回调取当前 accessToken 且鉴权失败停止重连（H16）、交易确认按 username 比较 `fromId/toId`（H14，UUID 比较会导致确认状态错误）。

## 10. 积分经济

积分是**链上游戏发行资产**（Player.points，Fabric 上没有原生代币/挖矿，见 `docs/architecture.md`「为什么 Fabric 没有挖矿与节点奖励」）：
只能由 `admin` / `system` 身份经 `PlayerContract.AddPoints` 增减，每一笔都带可审计的 `reason`（`addPoints` 幂等键由调用方固定，成本口径见 `backend/src/pokemon/points-economy.ts`）。
用户侧积分一律来自链上状态：`GET /users/me` 的 `points` 即 `Player.points`。

**来源（sources，2026-10 P2 后：注册 400 + 72h 转账锁、竞技场零增发，其余 faucet 维持 2026-09 收紧口径）**

| 来源 | 数量 | reason | 幂等键 | 实现 |
|---|---|---|---|---|
| 注册 | **+400**（`INITIAL_POINTS`） | —（`RegisterPlayer` 初始值） | `register-<username>` | 链码 `PlayerContract.RegisterPlayer`（`docs/chaincode-api.md` §2.1）；同时写 `transferLockUntil = nowISO + 72h` |
| 传说图鉴 6/6 | 大师球 ×1（道具，非积分） | —（`MintItem`） | `legendary-dex-<playerId>` | `pokemon/legendary-reward.ts`（快速捕捉/野怪收服后触发，每人一次） |
| 收服野怪成功（野怪战斗或快速捕捉） | +20 | `reward:catch:<pokemonId>` | `<pokemonId>-reward-catch` | `wild/wild.service.ts::grantCatchReward`、`pokemon/capture.service.ts::attempt` |
| 击倒野怪 | 野怪等级 × 1（**传说区 0**） | `reward:wild-faint:<sessionId>` | `<sessionId>-reward-faint` | `wild/wild.service.ts::grantFaintReward`（`WILD_FAINTED` 结算时） |
| 放生宝可梦 | 等级 × 1 | `reward:release:<pokemonId>` | `<pokemonId>-reward-release` | `pokemon/pokemon.service.ts::grantReleaseReward`（`Release` 之后） |
| PvP 胜利 | **不给积分，只给经验**（参战队伍 +30 exp） | — | `<battleId>-exp-<pokemonId>` | §5 / §11，经验与积分是两套口径 |
| PvP 押注赢取 | 双方押注积分之和 | `battle-settle`（结算走链码内部转账） | battle 结算幂等 | `docs/backend-api.md` §5 |
| 积分场（arena）胜者 | 双方准入积分之和（**H12 起零和、无系统补贴**） | `arena:reward:<battleId>` | `<battleId>-arena-reward` | §11.1 积分场（`BattleRewardService::applyArenaSettlement`） |
| 积分场平局退还 | 各自准入额 | `arena:refund:<battleId>` | `<battleId>-arena-refund-A/B` | 同上 |
| 积分场取消/仲裁退款 | 各自准入额 | `arena:entry-refund:<battleId>` | `<battleId>-arena-entry-refund-A/B` | `RankedService::refundArenaEntries`、§11.1 |
| 交易收付 | 按 offer/request | `trade` | trade 幂等 | §4 |
| admin 投放 | 任意 | 调用方给（如 `admin` / `smoke`） | 每次新 uuid | `POST /admin/points` |

**消耗（sinks）**：训练（`train`）、付费诱饵（`lure:tier1` = 50 / `lure:tier2` = 200）、押注托管（`battle-escrow`）、交易支付（`trade`）、
商店购买（`shop:buy`，见 §3 价目表；**传说区钥匙 1500P/把是一次性门票且不回收**）、**宝可梦中心治疗（`heal:center`，每次 10P，全员满血不扣费）**、
**积分场准入（`arena:entry:<battleId>`：青铜 20 / 白银 50 / 黄金 100 / 白金 200 / 大师 400，双方接受时才扣）**。
`AddPoints` 余额不足抛 `INSUFFICIENT_POINTS`，扣减不落链（积分场扣费失败则取消建房并让双方回队列）。

**日收入口径（写进定价依据）**：野怪（普通区击倒 等级×1 + 收服 20，含掉落道具折算；传说区击倒 0）约 **60–200P/天**；
排位（casual 只给评级与羁绊，arena 零和）约 **0–50P/天**；
合计 **100–300P/天**——据此对齐商店价目（精灵球 50、高级球 400、银冠 1200/金冠 6000、TM 800）。
积分通胀的主要旧来源（收服 50 / 击倒 等级×2 / 放生 等级×5）已收紧，放生不再是刷分手段。

**实现要点**

- **新手礼包**（`POST /users/me/starter`，§1）：`Commit(purpose='capture', meta='{"starter":true}')` → `RevealAndVerify` →
  `deriveWildSpecimen`（野怪区域派生布局，`docs/randomness.md` §3）定 IV/性格/闪光 → `MintFromCapture`（level 5，idemKey=`starter-<username>`）→ 礼包 `MintItem`（精灵球×5、伤药×2，同 typeId 自动合并堆叠）。
  事件 id 固定为 `starter-<username>`，`GET /users/me` 的 `hasStarter` = 该事件状态为 `CONSUMED`（mint 与消费随机数在同一笔交易里，二者要么都成要么都不成）。
  重复调用 409 `STARTER_ALREADY_CLAIMED`（礼包按同一批 idemKey 幂等重放，已交易掉也不会补发）；commit 已上链但进程中断时用 Redis `starter:pending:<username>`（TTL 600s）续跑，serverSeed 丢失则报 409 `STARTER_PENDING`（不重复铸造）；并发双击由 `starter:lock:<username>`（TTL 30s）串行化，第二个请求 409 `STARTER_IN_PROGRESS`。
- **收服/击倒奖励**：奖励发放用链上归还的 `pokemon.id` / 会话 id 作幂等键——投球、动作重放（会话已结束只返回终态）都不会重复加分。奖励失败会抛错（客户端重放即可幂等补齐），因为此时会话尚未落盘。
- **放生奖励**：顺序固定「先 `Release` 再发积分」。链上 `Release` 不可回滚，发积分失败只记告警（ownerId 已清空、重试会被 `NOT_OWNER` 拒绝，无法补发）；反过来先发积分则会出现"没放生却拿到积分"，故顺序不可颠倒。
- **宝可梦中心**：`POST /pokemon/center/heal` 扣 10P（reason=`heal:center`）+ 链下把本人 `IDLE` 宝可梦回满；**全员满血时不扣费也不返回治疗明细**（避免误点白花积分）。与训练/诱饵一样是"每次调用一笔新交易"，请求级防重放由 `X-Nonce`/`X-Timestamp` 保证。
- **前端展示**：捕捉成功 / 击倒结算面板显示 `+NP`（来自 `catchReward` / `faintReward`；传说区击倒为 0），放生确认框注明"可得 等级×1 积分"；顶栏积分为 `GET /users/me` 的 `points`（登录/注册/选 starter 后刷新）。

## 11. 排位与羁绊（正反馈 / 留存机制）

链上两个成长量：`Player.rating`（排位分，默认 1000）与 `Pokemon.bond`（羁绊值 0-255，铸造 50）。
两者都由后端 system 身份代发（`PlayerContract.UpdateRating` / `PokemonContract.BondUp`），**每个数值变化都有可审计的 reason 与确定性幂等键**。

### 11.1 排位赛（`backend/src/ranked/`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/ranked/queue` | `{teamPokemonIds, mode?}`（`mode:'casual'` 默认 / `'arena'` 积分场）→ 进 Redis 匹配队列（ZSET `ranked:queue`，score=rating）并立即尝试配对。**入队即校验队伍：规模 1-6（否则 400 `INVALID_TEAM_SIZE`）、非本人/非 IDLE/濒死（0 HP）分别抛 403 `NOT_OWNER`、409 `ASSET_LOCKED`、409 `FAINTED`（指明是哪只）**——带濒死者不能排队（arena 同样，未扣准入）。返回排队状态（见下） |
| GET | `/ranked/queue/status` | 排队状态轮询，**每轮都会再尝试一次配对**（轮询即匹配）。`QUEUED` 带 `waitedMs/waitedSec/window/queueSize/botOffer/entryFee`；`MATCH_PENDING` 带对手、15s 接受期与**对手出战队伍预览**（见下「接受期看对手阵容」）；`MATCHED` 带 `battleId/roomId/opponent`（机器人场 `roomId=null, bot=true`，`MATCH_PENDING` 不会出现）；条目过期（300s）→ `TIMEOUT`；配对失败 → `ERROR`（带原因） |
| POST | `/ranked/queue/accept` | 接受匹配（15 秒接受期内；**双方都接受才建房**，第二个 accept 返回 `MATCHED`） |
| POST | `/ranked/queue/decline` | 拒绝匹配：双方回队列，自己 30 秒内窗口重置为 ±200（且 30 秒内不再与该对手配对）；返回 `QUEUED` + 提示文案 |
| POST | `/ranked/queue/accept-bot` | 接受机器人对手（排队满 60 秒才可用；casual 专属，arena → 409 `ARENA_BOT_UNAVAILABLE`；超每日 5 场 → 429 `BOT_DAILY_LIMIT`） |
| DELETE | `/ranked/queue` | 取消排队（已配对时不撤销对局返回 `MATCHED`；**待确认期内 = 放弃该对局**，自己 IDLE、对方回队列） |
| GET | `/ranked/leaderboard` | 前 50 + 自己名次：`{top:[{rank,playerId,nickname,rating,wins,losses,isMe}], me:{...}}`；Redis ZSET 缓存（10s）+ 链上 rating 对账刷新，`?refresh=1` 跳过缓存（机器人 `BOT` 不上榜） |
| GET | `/ranked/me` | `{rank, playerId, nickname, rating, wins, losses, total}`（rating/wins/losses 直接取链上 `Player`） |
| GET | `/ranked/battles/:battleId/outcome` | 结算面板数据：`{status?, ranked, winnerId, settledAt, ratings[], bonds[], bot?, arena?}`；应用完成前 `{status:'PENDING'}`，无记录 `{status:'NONE'}` |

**排队状态机**

```
POST /queue ──► QUEUED ──配对成功──► MATCH_PENDING（15s 接受期，双方各 accept）
                  ▲                      │  双方 accept ──► MATCHED（建房+开局）
                  │                      │  任一方 decline / 超时 / 取消
                  └──────────────────────┘  （双方回队列；拒绝/未接受方窗口重置 ±200 / 30s）
QUEUED ──60s 无真人──► still QUEUED + botOffer:true ──accept-bot──► MATCHED（练习赛，奖励减半）
QUEUED ──300s 未匹配──► TIMEOUT；配对失败 ──► ERROR（带原因）
```

**匹配窗口（随时间扩圈）**

- 窗口 = `min(±1000, ±200 + floor(等待秒数/10) × 50)`；刚拒绝对手/超时未接受的玩家 30 秒内窗口被按下限 ±200 计。
- 配对条件：分差 ≤ `min(窗口A, 窗口B)`（双方都要能接受这个分差）；**先入队者为 playerA**（同毫秒按 playerId 字典序）。
- 两侧窗口由 ZSET 全量读取后在内存里筛（队列规模是演示级）；配对临界区由 Redis 锁 `ranked:matchlock` 串行化，每次只配一对。
- 队列条目 `ranked:queue:<playerId>`（TTL **300 秒**）：队伍 / 入队时 rating / 入队时间 / `mode` / `windowResetUntil` / `avoid`（刚拒绝的对手）/ `matchId`；过期条目在下次匹配时惰性清理，前端收到 `TIMEOUT`。
- 待确认对局 `ranked:pending:<matchId>`（TTL 60s）+ 双方索引 `ranked:pending:of:<playerId>`：`{mode, playerA/B, ratingA/B, teamA/B(配对时的队伍快照), acceptA/B, deadline(15s)}`；接受期结束（超时）由轮询惰性回收，未接受方按"拒绝方"处理。

**接受期看对手阵容（`MATCH_PENDING`）**

`GET /ranked/queue/status`（以及 accept/decline 的响应）在 `MATCH_PENDING` 时把对手的出战队伍一并返回，供双方在接受/拒绝前评估对局：

```jsonc
{
  "state": "MATCH_PENDING",
  "opponent": {
    "playerId": "gary", "nickname": "小茂", "rating": 1010,
    "team": [{                       // 裁剪视图：只有对局中人人可见的信息
      "id": "p_xxx", "name": "pikachu", "speciesId": 25, "nameZh": "皮卡丘",
      "level": 20, "shiny": false,
      "stats": { "hp": 44, "atk": 35, "def": 28, "spatk": 30, "spdef": 30, "speed": 41 }
    }]
  }
}
```

- **隐私裁剪**：`team[]` 里只有 `id/name/speciesId/nameZh/level/shiny/stats`——**没有 IV、EV、性格**（这些在原作里对对手不可见，`stats` 是已经算好的最终值），也不含 `bond`（羁绊只在我方视角与房间详情里出现）。实现：`wager-detail.ts::toOpponentTeam`（`enrichTeam` 后按白名单取字段），队伍 id 来自配对时写入的 `teamA/teamB` 快照，旧记录回退读该玩家的排队条目。
- 队伍规模/归属/濒死校验与入队一致（1-6、本人、IDLE、非濒死）；`MATCHED` 之后不再返回 `team`（对局已开始，阵容在战斗界面里看）。

**建房（双方接受之后）**

- `casual`：**沿用既有房间流程**——`wager={pokemonIds:[],items:[],points:0}`、双方自动加入 + 自动确认押注 → `CreateBattle` → `ActivateBattle` → 引擎开局，并推送 `battle:activated`。排位房与普通房在同一大厅列表/对局列表里（`FINISHED` 后同样出列）。
- `arena`：**先扣双方准入积分（扣失败即取消建房），再建房**，因此 battleId 由排位侧生成（reason 要带 battleId）；房间仍是同一套记录（`createRoom`/`joinRoom` + 激活记账），机器人场没有房间（`roomId=null`）。
- 队伍校验与普通房一致：**规模 1-6 只且不得重复**（否则 400 `INVALID_TEAM_SIZE` / `DUPLICATE_TEAM`），每只宝可梦必须属于本人、`status=IDLE` **且非濒死（0 HP，`assertTeam` 在入队时就拦下并指明是哪只）**（锁定中/已释放/濒死不能参赛）；配对时二次校验（含 1-6），队伍失效则**双方出队**并在下次轮询返回 `ERROR`。

**ELO 结算（K=32）**

```
期望分  E_a = 1 / (1 + 10^((R_b − R_a)/400))
新分    R_a' = clamp(round(R_a + 32 × (S_a − E_a)), 0, 99999)
        胜者 S=1、负者 S=0、平局双方 S=0.5（DRAW 按 0.5 期望结算）
机器人场：变化量 ×0（H12：零风险场不推进段位；`BOT_RATING_SCALE = 0`）
```

- `R_a/R_b` 取**首次应用时链上的 rating**（链为准），计算出的新分**固化在排位房记录里**（`ranked:battle:<battleId>.plan`），之后的重试/重放都用同一组数值提交，配合固定幂等键与链上 `UpdateRating` 的幂等，重复应用不会叠加（幂等测试覆盖：重复广播 + 重复 sweep 后分数不变）。
- 排位房标记：`ranked:battle:<battleId>`（Redis，24h）记录 `playerA/playerB/teamA/teamB/mode/state(PENDING→PLANNED→APPLIED)/plan/bot?/arena?`；非排位对局没有该记录 → 结算时只发羁绊、不动 rating。

**机器人对手（练习赛，`ranked/bot.service.ts`）**

- 链上注册共享玩家 `BOT`（`RegisterPlayer` 幂等，初始 rating 1000，昵称"训练家机器人"）；对局走同一套 `CreateBattle`/引擎，**机器人不会自己 ConfirmResult** → 对局结束由服务端以 system 身份 `SettleBattle` 收尾，奖励立即可见（不必等 2 分钟兜底）。
- 队伍：**3 只内存临时实体**（不上链），等级 = 玩家队伍平均等级 ±2（夹 2-100），种族从野生池随机，技能取该等级已学会的最后 4 个；生成种子与队伍摘要记在 `ranked:battle:<battleId>.bot`（可复核）。
- 出招：服务端代打，监听引擎 `turn` 广播后延迟 0.7s 出招；从该对局 RandomCommit 派生流（偏移 `100000 + 回合×8`，与引擎从 0 递增的顺序游标互不干扰）挑技能，**普通伤害招优先**，当前宝可梦倒地时换上一只存活队友。
- 入场：机器人开局即标记"已到场"（`enterBattle`），玩家的 90 秒入场宽限照常生效。
- **奖励缩减**：**rating 变化 0**（`BOT_RATING_SCALE = 0`，H12）、羁绊 `BOT_REWARD_SCALE = 0.5` **向下取整**（+2→+1、+1→+0）、经验 30→15（幂等键与通用 PvP 胜利经验一致：`<battleId>-exp-<pokemonId>`）。
- **每日上限 5 场**：Redis 计数 `ranked:bot:<player>:<yyyy-mm-dd>`（UTC 日期，TTL 2 天）；开局失败会回滚计数。`arena` 模式不提供机器人。
- 强度提示：种族取自野生池（**含进化型**），只有等级按 ±2 对齐——偶发的强种族（超能系进化型等）会让练习赛明显偏难，这是当前口径的已知特性（离线实测 3 场单只 5 级御三家对局均告负）。

**积分场（stakes arena，`ranked/arena.ts`）**

| 段位 | rating | 准入积分 | 徽章底色 |
|---|---|---|---|
| 青铜 bronze | 0 – 1199 | 20 | `#a9663a` |
| 白银 silver | 1200 – 1399 | 50 | `#b9c2cc` |
| 黄金 gold | 1400 – 1599 | 100 | `#e6c53c` |
| 白金 platinum | 1600 – 1799 | 200 | `#7fd6e8` |
| 大师 master | ≥ 1800 | 400 | `#d05ce3` |

- **扣费时机**：匹配成功且**双方都 accept 时才扣**（各扣自己的准入，reason `arena:entry:<battleId>`，幂等键 `<battleId>-arena-entry-A|B`）；一方拒绝/超时/取消 → 不扣。第一方扣成功、第二方失败时第一方原路退回（reason `arena:entry-refund:<battleId>`），**扣失败即取消建房**（双方 409 `INSUFFICIENT_POINTS` 提示并出队）。
- **结算**（`BattleRewardService`，计划在首次结算时固化进 `ranked:battle:<battleId>.arena`）：
  - 胜者：`双方准入之和`（**不额外增发**），reason `arena:reward:<battleId>`，幂等键 `<battleId>-arena-reward`；
  - 平局：各自退还准入（`arena:refund:<battleId>`）；
  - 仲裁 `REFUNDED`：不发奖，但双方准入原路退回。
- **系统补贴** = 胜者准入额 × `ARENA_SUBSIDY_RATIO`（H12 起为 **0**：积分场零和，胜者只拿双方入场费；跨段位对局按胜者自己的准入额算）。
- **防刷**（判定保留；系数为 0 时无补贴可发，不会产生系统增发。任一命中会记录在 `arena.plan.subsidyBlocked`）：
  1. 每人每天最多 3 次补贴（Redis SET `ranked:subsidy:<player>:<yyyy-mm-dd>` 存 battleId，`SCARD` 即次数——重放同一场不会重复占名额）；
  2. 对局双方 rating 差 > 400（扩圈匹配可能配出大分差对手）；
  3. 机器人场（`bot` 记录存在时）。
- 权重说明：准入积分是链上资产，支出走 `PlayerContract.AddPoints`（负数）；H12 起不再有系统补贴（系数 0）。全部带 reason 与固定幂等键，重试/重放不叠加。

**段位（前端徽章，`frontend/src/api/ranked.ts::RANK_TIERS`）**

段位只由 rating 推导（前后端同一口径），不额外上链；准入积分表同源（`ARENA_ENTRY_FEES`）。

### 11.2 羁绊（`backend/src/ranked/bond.service.ts`）

`Pokemon.bond` 0-255：**陪你成长的记录，换手即清零；涨幅按"月"设计（2026-09 长线化重平衡）**。
2026-09 起羁绊同样是**战斗养成**：非 HP 五项 × `1 + bond/255 × 5%`（满羁绊 +5%、128 约 +2.5%，向下取整，HP 不变）。

**战斗加成（`game-data/stats.ts` 的 `bondMultiplier`，仅战斗内）**

| 项 | 规则 |
|---|---|
| 生效范围 | 最终能力值的**非 HP 五项**（攻击/防御/特攻/特防/速度）；HP 不涨 |
| 公式 | `floor(最终能力值 × (1 + bond/255 × 5%))`，乘在性格修正之后 |
| 生效战斗 | PvP（房间/排位/机器人：`battles.service::loadTeam` 把链上 `bond` 传给 `EngineMonInput`，`BattleManagerService.startBattle` 满血起引擎）与**野怪战斗**（`wild.service::toCombatant` 把 `p.bond` 作为 `computeStats` 的第 6 参传入）|
| 展示 | `GET /pokemon` / `GET /pokemon/:id` 附带 `bondBonus` 百分比；队伍页显示「羁绊加成 +x.x%」 |

| 事件 | 变化 | 实现 |
|---|---|---|
| 铸造（捕捉 / 新手礼包） | = 50 | 链码 `MintFromCapture` |
| PvP 对局结算（含排位与普通押注房） | 赢家参战队伍 **+2**、输家参战队伍 **+1**；平局双方 **+1** | `BondUp`（批量，单次 ≤100 只，服务端按 50 分块） |
| 机器人场结算 | 同上按 **×0.5 向下取整**：赢家 **+1**、输家/平局 **+0** | 同上，`grantPvpBond(input, { scale: 0.5 })` |
| **野怪收服成功** | 出战宝可梦 **+1** | `BondService.grantWildBond`（reason=`bond:wild-catch:<sessionId>`） |
| **击倒野怪** | **+0（不再给羁绊）** | `BOND_WILD_FAINT = 0`，`grantWildBond` 直接返回 null |
| 交易 / 对战押注被赢走 / `Transfer` 易主 | **重置为 30** | 链码内建（DRAW/REFUND/放生不变） |
| **每日每宠上限** | **+6/天**（超出截断，不足 1 点不发） | Redis `bond:day:<pokemonId>:<yyyy-mm-dd>`（哈希：field=各次 `BondUp` 的 idemKey、value=实际发放值；`HSETNX` + TTL 2 天） |
| 上限 | 255 截断 | 链码 `BondUp` |
| **里程碑「灵魂搭档」** | 羁绊 ≥200 时前端展示金色徽章（链上不加字段） | `frontend/src/ui/BondHearts.vue`（`SOULMATE_BOND = 200`） |

**曲线（从 50 到 255）**：需要 205 点；每日全勤上限 6 点 → 理论最快 35 天，实战节奏（排位胜负各半 + 野怪收服 1-2 次/天）
通常 **6 周以上**；灵魂搭档（≥200）至少也要 25 个全勤日。这是"长期陪伴感"的量化口径。

规则细节：

- **陪伴无关胜负**：输家队伍也长羁绊（+1），只有"赢家 +2"区分战果；平局双方 +1。
- **每宠独立记账**：上限按宝可梦算（不是按账号），当日额度按 idemKey 幂等记账——重放同一场战斗既不会重复加分，
  也不会重复占用额度（`dailyUsed` 会把自己那一笔排除后再算余量）。
- **易主的宝可梦不再算参战队伍**：押注输掉的宝可梦链上已重置为 30，结算时跳过（不以"输家羁绊"再加一次）；`RELEASED` 的宝可梦同样跳过。
- **幂等**：`BondUp` 的 idemKey 由 battleId / sessionId 推导（见 §11.3），重复广播/兜底重试不会重复加分。

### 11.3 链上留痕与触发时机

| 场景 | 交易 | reason | idemKey |
|---|---|---|---|
| 排位结算（双方） | `PlayerContract.UpdateRating` | `ranked:<battleId>` | `<battleId>-rating-A` / `-B` |
| PvP 结算（赢家队） | `PokemonContract.BondUp` | `bond:pvp:<battleId>` | `<battleId>-bond-win`（分块 `-0/-1…`） |
| PvP 结算（输家队） | `PokemonContract.BondUp` | `bond:pvp:<battleId>` | `<battleId>-bond-lose` |
| PvP 平局（双方） | `PokemonContract.BondUp` | `bond:pvp:<battleId>` | `<battleId>-bond-draw-a` / `-draw-b` |
| 机器人场经验（胜者队） | `PokemonContract.ApplyGrowth` | —（走 `applyExp`） | `<battleId>-exp-<pokemonId>`（+15，与通用 PvP 胜利经验同键） |
| 积分场准入（双方） | `PlayerContract.AddPoints`（负数） | `arena:entry:<battleId>` | `<battleId>-arena-entry-A` / `-B` |
| 积分场发奖（胜者） | `PlayerContract.AddPoints` | `arena:reward:<battleId>` | `<battleId>-arena-reward` |
| 积分场平局退还（双方） | `PlayerContract.AddPoints` | `arena:refund:<battleId>` | `<battleId>-arena-refund-A` / `-B` |
| 积分场取消/仲裁退款（双方） | `PlayerContract.AddPoints` | `arena:entry-refund:<battleId>` | `<battleId>-arena-entry-refund-A` / `-B` |

**触发时机（`BattleRewardService`）**：`BattlesService` 在**任意 settle 路径**（引擎终局、`Forfeit`、双方 `ConfirmResult`、仲裁）向内部 `settled` 通道广播 `{battleId, roomId, playerA/B, teamA/B}`；挂钩服务登记待办（Redis `rewards:pending:*`）后立刻应用。广播时链上可能还是 `RESULT_SUBMITTED`（等确认或 2 分钟兜底），此时**只登记不发奖**，由每 30 秒的 sweep 在链上 `SETTLED` 后补应用（服务重启/兜底结算都不漏）。`REFUNDED`（仲裁退款）不发奖并出列；服务重启对账以 `DRAW` 结案的对局按平局（S=0.5）结算，两侧都是幂等键，失败重试安全（实测：一局只确认了一次的对局被 2 分钟兜底结算后，sweep 补齐了 rating 与羁绊）。

### 11.4 前端展示

- `frontend/src/views/RankedView.vue`（`/ranked`，导航"排位赛"）：段位卡（徽章 + rating + 名次 + 段位进度条 + 战绩）、匹配面板（出战队伍勾选、**休闲/积分场模式切换 + 准入额提示**、排队动画/取消 + 当前窗口与等待秒数、**15 秒接受期接受/拒绝**、**60 秒后的机器人选项**、匹配成功自动进战斗）、排行榜（前 50，自己高亮）、规则说明（ELO/匹配/接受期/排位房/羁绊/链上留痕）、**"帮助"按钮弹出规则面板**（段位表 + 准入额、ELO 简述、扩圈与接受期、机器人减半与每日 5 场、补贴与防刷；文案键 `ranked.help.*`，中英双语）。**队伍勾选处濒死者灰显禁选**（徽章"濒死" + 提示去宝可梦中心），入队返回 409 `FAINTED` 时显示同一条中文提示并剔除濒死成员；**勾选上限 6 只**（`components/team-picker.ts`，第 7 只提示 `ranked.teamMax`）。**15 秒接受/拒绝卡片里展示对手出战队伍**（`components/OpponentTeamList.vue`：昵称/等级/闪光/最终能力值 + 一行"个体值/努力值/性格不可见"的裁剪说明），拒绝前就能看到阵容。
- `frontend/src/components/WagerPicker.vue`（大厅创建/加入房间的押注与队伍选择，LobbyView 复用）：濒死宝可梦整行灰显、出战/押注勾选框禁用并标注"濒死"，列表下方提示"先去宝可梦中心恢复（每次 10P）或使用伤药"；模板载入时濒死成员按"不在背包"剔除（`clampWagerToInventory`）；**出战队伍上限 6 只**（显示"出战 n/6"，满员后未勾选项禁用，第 7 只给出红字提示）。
- `frontend/src/views/LobbyView.vue`：房间卡片 / 加入面板 / 确认押注面板都有 **"查看押注"** 与 **"查看队伍"** 两个弹窗入口（`WagerInspectDialog` / `TeamInspectDialog`——旁观者也能看双方出战阵容）；房主自己的空房间卡片上有 **"删除房间"**（二次确认，调 `DELETE /battles/rooms/:id`；409 `ROOM_NOT_EMPTY` 时提示先"请离"）。
- `frontend/src/views/BattleView.vue` 结算面板：SETTLED 后拉取 `GET /ranked/battles/:id/outcome` 显示 **排位分 before→after（±N）** 与 **每只宝可梦羁绊 before→after + 爱心（±N）**；有押注宝可梦时提示"本局押注的宝可梦易主后，羁绊将重置为 30"。机器人场/积分场的 `bot` / `arena` 字段已随 outcome 返回（面板展示待后续迭代）。对战界面下方是**实时战斗日志面板**：消费 `battle:state.state.log`（`frontend/src/game/battle-log.ts` 渲染中文行，名称走 `useI18n`），每个已结算回合一组「— 第 N 回合 —」+ 事件行，新回合到达自动滚到底部；我方/对方/换宠按钮都带 `HpBar`（PvP 满血出战，链下伤势只影响野怪战斗）。
- `frontend/src/ui/BondHearts.vue`（共用组件）：`{bond, max=255, hearts=5, size, showValue, delta}` → 5 颗爱心按比例点亮 + 数值/变化量；**羁绊 ≥200 自动显示"灵魂搭档"金色徽章**（`SOULMATE_BOND`，纯前端），队伍页与图鉴之外的所有羁绊展示位复用同一组件。
- `frontend/src/views/TeamView.vue`：每只宝可梦卡片与详情都有 **HP 条（当前/最大）+ 濒死标红**，顶部有**宝可梦中心按钮**（显示受伤数量与 10P 单价，调用 `POST /pokemon/center/heal`）；详情里羁绊一行显示 **「羁绊加成 +x.x%」**（`bondBonus`，非 HP 五项，满羁绊 +5%）；放生对话框提示"可得 等级×1 积分"。
- `frontend/src/components/CaptureOverlay.vue`：准备阶段的首发列表带 HP 与（濒死）标记、**濒死成员禁选**；全队濒死时禁用"进入草丛"并提示去宝可梦中心；背包伤药可在战斗中/队伍页使用（`POST /items/:id/use {targetPokemonId}`）。
- 交易所（TradeView）建议提示同一条"易主后羁绊重置为 30"（本次未改该文件）。

**遗留**：`Transfer` 与交易确认处的羁绊重置目前只有链上行为 + 文档说明，交易界面尚未加仪式感提示；排位结算面板尚未渲染 `arena` 发奖明细（接口已返回）。
