# PokeChain 环境复刻指南（人类读者版）

从零克隆到跑起来约 10-15 分钟（主要是 Docker 镜像与素材下载时间）。

## 0. 前置依赖

| 依赖 | 版本 | 用途 |
|---|---|---|
| Docker + Docker Compose | v2（`docker compose version` 能跑即可） | 起全部服务（必须） |
| Node.js | ≥ 20 | 跑素材脚本、单测、本地开发（必须） |
| Python 3 + Pillow | `pip install pillow` | 生成世界地图瓦片（必须，否则地图是占位画风） |
| jq / curl / openssl | 系统自带或包管理器安装 | 一键脚本与冒烟脚本依赖 |

> Windows 建议 WSL2；macOS 用 Docker Desktop。全程不需要梯子（素材源为 GitHub raw/jsDelivr，如你的网络访问 GitHub 困难见 §5 故障表）。

## 1. 克隆与素材补全

```bash
git clone <仓库地址> Pokechain && cd Pokechain

# ① 宝可梦 sprite/叫声/道具图标（约 8MB，下载自 PokeAPI 官方仓库）
node scripts/fetch-assets.mjs

# ② 世界地图瓦片/NPC/主角（固定版本 GBA 绿宝石素材，5 张图集 + 51 张独立图片）
python3 frontend/tools/build-world-assets.py
```

**为什么素材不在仓库里**：宝可梦形象/地图素材属任天堂版权，仅用于课程演示，按约定不进 git。两个脚本可重跑：PokeAPI 下载跳过已有文件；世界脚本复用下载缓存并重新生成图集。**跳过素材也能跑**——前端会回退到程序化生成的占位像素图，只是丑。

世界资源固定上游提交，下载缓存位于 `~/.cache/pokechain-world/<revision>/`。已有同版本 pokeemerald 源码可运行 `python3 frontend/tools/build-world-assets.py --source /path/to/pokeemerald`，避免重复下载。输出路径始终是项目的 `frontend/public/assets/vendor/world/`。

GPT Image 生成的跑鞋、登录/注册插画及原始输出已入库（`frontend/public/assets/generated/`、`frontend/art/`），不需要额外 API key 或重新生成。素材来源与完整提示词见 `docs/visual-design.md`、`frontend/art/prompts.json`。

## 2. 启动（演示模式，默认）

```bash
docker compose up -d --build     # 起 PostgreSQL/Redis/MinIO/后端/前端（后端用内置 mock 链，语义与真链码一致）
./scripts/seed-demo.sh           # 灌演示数据（幂等，可随时重跑）
```

打开 http://localhost:8080 ，演示账号：`ash` / `gary` / `arbiter` / `admin`，密码均为 `demo1234`。
也可以直接注册新账号——注册送 1000 积分，进游戏选御三家领新手礼包，未白镇找"妈妈"领跑鞋。

验证一切正常：`./scripts/e2e-smoke.sh`（端到端 25 项断言：注册→捕捉→交易→押注对战→结算→公平性复核）。

## 3. 停止 / 重置

```bash
docker compose down          # 停止（数据保留在 docker 卷里）
docker compose down -v       # 彻底清空（链状态/账号全没），之后重跑 seed-demo.sh 恢复
```

## 4. 可选：真链模式（Hyperledger Fabric 2.5）

```bash
./scripts/up.sh               # 下载 Fabric 2.5.9 二进制到 network/bin，起双组织网络+通道（首次会拉镜像，较慢）
./scripts/deployCC.sh         # 打包部署 TypeScript 链码 pokemoncc（首次在 peer 容器内 npm install，较慢）
# 按根 docker-compose.yaml 文件头的 [real-fabric] 注释取消 backend 的 volumes/networks 注释
FABRIC_MOCK=false docker compose up -d --build
```

细节与真链已知限制（仲裁演示需走 mock 等）见 `docs/deployment.md` §4。**课堂演示用演示模式即可**，真链模式用于展示链码真实部署与 CouchDB 世界状态。

## 5. 常见故障

| 症状 | 处理 |
|---|---|
| 素材脚本报网络错误 | 重跑脚本（断点续传）；GitHub raw 不可达时配代理 `HTTPS_PROXY=... node scripts/fetch-assets.mjs`，或找已下载过的组员拷贝 `frontend/public/assets/vendor/` 整个目录 |
| `docker compose` 端口被占 | 8080/3000/5432/6379/9000 被其他程序占用，改根 compose 端口映射或停掉占用程序 |
| 后端一直 unhealthy | `docker compose logs backend`；常见于数据库还没起来，等 30s 或 `docker compose restart backend` |
| 游戏页素材是色块 | 素材脚本没跑或没跑全；跑完后**强制刷新浏览器缓存**（Ctrl+Shift+R） |
| 想跑测试 | `cd backend && npm ci && npm test`（前端/链码同理，见 AGENTS.md 命令表） |

## 6. 地图美术检查

启动 `cd frontend && npm run dev`，打开 `http://localhost:5173/tools/world-preview.html`，可选择地图或查看全部 15 张图。预览与 Phaser 共用原作拼接逻辑，方便确认岸线、建筑、人物和特殊地形；正式游戏的遮罩/HUD/交互需在 `/game` 检查。此工具仅用于开发，不是新的业务路由。

## 7. 给 Agent 的读者

如果你的 AI Agent（Kimi Code / Claude Code / Cursor 等）要帮你搭建或二次开发：仓库根目录的 `AGENTS.md` 就是给 Agent 读的完整指南（架构决策、命令、纪律），直接让它"先读 AGENTS.md"即可。环境复刻的 Agent 速查清单见该文件的「Agent 环境复刻」一节。
