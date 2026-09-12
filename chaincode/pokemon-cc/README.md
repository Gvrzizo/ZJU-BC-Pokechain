# pokemon-cc — PokeChain TypeScript 链码

Hyperledger Fabric 2.5 / fabric-contract-api 2.5 链码，链码名 `pokemoncc`，通道 `gamechannel`。
接口规范以 `../../docs/chaincode-api.md` 为唯一权威（数据模型 / 交易 / 状态机 / 安全规则 / 错误码 / 事件 / CouchDB 索引）。

## 合约一览

| 合约 | 职责 |
|---|---|
| `PlayerContract` | 注册、角色授予、积分增减/转账 |
| `RandomContract` | 捕捉/对战/铸造随机数：承诺-揭示（Commit → RevealAndVerify），`consumeRandom` 为同链码内部操作 |
| `PokemonContract` | MintFromCapture（消费已验证随机事件）、转移、成长、放生、图鉴富查询 |
| `ItemContract` | 道具铸造/转移/消耗（按堆叠存） |
| `TradeContract` | 双方确认 + 原子执行的交易（锁定 → 双确认执行 / 取消 / 过期） |
| `BattleContract` | 押注锁定 + escrow、签名结果提交、双确认/兜底结算、弃赛、争议仲裁 |

跨合约内部调用（锁定资产、扣积分、消费随机事件）通过 `src/common/state.ts` 的公共 helper
直接操作共享键空间，不使用 `stub.invokeChaincode`。

## 开发约定（与 docs/chaincode-api.md §0 一致）

- **确定性**：无 `Date.now()`/`Math.random()`；时间一律 `nowISO` 参数；随机只来自 RandomContract 已验证的 resultHash。
- **身份**：CID `mspId` + `getAttributeValue('role')`；角色 `player`（默认）/`admin`/`system`（Org1）、`arbitrator`（Org2MSP）。
- **幂等**：所有变更交易带 `idemKey`，命中 `idemp:<idemKey>` 直接返回首次结果。
- **错误**：`throw new Error('CODE: message')`，CODE 全大写蛇形。
- **参数**：交易参数均为字符串，JSON 参数链上 parse 并校验；返回 JSON 字符串。
- **哈希**：`canonical(obj)` = 键排序 `JSON.stringify`；`sha256hex` / HMAC-SHA256 派生（`node:crypto`）。

## 目录结构

```
src/index.ts                 导出全部合约（contracts 数组）
src/common/                  canonical/sha256/hmac 派生、键工具、CID 角色校验、
                             withIdempotency、状态机/所有权/锁定断言、safeInt、
                             model.ts（世界状态类型）、state.ts（跨合约状态 helper）
src/contracts/               player / random / pokemon / item / trade / battle .contract.ts
META-INF/statedb/couchdb/indexes/   indexOwner / indexTrade / indexBattle / indexSpecies
tests/                       Jest 单测 + 手写最小 ChaincodeStub/ClientIdentity mock
```

## 构建与测试

```bash
npm install     # 已含 .npmrc（engine-strict=false / legacy-peer-deps）
npm run build   # tsc → dist/
npm test        # jest（60 用例）
npm start       # fabric-chaincode-node start（由 peer 以链码服务器模式拉起）
```

测试 mock 说明：`@theledger/fabric-mock-stub` 依赖 `fabric-shim ^1.4` + TS3，与本工程
fabric 2.5 栈不兼容，故 `tests/helpers/harness.ts` 手写最小 `MockStub`/`ClientIdentity`
（世界状态 + 事务写缓存，抛错即回滚，与 Fabric 交易语义一致），并用 `mspId`/`role` 属性
模拟 Org1MSP（admin/system/player）与 Org2MSP（arbitrator/player）身份。

## 打包与部署

打包部署由仓库根目录 `scripts/deployCC.sh` 统一负责（peer lifecycle chaincode
package/install/approveformyorg/commit）。`META-INF/` 下的 CouchDB 索引随链码包一起安装，
链码提交后首次富查询自动生效，无需手工建索引。
