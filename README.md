# PokeChain —— 基于 Hyperledger Fabric 的类宝可梦链游（课程大作业）

B/S 架构、GBA《宝可梦 红宝石/蓝宝石》像素风。宝可梦相关名称/形象/音效/地图仅用于课程演示。

- 区块链：Hyperledger Fabric 2.5（双组织 + Fabric CA + CouchDB + Raft）
- 链码：TypeScript（`chaincode/pokemon-cc`，六合约：Player/Random/Pokemon/Item/Trade/Battle）
- 后端：NestJS + fabric-gateway（浏览器不直连 Peer/Orderer）
- 前端：Vue3 + Phaser 3
- 链下：PostgreSQL / Redis / MinIO（图片音频地图，链上只存 hash+URI）

## 快速开始

```bash
./scripts/up.sh          # 启动 Fabric 网络 + 通道 + 部署链码
docker compose up -d     # 启动 PostgreSQL/Redis/MinIO + 后端 + 前端
./scripts/seed-demo.sh   # 灌入演示数据
./scripts/e2e-smoke.sh   # 端到端冒烟：注册→捕捉→交易→押注对战→结算
```

浏览器访问 http://localhost:8080 。

课堂快速演示可免 Fabric 网络（根 compose 默认即 mock 链模式，世界状态存 Redis）：`FABRIC_MOCK=true docker compose up -d --build && ./scripts/seed-demo.sh`，随后 `./scripts/e2e-smoke.sh` 跑端到端冒烟。

详细文档见 `docs/`：

| 文档 | 内容 |
|---|---|
| `docs/architecture.md` | 总体架构与链上/链下职责划分 |
| `docs/chaincode-api.md` | 链码合约接口规范（数据模型/交易/事件/安全规则） |
| `docs/backend-api.md` | 后端 REST/WebSocket API 规范 |
| `docs/randomness.md` | 可验证随机数方案（承诺-揭示 + VRF 扩展） |
| `docs/security.md` | 安全设计（身份/链码/对战押注/链下资源/隐私/运维） |
| `docs/deployment.md` | 部署与演示手册、故障处理规则 |

## 仓库结构

```
network/    Fabric 2.5 双组织测试网络与脚本
chaincode/  TypeScript 链码 + Jest 单测
backend/    NestJS 后端
frontend/   Vue3 + Phaser3 前端
scripts/    一键部署/重置/演示/冒烟脚本
docs/       设计与演示文档
```
