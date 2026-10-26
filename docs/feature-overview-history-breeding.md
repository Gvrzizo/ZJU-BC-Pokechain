# 新功能概述：宝可梦履历 + 血统繁殖

> 本文是两个功能的**总览与解耦约定**。完整实现见 `docs/feature-pokemon-history.md` 与 `docs/feature-breeding.md`。
> 设计目标：**只新增文件、不改现有业务逻辑**，任何一项不想要时可以按 §4 的清单整块删除。

## 1. 两个功能做什么

| 功能 | 一句话 | 用到的链能力 | 为什么普通数据库不行 |
|---|---|---|---|
| **宝可梦履历** | 每只宝可梦一页档案：初训家、转手次数、进化与羁绊变化时间线 | 账本历史（`getHistoryForKey`） | 履历由每次交易自动累积在账本里，运营方改不了 |
| **血统繁殖** | 两只宝可梦生一只子代，子代记录双亲，IV 部分继承 | 确定性派生 + 不可伪造的亲代记录 | 亲代关系与遗传结果都可被第三方复算，无法事后编造 |

## 2. 解耦原则

三条硬约定，贯穿两份实现文档：

1. **不改现有链码合约的既有逻辑**。履历是新合约；繁殖也是新合约。接入残留只有 `src/index.ts` 的注册行——但"新增合约"不等于"零改动"，适配器、类型、模块注册仍需少量变更，见 §3。
2. **不改现有数据模型**。`Pokemon` 接口只增加**可选**字段（`parents?` / `generation?` / `lineageHash?`），旧记录缺字段时行为不变——沿用现有 `bond`/`evs`/`rating` 的兼容写法。
3. **不引入新状态、新索引、新通道、新背书策略**。繁殖在一笔交易内完成；并发保护来自"扣积分写同一个玩家键"，不是来自锁双亲。

## 3. 改动清单

新增文件（删掉即卸载）：

| 文件 | 作用 |
|---|---|
| `chaincode/pokemon-cc/src/contracts/history.contract.ts` | 履历查询合约 |
| `chaincode/pokemon-cc/src/contracts/breeding.contract.ts` | 繁殖合约 |
| `backend/src/history/*` | 履历模块（controller / service / module） |
| `backend/src/breeding/*` | 繁殖模块 + `breeding-derive.ts` |
| `frontend/src/components/PokemonHistory.vue` | 履历抽屉 |
| `frontend/src/views/BreedingView.vue` | 繁殖页 |
| `backend/test/history.spec.ts`、`backend/test/breeding.spec.ts` | 后端测试 |
| `chaincode/pokemon-cc/tests/history.test.ts`、`breeding.test.ts` | 链码测试 |
| `test-vectors/chain/breeding_*.json` | 链码 ↔ Mock 对拍向量 |

对现有文件的改动（全部带 `[FEAT:...]` 标记，可 grep 定位）：

| 文件 | 改动 | 行数 |
|---|---|---|
| `chaincode/pokemon-cc/src/index.ts` | 注册两个合约 | 4 行 |
| `chaincode/pokemon-cc/src/common/model.ts` | `Pokemon` 加两个可选字段 | 4 行 |
| `backend/src/fabric/chain.adapter.ts` | 加 3 个抽象方法 | ~12 行 |
| `backend/src/fabric/fabric-chain.adapter.ts` | 实现这 3 个方法 | ~40 行 |
| `backend/src/fabric/mock-chain.adapter.ts` | 实现这 3 个方法 + `put()` 里记一行历史 | ~110 行 |
| `backend/src/fabric/mock-chain.store.ts` | 可选的历史读写方法 | ~30 行 |
| `backend/src/fabric/chain.types.ts` | `PokemonState` 加可选字段、历史记录类型 | ~12 行 |
| `backend/src/app.module.ts` | 注册两个模块 | 4 行 |
| `frontend/src/router/*` | 繁殖页路由 | 2 行 |
| `network/docker-compose.yaml` | 显式开启 peer 历史库（履历依赖） | 2 行 |
| `docs/AGENTS.md` 的 `docs` 行 | 补文档索引 | 1 行 |

除后端适配器之外，没有任何现有函数**内容**被修改；适配器里的新增方法统一追加在文件末尾的 `[FEAT]` 区块。

## 4. 卸载步骤

想砍掉某一项，按下面四步走，互不影响：

```bash
# 1) 删链码与后端实现
rm chaincode/pokemon-cc/src/contracts/breeding.contract.ts
rm -rf backend/src/breeding
# 2) 删测试与对拍向量
rm backend/test/breeding.spec.ts chaincode/pokemon-cc/tests/breeding.test.ts
rm test-vectors/chain/breeding_*.json
# 3) 清掉带标记的引用
grep -rn "\[FEAT:breeding\]" --include=*.ts --include=*.vue --include=*.yaml .
# 4) 必须验证：后端 build + 三端测试 + Mock 回归
```

第 3 步不是"删完就完"——注册行、抽象方法、适配器实现、模块注册、路由与页面入口都在标记里，必须逐个删掉；删完不跑编译和测试等于没卸干净。

标记命名：`[FEAT:history]`、`[FEAT:breeding]`，成对使用 `// --- [FEAT:x] begin ---` / `// --- [FEAT:x] end ---`，方便整块删。

账本里已经写入的子代不会因为删合约而消失；可选字段让旧代码能忽略它们，但重新启用功能时要考虑这些遗留记录。

前端删掉组件与路由后，其余页面不受影响——履历抽屉是独立组件，繁殖页是独立路由。

## 5. 推进顺序

| 顺序 | 内容 | 预估 | 说明 |
|---|---|---|---|
| 1 | 履历（链码 + Mock + 后端 + 前端） | 1 天 | 纯读，风险最低，先拿到可演示成果 |
| 2 | 繁殖（链码 + 对拍向量 + Mock + 后端 + 前端） | 2–3 天 | 唯一有随机性的部分，必须做对拍 |
| 3 | 文档与测试计数回填 | 半天 | 跑三端测试，改 `AGENTS.md` 计数 |

## 6. 共同风险

| 风险 | 处理 |
|---|---|
| Mock 与链码行为不一致 | 繁殖必须加 `test-vectors/chain/breeding_*.json`，两侧 Jest 共跑（仓库现有做法） |
| 链码改动导致既有测试红 | 两个合约都不碰现有交易；`index.ts` 只加注册 |
| 前端打包体积 | 两个功能都不引入新依赖 |
| 演示时看起来"没效果" | 履历依赖 Mock 历史记录，必须实现，否则演示模式下列表为空 |
