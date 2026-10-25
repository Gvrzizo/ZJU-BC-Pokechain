# 链码 ↔ Mock 对拍向量

`test-vectors/chain/*.json` 是**同一批行为用例**的机器可读描述，链码 Jest（`chaincode/pokemon-cc/tests/vectors.test.ts`）
与后端 Jest（`backend/test/chain-vectors.spec.ts`）各跑一遍。任何一侧改语义而另一侧没跟上，两边测试之一必红。

## 为什么需要

`FABRIC_MOCK=true` 的 MockChainAdapter 复刻链码语义，但它是一份独立实现。历史上出现过：

- 权限错误码 `NOT_AUTHORIZED`（Mock）vs `FORBIDDEN`（链码）；
- 对局状态错误码 `INVALID_BATTLE_STATE`（Mock）vs `BAD_STATE`（链码）；
- 随机事件 `EVENT_EXISTS`/`PLAYER_MISMATCH` vs `RAND_EXISTS`/`RAND_PLAYER_MISMATCH`；
- 重复注册 Mock 静默返回旧档案，链码抛 `PLAYER_EXISTS`。

这些差异在 Mock 模式下看不出来，切真链后表现为 500 或前端错误分支走空。向量把"同码同状态"固化成回归。

## 结构

```json
{
  "name": "唯一文件名同名的向量名",
  "description": "一句话说明覆盖的评审条目",
  "steps": [
    {
      "op": "transferPoints",
      "as": "alice",
      "args": { "fromId": "bob", "toId": "alice", "amount": 10 },
      "expect": { "ok": false, "code": "NOT_OWNER" },
      "state": [{ "kind": "playerPoints", "playerId": "bob", "equals": 1000 }]
    }
  ]
}
```

- **fixture**：每个向量开始前注册 `alice`/`bob`/`carol`，并把三人余额归一到 **1000P**（与链上初始值解耦，经济数值调整不会打断向量）。
- **时间**：固定基准 `2026-01-01T00:00:00.000Z`，第 i 步取 +i 分钟；不使用系统时间。
- **幂等键**：默认 `<向量名>-<步序号>`；`args.idemKey` 可显式指定（幂等重放用例）。
- **身份**：`"alice"` = 玩家证书（`hf.EnrollmentID=alice`）；`"system"`/`"admin"` 为服务身份；
  对象形式 `{"role":"player"}` 表示**证书缺 `hf.EnrollmentID`**，用于验证"不回退 mspId"。
  可带 `mspId`（默认 `Org1MSP`）。
- **expect**：缺省为 `{ "ok": true }`；`{ "ok": false, "code": "X" }` 断言错误码。
- **state**：步骤执行后读取链上状态断言，支持
  `playerPoints` / `pokemonOwner|Status|Bond|Level` / `itemOwner|Status|Quantity` /
  `tradeStatus` / `battleStatus|Winner|ResultHash|ArbiterNote`。

## 新增向量

1. 只加 JSON，不改驱动；算子（op）已覆盖 Player/Pokemon/Item/Trade/Battle 主路径。
2. 若需要新 op 或新断言，**同时**改两个驱动：`chaincode/pokemon-cc/tests/vectors.test.ts` 与
   `backend/test/chain-vectors.spec.ts`，并在这里补一行说明。
3. 先跑链码侧，再跑后端侧；两边都绿才算对齐。

> 约束：向量断言的是**链码契约**。Mook 与链码冲突时以链码为准（改 Mock），不要把链码改成迁就 Mock。
