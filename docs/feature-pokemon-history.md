# 功能实现：宝可梦履历（链上历史查询）

> 配套：`docs/feature-overview-history-breeding.md`（总览与卸载）、`docs/chaincode-api.md`（链码契约风格）
> 实现位置：`chaincode/pokemon-cc/src/contracts/history.contract.ts`、`backend/src/history/`、`frontend/src/components/PokemonHistory.vue`（前端待做）
> 解耦约定：**不改现有链码合约的既有逻辑**；接入点会在少量现有文件里留下 `[FEAT:history]` 标记的改动（见 §7）。
>
> **当前进度**：链码 + 后端已实现并通过测试（链码 6 用例、后端 10 用例；全量：链码 123 / 后端 461 全绿），**并已在真实 Fabric 2.5.16 网络上验证**（部署 1.2/sequence 3）：历史库可用、返回顺序为新→旧、时间戳解析正常。前端组件与挂载点未做。

## 1. 功能定义

每只宝可梦展示一页档案：

| 内容 | 来源 |
|---|---|
| 初训家（第一次归谁） | **完整历史**的第一条记录 |
| 转手次数 | **完整历史**里 `ownerId` 变化次数 |
| 版本数 | 完整历史条数 |
| 时间线 | 最近 N 条记录，相邻版本比对得出发生了什么 |
| 改名 / 进化 / 等级 / 羁绊 / 放生 | 相邻版本字段变化 |

**不是目标**：回放每一场战斗、展示 IV/EV 明细。前者在链下 `battle_logs`，后者属于详情接口，避免履历成为绕过详情权限的后门。

## 2. 数据来源：账本历史

`pokemon:<id>` 每次被 `Transfer` / `ApplyGrowth` / `BondUp` / `Release` / 结算改写，账本都会留下一个版本。Fabric 提供 `stub.getHistoryForKey(key)` 读取这些版本。

关键约束（必须遵守，否则背书会失败）：

- `getHistoryForKey` 的结果在**不同 peer 上可能不同**（历史按本地区块计算），因此**只能放在查询交易里**（`@Transaction(false)`），绝不能出现在需要背书的写交易中。
- 需要 peer 启用历史库：`CORE_LEDGER_HISTORY_ENABLEHISTORYDATABASE=true`（Fabric 默认开启，本项目在 `network/docker-compose.yaml` 里显式声明）。**未启用时该查询不可用**。
- 返回条目结构：`{ txId, timestamp, isDelete, value }`，`value` 是当时的完整状态字节；`isDelete` 表示该键被删除（本项目资产不删除，仅作兼容）。
- 时间戳是**区块时间**，不是业务时间。业务时间用状态里的 `createdAt` / 结算时的 `settledAt`。

### 摘要与明细必须分开算

这是容易出错的地方：

```
完整历史 300 条，接口只返回最近 100 条
  → 若用这 100 条算"初训家"，得到的是"这 100 条里最早那个持有人"，不是初训家
  → 若用这 100 条算"转手次数"，早期转手全部丢失
```

因此链码在**遍历完整历史时**就把摘要算好，只把最新 N 条明细返回：

```json
{
  "summary": { "firstOwner": "u_ash", "currentOwner": "u_gary", "transfers": 7, "versions": 300, "truncated": true },
  "entries": [ /* 最新 N 条，最新在前 */ ]
}
```

`truncated` 告诉前端"时间线不完整"，但**摘要永远准确**。

### 被否掉的替代方案

| 方案 | 为什么不用 |
|---|---|
| 后端订阅链事件，把历史重建到 PostgreSQL | 历史依赖后端重建，丢事件就有缺口；可作为后续查询优化层，但不能替代账本查询 |
| 在 `pokemon` 文档里维护 `history[]` 数组 | 每笔交易都要读写整个数组，账本膨胀，且与状态机耦合 |

## 3. 链码：`history.contract.ts`

### 3.1 交易表

| 交易 | 参数 | 规则 | 事件 |
|---|---|---|---|
| `GetPokemonHistory` | `pokemonId`, `maxEntries?`（默认 200，上限 500） | 只读；无任何历史 → `POKEMON_NOT_FOUND`；**summary 在完整历史上统计**；`entries` 取最新 `maxEntries` 条并倒序；`maxEntries` 非正整数 → `INVALID_PARAM` | 无 |

单条 `entries` 元素（已裁剪，不返回 IV/EV/技能）：

```json
{ "txId": "…", "at": "2026-10-26T…Z", "ownerId": "u_ash", "name": "皮卡丘", "level": 5, "speciesId": 25, "bond": 50, "status": "IDLE" }
```

### 3.2 骨架

```ts
@Transaction(false)
public async GetPokemonHistory(ctx, pokemonId, maxEntries?) {
  // 1) 遍历 iterator，逐条投影成摘要（旧 → 新，见下方"顺序假定"）
  // 2) 在完整数组上算 summary：firstOwner / currentOwner / transfers / versions / truncated
  // 3) entries = all.slice(-max).reverse()
  // 4) 必须 await iterator.close()
}
```

**顺序处理（实测修正）**：不同 peer 版本的 `getHistoryForKey` 返回方向不一致——本项目 Fabric 2.5.16 实测为**新 → 旧**，而 Mock harness 是旧 → 新。因此链码不假定方向，而是用首尾时间戳归一化：

```ts
const ordered = all.length < 2 || all[0].at >= all[all.length - 1].at ? all : [...all].reverse();
summary.firstOwner  = ordered[ordered.length - 1].ownerId;  // 最早
summary.currentOwner = ordered[0].ownerId;                  // 最新
entries = ordered.slice(0, max);                            // 已是新 → 旧
```

参数注意：`fabric-contract-api` 按参数个数校验，`maxEntries` 虽是 TS 可选参数，**实际必须传**（peer CLI 也要写全两个参数）。

### 3.3 时间戳转换

`timestamp.seconds` 可能是 protobuf Long（带 `toString()`）或 number，`nanos` 同理：

```ts
const seconds = Number(ts.seconds?.toString?.() ?? ts.seconds ?? 0);
const nanos = Number(ts.nanos?.toString?.() ?? ts.nanos ?? 0);
new Date(seconds * 1000 + Math.floor(nanos / 1e6)).toISOString();
```

## 4. 后端

### 4.1 适配器新增（`[FEAT:history]` 区块）

```ts
// backend/src/fabric/chain.adapter.ts
abstract getPokemonHistory(id: string, maxEntries?: number): Promise<ChainHistoryResult>;
```

`chain.types.ts` 增加 `ChainHistoryEntry`、`ChainHistorySummary`、`ChainHistoryResult`。

- `FabricChainAdapter`：`contract.evaluateTransaction('HistoryContract:GetPokemonHistory', id, String(max))`，**必须 evaluate，不能 submit**。
- `MockChainAdapter`：按同样的摘要规则读本进程记录的历史。

### 4.2 Mock 模式的历史记录

Mock 没有账本，必须自己记，否则演示模式下列表为空。改动集中在三处，全部带标记：

| 位置 | 改动 |
|---|---|
| `mock-chain.adapter.ts` 的 `private put(key, value)` | 追加一行：写入本事务的历史记录 |
| `loadRemote()` / `flushRemote()` | 历史随事务一起加载/提交；**失败事务不 flush，等于回滚** |
| `mock-chain.store.ts` | `MockChainSnapshot` / `MockChainDelta` 增加 history；Redis 键 `mockchain:hist`；`clear()` 一并清理 |

### 4.3 模块结构

```
backend/src/history/
├── history.module.ts
├── history.controller.ts     @Controller('pokemon')  →  @Get(':id/history')
└── history.service.ts        调适配器 + 投影
```

独立 controller 挂同一个 `pokemon` 前缀，不改现有 `pokemon.controller.ts`。

REST：

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/api/v1/pokemon/:id/history?max=100` | `{pokemonId, firstOwner, currentOwner, transfers, versions, truncated, entries}` |

`max` 非法（<1 或 >500）→ 400 `INVALID_PARAM`。

### 4.4 投影

- `firstOwner` / `currentOwner` / `transfers` / `versions` / `truncated` **直接取 summary**，不再自己数。
- 时间线只基于返回的 `entries` 相邻比对：

```
ownerId 变化   → transfer（放生也算一次变化）
name 变化      → rename
speciesId 变化 → evolve
level 变大     → level
bond 变化      → bond
status=RELEASED → release
```

- 窗口被截断时，第一条只作为差异基线，**不伪造"收服"事件**。

只输出归属与等级，不输出 IV/EV/技能/性格。

## 5. 前端

- 组件 `frontend/src/components/PokemonHistory.vue`：抽屉，时间线样式。
- 挂载点：宝可梦详情页一个"履历"按钮（只加 import + 标签）。
- `truncated=true` 时在时间线末尾显示"更早的记录未显示（共 N 条）"。
- 空态：`暂无历史（旧数据或演示模式未记录）`。

## 6. 测试

| 层 | 用例 | 状态 |
|---|---|---|
| 链码 `tests/history.test.ts` | 无历史、单条、多条倒序、**截断不影响 summary**、非法 max、放生、成长 | 6/6 通过 |
| harness 扩展 | stub 增加 `getHistoryForKey`（按提交顺序记录版本） | 完成 |
| 后端 `test/history.spec.ts` | 投影分类、截断窗口不伪造收服、Mock 查询与截断 | 9/9 通过 |
| 真实 Fabric 集成 | 见 §8（未做） | 待做 |
| 对拍向量 | 不需要（只读、无写入语义） | — |

## 7. 解耦与卸载

真实改动面（比"删文件"多，但都属于接入点）：

| 文件 | 改动 |
|---|---|
| `chaincode/.../src/index.ts` | 注册合约 |
| `chaincode/.../tests/helpers/harness.ts` | stub 增加 `getHistoryForKey` |
| `backend/.../chain.adapter.ts` | 抽象方法 |
| `backend/.../chain.types.ts` | 3 个类型 |
| `backend/.../fabric-chain.adapter.ts` | 4 行实现 |
| `backend/.../mock-chain.adapter.ts` | 历史记录 + 查询 |
| `backend/.../mock-chain.store.ts` | history 通道 |
| `backend/.../app.module.ts` | 模块注册 |
| `network/docker-compose.yaml` | 显式开启历史库（2 行） |
| `backend/test/mock-chain-sharing.spec.ts` | 两个守卫断言 |

卸载步骤（删完要跑编译 + 三端测试）：

```bash
rm chaincode/pokemon-cc/src/contracts/history.contract.ts
rm -rf backend/src/history
rm backend/test/history.spec.ts chaincode/pokemon-cc/tests/history.test.ts
grep -rn "\[FEAT:history\]" --include=*.ts --include=*.vue --include=*.yaml .
# 按标记删掉注册行、抽象方法、适配器实现、模块注册、守卫断言
```

账本里已有的历史不会因为删合约而消失；重新启用时可直接读到旧记录（这也是本功能的一个优点）。

## 8. 部署前检查（真实 Fabric，未在本机验证）

| # | 检查项 | 怎么查 |
|---|---|---|
| 1 | peer 历史库已启用 | `docker exec peer0.org1.pokechain.com env \| grep HISTORY`，或看 `core.yaml` 的 `ledger.history.enableHistoryDatabase` |
| 2 | 历史迭代器顺序 | ✅ 已实测：2.5.16 返回**新 → 旧**；链码已按时间戳归一化，不依赖方向 |
| 3 | `timestamp.seconds` 的类型 | ✅ 已实测：解析正常，`at` 为当前区块时间 |
| 4 | 删除/不存在键的行为 | 放生（不删键）与查不存在 id 两种情况各试一次 |
| 5 | 早期数据是否有历史 | 功能上线前的写入同样在账本里，但前提是历史库从建链起就开着 |

建议做法：在 `scripts/real-chain-smoke.sh` 里加一段"更新一次 → 查历史 → 断言条数与顺序"，作为真链回归。

## 9. 边界与风险

| 项 | 说明 |
|---|---|
| 历史长度 | 单只宝可梦写入次数有限；链码侧上限 500 条明细，摘要不受影响 |
| 截断 | 时间线可能不完整（`truncated=true`），但初训家/转手次数始终准确 |
| 早期数据 | 只要历史库一直开启，上线前的写入也在；**不是无条件保证**，见 §8 第 5 项 |
| 隐私 | 只暴露归属与等级，不暴露个体值 |
| 性能 | 单键历史查询，代价随版本数增长；无富查询、无索引，不影响既有查询 |
| 真链差异 | Mock 的时间戳是服务器时间（`new Date()`），真链是区块时间；排序假定需实测 |
