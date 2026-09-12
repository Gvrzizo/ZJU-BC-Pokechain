#!/usr/bin/env bash
# PokeChain —— 演示数据灌入
#
# 流程：等待 backend 健康 → 在后端运行 `npm run seed`（注册 ash/gary/arbiter/admin、
# 链上 RegisterPlayer、发放精灵球/道具、走完整 Commit→Reveal→Mint 流程铸造演示宝可梦）。
#
# 两种模式：
#   默认（compose 模式）：对 docker compose 栈中的 backend 容器执行 seed。
#       用法：./scripts/seed-demo.sh
#       可用环境变量：COMPOSE_FILE（默认 ROOT/docker-compose.yaml）
#                    HEALTH_URL（默认 http://localhost:8080/api/v1/health）
#   LOCAL=true：对本机直接运行的后端（localhost:3000）seed，seed 在本机 backend/ 目录执行。
#       用法：LOCAL=true ./scripts/seed-demo.sh
#
# seed 脚本是幂等的：用户/链上角色/道具/宝可梦都按固定 idemKey 去重，可安全重跑。
# mock 链世界状态存 Redis（前缀 mockchain:），所以 seed 进程铸造的资产对
# 运行中的 backend 立即可见（见 backend/src/fabric/mock-chain.store.ts）。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="${LOCAL:-false}"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/docker-compose.yaml}"

if [[ "$LOCAL" == "true" ]]; then
  HEALTH_URL="${HEALTH_URL:-http://localhost:3000/api/v1/health}"
else
  HEALTH_URL="${HEALTH_URL:-http://localhost:8080/api/v1/health}"
fi

log()  { printf '\033[36m[seed-demo]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[seed-demo]\033[0m %s\n' "$*" >&2; }
die()  {
  printf '\033[31m[seed-demo] ERROR: %s\033[0m\n' "$*" >&2
  cat >&2 <<'EOF'

排查提示：
  1. backend 是否已启动？ compose 模式：`docker compose ps`（backend 应为 healthy）；
     LOCAL 模式：`cd backend && npm run start:dev`。
  2. 健康检查是否可达？ `curl -i <HEALTH_URL>`（见上方输出）。
  3. seed 依赖 PG + Redis：compose 模式下确认 postgres/redis 容器 healthy；
     LOCAL 模式确认 backend/.env 的 DATABASE_URL / REDIS_URL 指向本机服务。
  4. 容器内完整报错：`docker compose logs backend`，或手动
     `docker compose exec -T backend npm run seed` 查看输出。
  5. 默认 FABRIC_MOCK=true 即可 seed；FABRIC_MOCK=false 需先启动 network/ 的 Fabric 网络。
EOF
  exit 1
}

# ---- 1) 等待 backend 健康（30 次 × 2s = 最多 60s）----
log "等待 backend 健康检查通过：$HEALTH_URL（最多 60s）"
healthy=false
for i in $(seq 1 30); do
  if curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null | grep -q '"status":"ok"'; then
    healthy=true
    log "backend 已就绪（第 $i 次探测）"
    break
  fi
  sleep 2
done
[[ "$healthy" == "true" ]] || die "backend 健康检查超时：$HEALTH_URL"

# ---- 2) 执行 seed ----
if [[ "$LOCAL" == "true" ]]; then
  log "LOCAL 模式：在本机 backend/ 执行 seed"
  cd "$ROOT/backend"
  if [[ -f dist/scripts/seed.js ]]; then
    npm run seed || die "npm run seed 执行失败"
  else
    warn "dist/scripts/seed.js 不存在，改用 ts-node（npm run seed:dev）"
    npm run seed:dev || die "npm run seed:dev 执行失败"
  fi
else
  command -v docker >/dev/null 2>&1 || die "未找到 docker CLI"
  [[ -f "$COMPOSE_FILE" ]] || die "未找到 compose 文件：$COMPOSE_FILE"
  log "compose 模式：docker compose -f $COMPOSE_FILE exec -T backend npm run seed"
  docker compose -f "$COMPOSE_FILE" exec -T backend npm run seed \
    || die "容器内 seed 执行失败（backend 镜像需为最新构建：docker compose up -d --build）"
fi

# ---- 3) 校验资产对运行中的 backend 可见 ----
# 回归防线：mock 链状态曾只存在各自进程内存里，seed 成功但后端查不到资产。
# 真链模式（FABRIC_MOCK=false）下 seed 账号无托管证书，查询会直接报错
# （NO_FABRIC_CERT，见 docs/deployment.md §4.4），这种情况仅告警跳过；
# mock 模式下查询成功但资产为空 = 链状态没共享给 backend，必须失败退出。
API_BASE="${HEALTH_URL%/health}"

login_token() {
  local user="$1"
  curl -fsS --max-time 5 -X POST "$API_BASE/auth/login" \
    -H 'Content-Type: application/json' \
    -H "X-Nonce: seed-demo-$(date +%s%N)-$RANDOM" \
    -H "X-Timestamp: $(date +%s%3N)" \
    -d "{\"username\":\"$user\",\"password\":\"demo1234\"}" \
    | grep -o '"accessToken":"[^"]*"' | head -1 | cut -d'"' -f4
}

# api_get <path> <token> —— 设置 RESP_CODE / RESP_BODY，网络错误不退出
api_get() {
  local out
  out="$(curl -sS --max-time 5 -w $'\n%{http_code}' "$API_BASE$1" -H "Authorization: Bearer $2" 2>/dev/null)" \
    || { RESP_CODE="000"; RESP_BODY=""; return 0; }
  RESP_CODE="${out##*$'\n'}"
  RESP_BODY="${out%$'\n'*}"
}

count_docs() { { grep -o "\"docType\":\"$1\"" || true; } | wc -l | tr -d ' '; }

log "校验演示资产对 backend 可见：$API_BASE"
for user in ash gary; do
  token="$(login_token "$user" || true)"
  if [[ -z "$token" ]]; then
    warn "$user 登录失败，跳过资产校验（真链模式 seed 账号无托管证书属已知限制）"
    continue
  fi
  api_get "/pokemon?owner=me" "$token"
  if [[ ! "$RESP_CODE" =~ ^2 ]]; then
    warn "$user 查询宝可梦失败（HTTP $RESP_CODE: $RESP_BODY），跳过资产校验（真链模式 seed 账号无托管证书属已知限制）"
    continue
  fi
  pokemon="$(printf '%s' "$RESP_BODY" | count_docs pokemon)"
  api_get "/items?owner=me" "$token"
  [[ "$RESP_CODE" =~ ^2 ]] || die "$user 查询道具失败（HTTP $RESP_CODE: $RESP_BODY）"
  items="$(printf '%s' "$RESP_BODY" | count_docs item)"
  [[ "$pokemon" -ge 1 && "$items" -ge 1 ]] \
    || die "$user 名下资产为空（pokemon=$pokemon, items=$items）：链状态未共享给 backend，检查 Redis 连接与 mockchain:* 键"
  log "  $user：pokemon=$pokemon，items=$items"
done

# ---- 4) 打印演示账号 ----
cat <<'EOF'

┌──────────────────────────────────────────────────────────┐
│  演示数据灌入完成！                                      │
├──────────────────────────────────────────────────────────┤
│  演示账号（密码均为 demo1234）：                         │
│    ash      玩家（小智，持皮卡丘/喷火龙 + 精灵球）       │
│    gary     玩家（小茂，持水箭龟/伊布/耿鬼 + 精灵球）    │
│    arbiter  仲裁员（admin 控制台可见争议仲裁面板）       │
│    admin    管理员（mint 道具 / 加积分 / 审计日志）      │
├──────────────────────────────────────────────────────────┤
│  入口：http://localhost:8080  （直连 API :3000/api/v1）  │
│  冒烟：./scripts/e2e-smoke.sh                            │
└──────────────────────────────────────────────────────────┘
EOF
