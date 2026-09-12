# PokeChain 前端

Vue 3 + TypeScript + Phaser 3（Vite 构建）—— GBA《宝可梦 红宝石/蓝宝石》像素风的区块链宝可梦游戏前端。对接 `../docs/backend-api.md` 描述的 NestJS 后端（REST `/api/v1` + Socket.IO `/battle`）。

## 开发

```bash
npm install
npm run dev        # http://localhost:5173，/api 与 /socket.io 代理到 http://localhost:3000
npm run build      # vue-tsc 类型检查 + vite build（产物 dist/）
npm run preview    # 本地预览构建产物
npm test           # vitest（API 拦截器 nonce 注入单测）
```

## 素材（宝可梦正版 sprite + 程序化占位）

BootScene 启动时会：

1. 拉取 `GET /api/v1/assets/manifest`（`[{uri, sha256, size}]`）；
2. 尝试从 `/assets/vendor/` 加载本地素材；manifest 中存在对应条目时，用 Web Crypto 重算 sha256 校验一致性，**校验失败自动回退占位贴图**；
3. 缺失的资源用 Phaser Canvas 程序化生成占位像素贴图（瓦片 32×32，主角 4 方向 × 3 帧行走图；宝可梦 = 底色 + 眼睛 + 编号的 96×96 sprite）。

仓库已内置第三世代（红/蓝宝石，GBA 风）全国图鉴 #1–386 的正面/背面 sprite 与叫声；瓦片与主角没有稳定官方源，使用程序化生成的 GBA 风占位图。文件名即约定，放入 `public/assets/vendor/` 同名文件即可覆盖（无需改代码）：

| 路径 | 规格 | 说明 |
|---|---|---|
| `public/assets/vendor/pokemon/001.png` … `386.png` | 64×64 | 图鉴 / 敌方视角正面 sprite（渲染时整数倍最近邻放大：战斗 2×，图鉴 1×~2×） |
| `public/assets/vendor/pokemon/back/001.png` … `386.png` | 64×64 | 我方视角背面 sprite（BattleScene 我方出战用；缺失时回退正面图并镜像） |
| `public/assets/vendor/cries/<编号>.ogg` | Ogg Vorbis | 出场叫声（BattleScene 出场/换宠、捕捉成功时播放；共 361 个可野生遭遇种族，清单见 `src/game/mon-assets.ts` 的 `CRY_SPECIES_IDS`） |
| `public/assets/vendor/items/<typeId>.png` | 30×30 | 道具图标（`ItemIcon.vue`，背包/交易列表；**文件名即链上 typeId**，如 `poke-ball.png`、`tm-surf.png`） |
| `public/assets/vendor/tiles.png` | 160×32（5 格 32×32） | 瓦片集：草 / 路 / 树 / 水 / 深草（索引 0-4），缺省由 `textures.ts` 生成 |
| `public/assets/vendor/hero.png` | 96×128（3 列 × 4 行 32×32） | 主角行走图：行序 下/上/左/右，列序 站立/迈步A/迈步B，缺省由 `textures.ts` 生成 |

素材同时登记到后端 `/assets/register` 并出现在 manifest 中时，前端会自动做完整性校验。

### 道具图标（items/）

12 个在用道具（`backend/src/game-data/items.data.ts` 的 `ITEM_TYPES`）各一张，直接抓 PokeAPI sprites：

| 上游 | 本地文件 |
|---|---|
| `sprites/items/poke-ball.png` `great-ball` `ultra-ball` `master-ball` `potion` `super-potion` `thunder-stone` `water-stone` `fire-stone` | 同名保存 |
| `sprites/items/tm-electric.png` | `tm-thunderbolt.png` |
| `sprites/items/tm-fire.png` | `tm-flamethrower.png` |
| `sprites/items/tm-water.png` | `tm-surf.png` |

TM 类上游只按属性出图（`tm-<属性>.png`），没有通用 `tm.png`（404），故按技能机实际教的技能属性映射到本地 `tm-<技能 id>.png`。
`ItemIcon.vue` 用图片实际宽度算整数倍最近邻放大（`ui/item-icon.ts`），加载失败回退按类别配色的像素占位块（球红/药绿/石黄/技能机蓝）。

### 素材来源与版权（仅课程演示）

- 宝可梦 sprite：PokeAPI/sprites 仓库，第三世代红/蓝宝石版本，例如
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-iii/ruby-sapphire/<编号>.png`
  （背面图同路径 `back/<编号>.png`）。
- 道具图标：同名仓库 `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/<名称>.png`（TM 类见上表映射）。
- 叫声：PokeAPI/cries 仓库 `https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/latest/<编号>.ogg`
  （上游 `025.ogg` 实际为 MP3 数据，其余为 Ogg Vorbis；浏览器按内容解码，不受扩展名影响）。
- 宝可梦名称、形象与音频版权归 任天堂 / GAME FREAK / The Pokémon Company 所有，
  本项目仅在课程演示范围内使用，不作商业用途，不再分发到演示之外的场景。

## 字体（自托管 + 中英混排对齐）

界面字体全部放在 `public/fonts/` 自托管（**不再依赖 Google Fonts 等外网 CDN**，课程演示断网也能跑）：

| 文件 | 字形 | 网格 | 来源 | 许可 |
|---|---|---|---|---|
| `press-start-2p-latin-400.woff2` | 拉丁/数字 | 8×8 | `@fontsource/press-start-2p@5.3.0`（jsDelivr，即 Google Fonts 的 latin 子集） | SIL OFL 1.1（`OFL-press-start-2p.txt`） |
| `press-start-2p-latin-ext-400.woff2` | 拉丁扩展 | 8×8 | 同上（latin-ext 子集） | 同上 |
| `fusion-pixel-12px-proportional-zh_hans-aligned.woff2` | 中日韩 + 标点符号 | 12×12 | 缝合像素字体 Fusion Pixel Font `2026.09.01` 的 `12px-proportional-zh_hans.otf`，[release 资产](https://github.com/TakWolf/fusion-pixel-font/releases/tag/2026.09.01)，经 `tools/align-cjk-font.py` 上移 2 格后转 woff2 | SIL OFL 1.1（`OFL-fusion-pixel.txt`，字形原版权归 TakWolf 及上游 ark-pixel / cubic-11 / galmuri） |

字体栈 `--px-font: 'Press Start 2P', 'Fusion Pixel 12px', monospace`：拉丁走 Press Start 2P，中文按字形回退到 Fusion Pixel；`unicode-range` 拆了子集，页面里没出现的子集不会被下载（实测纯英文页面只拉 Press Start 2P 的 latin 子集）。

上游文件与产出文件的 sha256（用于核对本地产物，`sha256sum` 直接比对）：

```
fusion-pixel-12px-proportional-zh_hans.otf（上游，release zip 内）  82e05156031524165202ccdae6c284aaeecd798271e32c65cbf0c6568ade8cfa
fusion-pixel-12px-proportional-zh_hans-aligned.woff2（本仓库）    a335ff3194943f481802ab1d51f4823d90c5b539f9e6aca5c6c1b42ec0088f80
press-start-2p-latin-400.woff2（@fontsource 原文件）                afec86997fdaf54af1f59358fa2c1e2a0f1d04146edad18e5cd141d0384a7548
press-start-2p-latin-ext-400.woff2（@fontsource 原文件）            3c7df3a15e173b8fa04ec9191171e72c314ddbac1b395e2b2e2092bb4f47cc8c
```

`tools/align-cjk-font.py` 是确定性的（`TTFont(..., recalcTimestamp=False)`），同一份上游 OTF 每次产出的 woff2 字节一致。

### 混排对齐（为什么要动字体文件）

两套字体的原生度量不同，直接混排会「汉字比字母矮一截、行高跳动」：

| | Press Start 2P | Fusion Pixel 12px（上游） |
|---|---|---|
| em / 网格 | 1000 / 8px | 1200 / 12px |
| 原生 ascender / descender | 1000 / 0（hhea）、usWinDescent 374 | 1300 / −300 |
| 字形与基线的关系 | 大写字母下缘离基线 **1 格**（0.125em），字面全部在基线上方 | 汉字字面框**跨基线**（−0.083em ~ +0.833em） |

处理方式：

1. **字形上移 2 格**（`tools/align-cjk-font.py`，只在字体文件层面平移，不改字形）：汉字字面框从 −0.083em~+0.833em 变成 +0.083em~+1.0em，与 Press Start 2P 的大写字母带（+0.125em~+1.0em）基本重合——顶边对齐、底边差 0.5px；12px 字号下平移量正好 2 个整数像素，点阵不糊。
2. **`@font-face` 度量描述符**（`src/styles/fonts.css`）把两套字体的**行盒**钉死成同一套：
   - `size-adjust: 100%`（中文）：12px 字号下 1 个点阵格 = 1 个 CSS 像素，点阵最清晰；
   - `ascent-override: 100% / descent-override: 0% / line-gap-override: 0%`（两个字体都设）：内容区统一为 1em，同行不管出现哪种字体、换行时行盒高度都不变，也消除 Windows（usWin* 度量）与 macOS/Linux（hhea）之间的渲染差异。
3. **全局行高**（`pixel.css`）：`--px-lh-body: 1.75`（段落）/ `--px-lh-tight: 1.5`（单行列表、表格、日志），组件里不再散落 1.5/1.6/1.7/1.8。

重新生成对齐版字体（上游 OTF 从 release zip 解出，需要 `fonttools` + `woff2_compress`）：

```bash
cd frontend
python3 tools/align-cjk-font.py /path/to/fusion-pixel-12px-proportional-zh_hans.otf \
  public/fonts/fusion-pixel-12px-proportional-zh_hans-aligned.woff2
```

### 字号阶梯

点阵字体只在网格整数倍下清晰（Press Start 2P：8/16/24px，Fusion Pixel：12/24px），两套网格的最小公倍数是 24px，对正文太大，因此正文取 12px：

| 变量 | 值 | 用途 |
|---|---|---|
| `--px-fs-xl` | 24px | `h1`（POKECHAIN 标题）、段位徽章图形 |
| `--px-fs-lg` | 16px | `h2`（页面标题） |
| `--px-fs-md` / `--px-fs-sm` | 12px | 正文、按钮、表单、表格、徽章、提示——**中文可读下限** |
| `.mono` | 8px | 只放纯拉丁串（哈希 / id / typeId / serverSeed），8px 是 Press Start 2P 的 1:1 网格 |

低于 12px 的中文在 12px 点阵上会糊成一团，界面里 8~11px 的中文一律已提到 12px（`.mono` 的纯拉丁内容除外）。

已知取舍：`h2`（16px）对中文来说是 1.33× 网格，笔画边缘会有轻微抗锯齿（24px 才是中文的 2× 整数倍，作为页面标题过大）；正文 12px 与 `h1` 24px 都是两套网格的整数倍，最清晰。

## 多语言（i18n）

前端词典方案（不动后端）：导航栏右侧「中 / EN」按钮切换，语言存 `localStorage` 的 `pokechain.locale`，默认中文；未收录的 id 回退英文原名。

| 文件 | 作用 |
|---|---|
| `src/locales/zh.ts` `en.ts` | UI 文案 + 386 只宝可梦（全国图鉴 #1–386，官方中文名/英文名）+ 全部 43 个技能 + 12 个道具 typeId + 25 种性格（含能力修正说明） |
| `src/locales/index.ts` | 词典装配、id 归一化、英文名 / PokeAPI slug → 图鉴编号索引 |
| `src/composables/useI18n.ts` | `useI18n()`：`t(key, params?)` / `monName(id)` / `moveName(id)` / `itemName(typeId)` / `natureName(id)` / `natureEffect(id)` / `locale` / `setLocale` / `toggleLocale` |
| `src/ui/ItemIcon.vue` `ui/item-icon.ts` | 道具图标与占位回退 |

```ts
// Vue 组件（<script setup>）
import { useI18n } from '@/composables/useI18n';
const { t, monName, moveName, itemName, natureName, locale, toggleLocale } = useI18n();
// 模板中：{{ t('nav.bag') }} / {{ monName(p.speciesId, p.name) }} / {{ moveName('thunder-shock') }}
```

```ts
// 非组件代码（Phaser 场景等）：同名函数可直接 import，模块级单例，与组件共享同一语言
import { t, monName, moveName, itemName, natureName } from '@/composables/useI18n';
```

- `monName(id)` 收图鉴编号（`25` / `'25'`）或英文名 / PokeAPI slug（`'pikachu'`、`'Mr. Mime'`、`'nidoran-f'`）；查不到时用第二个参数兜底（一般传后端给的 `name`）。
- `moveName(id)` 同时接受技能 id 与英文显示名（`'thunder-shock'` / `'Thunder Shock'`）。
- `t(key, params)` 支持 `{name}` 占位符；键缺失时回退默认语言，再回退键名本身。
- 语言是模块级响应式单例，切换后所有用过上述函数的组件 / 场景一起变（`zh.ts` 与 `en.ts` 的 UI 键集必须一致，`useI18n.test.ts` 有用例守着）。

## 页面清单（路由）

| 路由 | 说明 |
|---|---|
| `/login` `/register` | 像素风表单；JWT 存 pinia + localStorage；axios 拦截器带 token、变更请求注入 `X-Nonce`(crypto.randomUUID) / `X-Timestamp`；401 自动 refresh 重放 |
| `/game` | Phaser 主界面 + Vue HUD。BootScene（manifest + sha256 校验 + 占位生成）→ OverworldScene（40×30 程序化草地、方向键/WASD 网格行走、深草随机遇敌 → `POST /capture/encounter` → 捕捉覆盖层：选球投掷、shakes 动画、成功/失败） |
| `/bag` | 道具列表与使用（`POST /items/:id/use`，可选目标宝可梦） |
| `/pokedex` | 图鉴列表 + 详情，已拥有高亮（`GET /pokedex`） |
| `/team` | 我的宝可梦网格 + 详情（IV/性格/技能/dnaHash/链上状态徽章），训练 / 进化 / 放生（二次确认） |
| `/trade` | 收到/发出的交易、创建交易（双方资产 + 积分 + TTL）、确认/取消（`/trades` API） |
| `/lobby` | 房间列表、创建（押注：宝可梦/道具/积分 + 出战队伍）、加入、押注清单双确认面板（确认即链上锁定提示） |
| `/battle/:id` | Phaser BattleScene（台座 / HP 条动画 / 伤害飘字 / 克制提示）+ Socket.IO namespace `/battle`（JWT auth）；技能/换宠/道具/逃跑按钮、30s 回合计时条、断线重连（重连后自动 `battle:join` 恢复）、结算面板（押注归属展示）、争议申诉 |
| `/fairness` | 输入 eventId → `GET /fairness/:eventId`，Web Crypto 前端重算 `sha256(serverSeed)==commitHash`、`sha256(serverSeed\|clientSeed\|eventId)==resultHash` 及 HMAC 派生流可复现性（逐条打勾动画） |
| `/admin` | role=admin/arbitrator 可见：mint 道具（`POST /admin/items/mint`）、争议查询与仲裁（`POST /battles/:id/arbitrate`） |

## Docker

```bash
docker build -t pokechain-frontend .
docker run -p 8080:80 pokechain-frontend   # 需后端容器以 backend:3000 可达（同一 docker network）
```

多阶段构建（node:20 → nginx:alpine）；`nginx.conf` 含 SPA fallback、`/api` 与 `/socket.io` 反代 `backend:3000`（含 WebSocket Upgrade 头）。

## 目录结构

```
src/
  api/         axios 封装（http.ts 拦截器；auth/pokemon/capture/items/trades/battles/assets/fairness/admin 每模块一文件）
  stores/      pinia：auth（JWT 持久化）、assets（manifest/占位状态）、pokemon、battle（WS 驱动实时态）
  locales/     zh.ts / en.ts 词典（386 宝可梦 + 43 技能 + 12 道具 + 25 性格 + UI 文案）
  composables/ useI18n（t/monName/moveName/itemName/natureName，语言存 localStorage，默认中文）
  game/        Phaser：scenes/BootScene、OverworldScene、BattleScene；net/BattleSocket.ts；textures.ts 占位生成；mon-assets.ts 素材命名/尺寸约定；cries.ts 叫声播放；bus.ts 场景↔Vue 事件总线
  ui/          像素风组件：PixelButton、PixelDialog、HpBar、SpriteIcon、ItemIcon（道具图标 + 占位回退）
  components/  CaptureOverlay、WagerPicker、ItemActionRow
  views/       12 个路由页面
  styles/      pixel.css（全局像素风：字号阶梯变量、GBA 配色、像素边框/按钮/HP 条）、fonts.css（@font-face + 度量对齐）
  tools/       align-cjk-font.py（把中文像素字体字形上移 2 格，与 Press Start 2P 基线对齐）

public/
  fonts/       自托管像素字体（Press Start 2P + Fusion Pixel）+ OFL 许可证，来源见「字体」一节
```