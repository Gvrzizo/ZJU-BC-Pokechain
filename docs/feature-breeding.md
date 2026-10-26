# 功能实现：血统繁殖

> 配套：`docs/feature-overview-history-breeding.md`（总览与卸载）、`docs/randomness.md`（派生流）、`docs/chaincode-api.md`（契约风格）
> 实现位置：`chaincode/pokemon-cc/src/contracts/breeding.contract.ts`、`backend/src/breeding/`、`frontend/src/views/BreedingView.vue`
> 解耦约定：**不改现有合约、不加状态、不加索引、不加背书策略**；只复用现有 helper 和现有随机事件类型。
>
> **状态：未实现。** 本文已按评审意见修正三处设计：血统承诺的语义、遗传结果由链码重算验证、遗传概率口径。

## 1. 玩法规则

两只宝可梦生一只子代。数值集中在新合约顶部：

| 项 | 值 | 说明 |
|---|---|---|
| `MIN_BREED_LEVEL` | 20 | 双亲等级下限 |
| `BREED_COST` | 200 | 每次消耗积分，从请求者余额扣（初始积分 400P，300 过重） |
| 双亲要求 | 同一 owner、均 `IDLE`、`parentA != parentB` | 借用现有状态机，不新增状态 |
| 子代物种 | 取母本（`parentB`） | 简化，不引入性别与蛋招式 |
| 子代等级 | 1，`exp=0`，`evs` 全 0 | 与 `MintFromCapture` 一致 |
| 子代羁绊 | `BOND_DEFAULT = 50` | 新资产语义，不走"易主重置 30" |
| 子代归属 | 请求者 | `assertCallerIsPlayer` 校验证书 `hf.EnrollmentID === ownerId`（与 Transfer 一致） |
| 冷却 | v1 不做 | 见 §9 |

**双亲不会被消耗、不进入锁定态。** 并发保护来自"扣积分要写同一个玩家键"（见 §9），不是来自锁双亲。

## 2. 遗传规则

复用现有随机事件类型 `purpose='mint'`（`RandomContract` 已允许，不改 `random.contract.ts`），派生流新增一个区段：

| n | 用途 | 计算 |
|---|---|---|
| `50000 + i*2`（i=0..5） | 第 i 项 IV 的来源 | `<0.4` 取父本；`<0.8` 取母本；否则走下一槽随机 |
| `50000 + i*2 + 1` | 第 i 项 IV 的随机值 | `floor(rand * 32)` → 0..31 |
| `50012` | 性格 | `<0.5` 取父本，否则母本 |
| `50013` | 闪光 | `< 1/4096` |
| `50014..50019` | 预留 | 不与既有区段冲突 |

IV 顺序：`hp / atk / def / spatk / spdef / speed`。

### 概率口径（之前文档写错了，以此为准）

| 结果 | 概率 |
|---|---|
| 继承父本该项 IV | 40% |
| 继承母本该项 IV | 40% |
| 该 IV 由随机生成 | 20% |

即**单项 IV 有 80% 来自双亲**。若要改成 60% 继承，把阈值改为 `0.3 / 0.6`。任何调整都必须先改这份表、再改链码、Mock 与黄金向量。

### 2.1 血统承诺（直接写进子代的 `dnaHash`）

```text
dnaHash = SHA256(
  "pokechain-breed-v1" ||
  parentAId || parentA.dnaHash ||
  parentBId || parentB.dnaHash ||
  eventId   || childId
)
```

**不加新字段**：子代沿用现有的 `dnaHash`，只是语义变成"血统承诺"。这样模型只增加 `parents`/`generation` 两个可选字段，卸载时不残留第三个字段。

比"只哈希两条 dnaHash"多绑定了**亲代身份**与**子代身份**，因此不能拿另一对亲代的哈希来冒充。

边界：它只证明"这只子代由这两只亲代、在这个事件下产生"，不证明 IV 遗传正确——后者由 2.2 的链码重算负责。

### 2.2 遗传结果由链码重算验证（关键修正）

链码在 `Breed` 里**自己按同一公式算一遍子代属性**，再与传入值逐项比对。`.revealAndVerify` 之后 `rand` 记录里已经有 `serverSeed`，`common/crypto.ts` 里也已有 `deriveRandom(seed, clientSeed, eventId, n)`，所以这不增加任何新机制：

```ts
const rand = await loadRand(ctx, eventId);            // 状态 REVEALED，serverSeed 已落盘
const r = (n: number) => deriveRandom(rand.serverSeed, rand.clientSeed, rand.eventId, n);

const expected = deriveChildFromStream(r, parentA, parentB, species);
if (canonicalJson(expected.ivs) !== canonicalJson(ivs)) fail('HEREDITY_MISMATCH', ...);
if (expected.nature !== nature) fail('HEREDITY_MISMATCH', ...);
if (expected.shiny !== shiny) fail('HEREDITY_MISMATCH', ...);
```

这样"后端随便填个 31"会被链码直接拒绝。**链码从"只校验字段范围"升级为"校验派生结果"**，这是繁殖与捕捉在设计上的区别：捕捉只做范围校验，繁殖把派生算法也搬进链码。

`ability`、`name`、`moves`、`speciesId` 仍由后端给（属于查表/文案范畴），链码只校验非空与长度。

### 2.3 链码仍然证明不了什么

| 目标 | 现状 |
|---|---|
| 子代属性符合遗传规则 | ✅ 链码重算验证 |
| 子代确由这两只亲代产生 | ✅ lineageHash + 亲代存在性校验 |
| 随机事件只用一次 | ✅ `consumeRandom` |
| 后端没有在 Commit 之前挑种子 | ❌ 做不到（与捕捉相同的局限） |
| 后端没有因结果不满意而放弃某次请求 | ❌ 做不到（"拒绝揭示"是承诺-揭示的固有限制） |

最后两条写在 `docs/randomness.md` §7，繁殖不改变这个结论。要根治只能引入后端不可预控的熵源（drand / VRF / 双方掷币），属于升级路线。

## 3. 链码：`breeding.contract.ts`

### 3.1 交易表

| 交易 | 参数 | 规则 | 事件 |
|---|---|---|---|
| `Breed` | `childId, parentAId, parentBId, speciesId, name, ivsJSON, nature, ability, shiny, movesJSON, eventId, nowISO, idemKey` | 请求者=双亲 owner（或 `system`）；双亲存在、同 owner、`IDLE`、非同一只、`level>=20`；子代 id 不存在；`consumeRandom(eventId,'mint',ownerId)`；`dnaHash`（血统承诺）重算比对；**按派生流重算子代 IV/性格/闪光并比对**；扣 `BREED_COST`（不足 `INSUFFICIENT_POINTS`）；写子代（`parents`、`generation`、`bond=50`、`status=IDLE`） | `PokemonBred` |
| `GetLineage` | `pokemonId` | 只读；返回 `{id, parents, generation, lineageHash?, parentA?, parentB?}`（父代摘要） | 无 |
| `GetBreedingConfig` | — | 只读；`{minLevel, cost, layout:{...}}`，供前端展示规则 | 无 |

错误码：`NOT_OWNER`、`POKEMON_NOT_FOUND`、`POKEMON_EXISTS`、`ASSET_LOCKED`、`INVALID_PARAM`（同一只/等级/参数越界）、`LINEAGE_MISMATCH`、`HEREDITY_MISMATCH`、`INSUFFICIENT_POINTS`、`RAND_NOT_REVEALED` / `RAND_CONSUMED`。

### 3.2 骨架

```ts
@Transaction()
public async Breed(ctx, childId, parentAId, parentBId, ..., idemKey) {
  return withIdempotency(ctx, idemKey, nowISO, async () => {
    // 1) 读双亲：归属/状态/等级/同一只
    // 2) assertCallerIsPlayer(ctx, owner) 或 requireRole(ctx,'system')
    // 3) exists('pokemon', childId) → POKEMON_EXISTS
    // 4) consumeRandom(ctx, eventId, 'mint', ownerId)
    // 5) dnaHash（血统承诺）重算比对 → LINEAGE_MISMATCH
    // 6) 从 rand.serverSeed 重算子代属性比对 → HEREDITY_MISMATCH
    // 7) loadPlayer → debitPoints → savePlayer
    // 8) savePokemon(child)；emit('PokemonBred', {...})
  });
}
```

复用而不新增：`withIdempotency`、`loadPokemon`、`savePokemon`、`loadPlayer`、`savePlayer`、`debitPoints`、`consumeRandom`、`loadRand`、`assertCallerIsPlayer`、`deriveRandom`、`canonicalJson`、`sha256hex`、`emit`。

**不新增**：状态枚举、`lockRef` 用法、CouchDB 索引、通道配置、背书策略。

### 3.3 数据模型增量（`common/model.ts`）

```ts
export interface Pokemon {
  // ...现有字段不动
  /** [FEAT:breeding] 双亲 id；仅繁殖产生的子代有该字段，旧记录缺省。 */
  parents?: string[];
  /** [FEAT:breeding] 代数：野生/铸造为 0 或缺省，子代为 max(父,母)+1。 */
  generation?: number;
  /** 繁殖子代的 dnaHash 即血统承诺（见 2.1），不额外增加字段。 */
}
```

兼容策略与现有 `bond`/`evs`/`rating` 相同：缺失按默认值处理，不做数据迁移。

## 4. 后端

### 4.1 一次繁殖的时序

```
浏览器 POST /breeding/breed {parentAId, parentBId}
   │
后端：预校验归属/等级/IDLE（提前失败，省一次上链）
后端：eventId = ev_breed_<uuid>；serverSeed = randomBytes(32)
后端 → 链：Commit(eventId, purpose='mint', playerId=owner, commitHash, clientSeed)
后端 → 链：RevealAndVerify(eventId, serverSeed)          ← system
后端：DeriveStream 读 50000 区，算出子代 IV/性格/闪光
后端 → 链：Breed(..., eventId)                           ← 玩家签名，扣积分
         链码重算 lineageHash 与遗传属性，逐项比对
   │
返回子代状态
```

**为什么揭示必须在繁殖之前**：`consumeRandom` 要求 `REVEALED`。

**这一步的公平性边界（必须如实说明）**：后端在 Commit 之前就持有 serverSeed，因此理论上可以反复生成种子直到满意再提交（也可以放弃请求）。链码能做的是"提交后不能换、不能编造属性"；做不到"提交前没挑过"。这与现有捕捉流程同源，见 `randomness.md` §7。

### 4.2 新增文件

```
backend/src/breeding/
├── breeding.module.ts
├── breeding.controller.ts     @Controller('breeding')
├── breeding.service.ts        编排：校验 → Commit → Reveal → 派生 → Breed
├── breeding-derive.ts         纯函数：从派生流生成子代字段（与链码同一公式）
└── breeding.constants.ts      MIN_LEVEL / COST / 槽位偏移
```

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/breeding/config` | 链上 `GetBreedingConfig` 透传 |
| POST | `/api/v1/breeding/breed` | body `{parentAId, parentBId}`，返回子代 |
| GET | `/api/v1/breeding/lineage/:id` | 链上 `GetLineage` 透传 |

### 4.3 适配器新增（`[FEAT:breeding]` 区块，3 个方法）

```ts
abstract breed(as: ChainIdentity, args: BreedArgs & TxMeta): Promise<PokemonState>;
abstract getLineage(id: string): Promise<LineageState>;
abstract getBreedingConfig(): Promise<BreedingConfigState>;
```

- `FabricChainAdapter`：`submitTransaction('BreedingContract:Breed', ...)`；另外两个 `evaluateTransaction`。
- `MockChainAdapter`：同名方法，规则与链码逐条对齐（包括按派生流重算属性）。
- `chain.types.ts`：`PokemonState` 加三个可选字段；新增 `LineageState`、`BreedingConfigState`。

### 4.4 派生实现

```ts
export function deriveChild(stream: DeriveStream, parentA: PokemonState, parentB: PokemonState) {
  const ivs = {} as PokemonIvs;
  IV_KEYS.forEach((key, i) => {
    const choice = stream.at(50000 + i * 2);
    ivs[key] = choice < 0.4 ? parentA.ivs[key]
             : choice < 0.8 ? parentB.ivs[key]
             : Math.floor(stream.at(50000 + i * 2 + 1) * 32);
  });
  return {
    ivs,
    nature: stream.at(50012) < 0.5 ? parentA.nature : parentB.nature,
    shiny: stream.at(50013) < 1 / 4096,
  };
}
```

`DeriveStream` 已有 `at(n)`（绝对下标），繁殖直接读 50000 区，不影响捕捉的 `next()` 游标。

**同一份公式要在三处一致**：链码 `breeding.contract.ts`、后端 `breeding-derive.ts`、`MockChainAdapter`。用黄金向量锁定，不要各写各的。

## 5. 前端

- 路由 `/breed`，导航"培育屋"。
- 选两只 → 显示等级、IV 摘要、费用 → 确认 → 子代卡片（与双亲 IV 对比）。
- 子代卡片显示 `generation` 与双亲链接，并链接到履历抽屉。
- 错误码直接透传：`NOT_OWNER` / `ASSET_LOCKED` / `INSUFFICIENT_POINTS` / `HEREDITY_MISMATCH`。

## 6. Mock 与对拍

| 文件 | 场景 | 期望 |
|---|---|---|
| `breeding_ok.json` | 正常繁殖 | 子代字段、扣分、事件、`parents`、`generation`、`dnaHash` |
| `breeding_same_parent.json` | A == B | `INVALID_PARAM` |
| `breeding_low_level.json` | 等级 19 | `INVALID_PARAM` |
| `breeding_not_owner.json` | 非 owner 调用 | `NOT_OWNER` |
| `breeding_locked_parent.json` | 双亲在交易中 | `ASSET_LOCKED` |
| `breeding_lineage_mismatch.json` | 篡改 dnaHash | `LINEAGE_MISMATCH` |
| `breeding_heredity_mismatch.json` | 篡改 IV/性格/闪光 | `HEREDITY_MISMATCH` |
| `breeding_idempotent.json` | 同 idemKey 重放 | 同一子代，不重复扣分 |
| `breeding_insufficient_points.json` | 余额不足 | `INSUFFICIENT_POINTS` |

**黄金向量**：固定一组 `(serverSeed, clientSeed, eventId, 父母 IV)`，断言派生出的六项 IV / 性格 / 闪光，防止三处实现漂移。

**v1 对拍策略**：`test-vectors/chain/*.json` 的 runner 目前按 op 名分发（`mintPokemon`/`createBattle`…），新增 `breed` op 要同时改 `chaincode/pokemon-cc/tests/vectors.test.ts` 与 `backend/test/chain-vectors.spec.ts`。v1 先用**两侧各自的单测 + 同一份黄金向量常量**保证一致，向量文件留作后续（已在 §7 标注）。

已写入账本的子代保留 `parents`/`generation`；`dnaHash` 本来就是既有字段，不需要迁移。

## 7. 测试清单

| 层 | 用例 |
|---|---|
| 链码 `tests/breeding.test.ts` | 上述 9 条 + `GetLineage` 两代 + `GetBreedingConfig` + 子代 `bond=50/evs=0/IDLE` |
| 链码 `tests/vectors.test.ts` | 自动纳入新向量文件 |
| 后端 `test/breeding.spec.ts` | 编排顺序、派生黄金向量、预校验失败、错误码映射 |
| 前端 | 选双亲、费用、错误提示、结果卡片 |
| 回归 | 三端全绿后更新 `AGENTS.md` 计数 |

## 8. 解耦与卸载

```bash
rm chaincode/pokemon-cc/src/contracts/breeding.contract.ts
rm -rf backend/src/breeding
rm backend/test/breeding.spec.ts chaincode/pokemon-cc/tests/breeding.test.ts
rm test-vectors/chain/breeding_*.json
rm frontend/src/views/BreedingView.vue
grep -rn "\[FEAT:breeding\]" --include=*.ts --include=*.vue .
# 按标记删：合约注册、模型字段、抽象方法、两处适配器实现、模块注册、路由、页面入口
```

删完必须跑：`npm run build`（后端）、三端测试、Mock 回归。

已写入账本的子代不会消失：`parents`/`generation` 都是可选字段，旧代码忽略即可；重新启用功能时读到这些遗留记录也没问题。

## 9. 风险与边界

| 风险 | 说明 | 处理 |
|---|---|---|
| 后端提交前挑种子 | 承诺-揭示无法阻止运营方预生成 | 如实写入文档；升级路线见 `randomness.md` §8 |
| 后端拒绝揭示 | 可放弃某次繁殖 | 与捕捉同源；COMMITTED 记录永久留痕 |
| 子代通胀 | 双亲可反复繁殖 | v1 用 200P 费用；可选"每只每日 1 次"（Redis，链下） |
| 血统滚雪球 | 高 IV 双亲长期收敛到满 IV | 80% 继承 + 20% 随机；课程范围内可接受 |
| **并发保护的真实来源** | 两笔繁殖都只读双亲、不写双亲，**双亲之间不会冲突**；真正让第二笔失败的是"扣同一个玩家积分"造成的 `player` 键写冲突 | 若将来把 `BREED_COST` 改成 0，并发保护会消失，必须另加约束（链上冷却计数或双亲锁定） |
| 与既有语义冲突 | "易主重置 bond=30" 不适用于新铸造 | 子代按 `BOND_DEFAULT=50`，与捕捉一致 |
| 随机槽位 | 50000 区与 capture（0/20000/30000/40000）不重叠 | 新增功能从 50020 起 |
| 经济文档 | 新增积分消耗点 | 保留功能时同步 `docs/backend-api.md` §10 的 sink 列表 |
