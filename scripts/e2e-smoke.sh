#!/usr/bin/env bash
# PokeChain —— 端到端冒烟测试（REST 全链路）
#
#   健康检查 → 注册 A/B（随机后缀，X-Nonce/X-Timestamp 防重放头）→ 登录
#   → admin 登录并给 A mint 精灵球 / 给 B 加积分（admin 不可用则容忍并降级）
#   → A 遇敌并捕捉（最多 3 个 encounter）→ 断言 A 宝可梦列表 +1
#   → A→B 交易（新账号 72h 转账锁断言 + offer 宝可梦、0 积分）→ B confirm → A confirm → 断言归属
#   → A 再捕一只 → A 开房 + B 加入 → 双方押注确认（escrow）
#   → B forfeit（战斗实时操作走 WS，冒烟以 REST 认输代替）→ 断言 SETTLED 且 A 赢得押注
#   → GET /fairness/ev_battle_<id> 并用 openssl 复核 sha256(serverSeed)==commitHash
#
# 用法：
#   ./scripts/e2e-smoke.sh                 # 打前端反代（默认 http://localhost:8080）
#   BASE_URL=http://localhost:3000 ./scripts/e2e-smoke.sh   # 直连后端
# 依赖：bash curl jq openssl。任一断言失败立即打印请求/响应并 exit 1。

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
API="${BASE_URL%/}/api/v1"
RESP_FILE="$(mktemp)"
trap 'rm -f "$RESP_FILE"' EXIT

PASS_COUNT=0
HTTP_CODE=""
BODY=""

step() { printf '\n\033[36m▶ %s\033[0m\n' "$*"; }
ok()   { PASS_COUNT=$((PASS_COUNT + 1)); printf '\033[32m  ✔ %s\033[0m\n' "$*"; }
# info/warn 走 stderr：capture_one 等函数经 $() 捕获 stdout 返回值的场合不受污染
info() { printf '  · %s\n' "$*" >&2; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*" >&2; }

fail() {
  printf '\033[31m  ✘ FAIL: %s\033[0m\n' "$1" >&2
  printf '    HTTP %s\n    响应体: %s\n' "${HTTP_CODE:-?}" "${BODY:-<empty>}" >&2
  printf '    提示: %s\n' "${2:-查看后端日志（docker compose logs backend / npm run start:dev）}" >&2
  exit 1
}

# call <method> <path> [token] [json-body]  —— 写入 HTTP_CODE / BODY，非 2xx 不退出
call() {
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  local args=(-sS --max-time 15 -X "$method" "${API}${path}"
              -H 'Content-Type: application/json' -o "$RESP_FILE" -w '%{http_code}')
  [[ -n "$token" ]] && args+=(-H "Authorization: Bearer ${token}")
  if [[ "$method" != "GET" && "$method" != "HEAD" ]]; then
    local nonce ts
    nonce="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || openssl rand -hex 16)"
    ts="$(date +%s%3N)"
    args+=(-H "X-Nonce: ${nonce}" -H "X-Timestamp: ${ts}")
  fi
  [[ -n "$body" ]] && args+=(--data "$body")
  HTTP_CODE="$(curl "${args[@]}")"
  BODY="$(cat "$RESP_FILE")"
}

expect2xx() { [[ "$HTTP_CODE" =~ ^2 ]] || fail "$1" "${2:-}"; }
jqget() { jq -r "$1" <<<"$BODY"; }

# ---- 0) 依赖与目标 ----
for bin in curl jq openssl; do
  command -v "$bin" >/dev/null 2>&1 || { echo "缺少依赖：$bin" >&2; exit 1; }
done
step "0. 目标 ${API}"

# ---- 1) 健康检查 ----
step "1. GET /health（最多重试 15 次）"
healthy=false
for i in $(seq 1 15); do
  call GET /health
  if [[ "$HTTP_CODE" == "200" ]] && [[ "$(jqget '.status' 2>/dev/null || true)" == "ok" ]]; then
    healthy=true; break
  fi
  sleep 2
done
[[ "$healthy" == "true" ]] || fail "健康检查未通过" "服务未启动？compose 栈：docker compose up -d --build；本机：cd backend && npm run start:dev"
ok "backend 健康（第 ${i} 次探测）"

# ---- 2) 注册两个随机用户 ----
SUFFIX="$(date +%s)$RANDOM"
A_NAME="smkA${SUFFIX}"
B_NAME="smkB${SUFFIX}"
PASSWORD="Smoke#1234"

step "2. 注册用户 A=${A_NAME} / B=${B_NAME}（含 X-Nonce/X-Timestamp）"
call POST /auth/register "" "{\"username\":\"${A_NAME}\",\"password\":\"${PASSWORD}\",\"nickname\":\"冒烟A\"}"
expect2xx "注册 A 失败"
TOKEN_A="$(jqget '.accessToken')"
[[ -n "$TOKEN_A" && "$TOKEN_A" != "null" ]] || fail "注册 A 响应缺少 accessToken"
ok "A 注册成功（响应含 user/accessToken/refreshToken）"

call POST /auth/register "" "{\"username\":\"${B_NAME}\",\"password\":\"${PASSWORD}\",\"nickname\":\"冒烟B\"}"
expect2xx "注册 B 失败"
TOKEN_B="$(jqget '.accessToken')"
[[ -n "$TOKEN_B" && "$TOKEN_B" != "null" ]] || fail "注册 B 响应缺少 accessToken"
ok "B 注册成功"

# ---- 3) 登录 ----
step "3. 登录 A / B"
call POST /auth/login "" "{\"username\":\"${A_NAME}\",\"password\":\"${PASSWORD}\"}"
expect2xx "A 登录失败"
TOKEN_A="$(jqget '.accessToken')"
ok "A 登录成功"
call POST /auth/login "" "{\"username\":\"${B_NAME}\",\"password\":\"${PASSWORD}\"}"
expect2xx "B 登录失败"
TOKEN_B="$(jqget '.accessToken')"
ok "B 登录成功"

points_of() { # points_of <token> -> 链上积分（/users/me 合并字段）
  call GET /users/me "$1"
  expect2xx "GET /users/me 失败"
  jqget '.user.points // 0'
}

# ---- 4) admin：mint 精灵球给 A、加积分给 B（失败容忍）----
step "4. admin 登录并发放物资（seed 提供的 admin/demo1234；不可用则降级）"
ADMIN_TOKEN=""
call POST /auth/login "" '{"username":"admin","password":"demo1234"}'
if [[ "$HTTP_CODE" =~ ^2 ]]; then
  ADMIN_TOKEN="$(jqget '.accessToken')"
  # 大师球 ballBonus=255 → 捕捉阈值 min(1, catchRate*255)=1，保证冒烟确定性（每次 attempt 必中）
  call POST /admin/items/mint "$ADMIN_TOKEN" "{\"playerId\":\"${A_NAME}\",\"typeId\":\"master-ball\",\"quantity\":4}"
  if [[ "$HTTP_CODE" =~ ^2 ]]; then ok "admin 给 A mint master-ball ×4"; else warn "mint 精灵球失败（HTTP ${HTTP_CODE}），继续用库存球"; fi
  call POST /admin/points "$ADMIN_TOKEN" "{\"playerId\":\"${B_NAME}\",\"delta\":200,\"reason\":\"smoke\"}"
  if [[ "$HTTP_CODE" =~ ^2 ]]; then ok "admin 给 B 加 200 积分"; else warn "加积分失败（HTTP ${HTTP_CODE}），积分断言将降级"; fi
else
  warn "admin 登录失败（HTTP ${HTTP_CODE}）——未运行 seed-demo.sh？后续 mint/积分步骤跳过"
fi

# admin 可用时顺带验证争议列表端点（GET /battles?status=disputed，admin/arbitrator 守卫）
if [[ -n "$ADMIN_TOKEN" ]]; then
  call GET "/battles?status=disputed" "$ADMIN_TOKEN"
  if [[ "$HTTP_CODE" =~ ^2 ]] && jq -e 'type == "array"' <<<"$BODY" >/dev/null; then
    ok "GET /battles?status=disputed 返回数组（争议仲裁列表端点在线）"
  else
    warn "GET /battles?status=disputed 异常（HTTP ${HTTP_CODE}）"
  fi
fi

# ---- 5) A 找一颗可用的球 ----
step "5. 检查 A 的精灵球库存"
call GET "/items?owner=me" "$TOKEN_A"
expect2xx "GET /items 失败"
BALL_ID="$(jqget '[.[] | select(.status=="IDLE" and .quantity>0 and (.typeId | test("ball$")))] | (map(select(.typeId=="master-ball")) + map(select(.typeId=="ultra-ball")) + .)[0].id // empty')"
[[ -n "$BALL_ID" ]] || fail "A 没有可用精灵球" "先运行 ./scripts/seed-demo.sh，或确认第 4 步 admin mint 成功"
ok "使用球 ${BALL_ID}"

# ---- 6) A 捕捉宝可梦（最多 3 个 encounter）----
capture_one() { # capture_one <token> <ball> -> 输出 pokemonId；失败返回 1
  local token="$1" ball="$2" i client_seed event_id success pid
  for i in 1 2 3; do
    client_seed="$(openssl rand -hex 16)"
    call POST /capture/encounter "$token" "{\"clientSeed\":\"${client_seed}\"}"
    expect2xx "创建 encounter 失败"
    event_id="$(jqget '.eventId')"
    info "encounter $i：$(jqget '.wild.name') Lv$(jqget '.wild.level')（eventId=${event_id}）"
    call POST /capture/attempt "$token" "{\"eventId\":\"${event_id}\",\"ballItemId\":\"${ball}\"}"
    expect2xx "捕捉 attempt 失败"
    success="$(jqget '.success')"
    if [[ "$success" == "true" ]]; then
      pid="$(jqget '.pokemon.id')"
      info "捕获成功：$(jqget '.pokemon.name')（id=${pid}）"
      printf '%s' "$pid"
      return 0
    fi
    info "捕捉失败（shakes=$(jqget '.shakes')），重新遇敌"
  done
  return 1
}

step "6. A 遇敌 + 捕捉（最多 3 个 encounter）"
call GET "/pokemon?owner=me" "$TOKEN_A"
expect2xx "GET /pokemon 失败"
N0="$(jq 'length' <<<"$BODY")"
POKEMON_ID="$(capture_one "$TOKEN_A" "$BALL_ID")" || fail "连续 3 个 encounter 均未捕获（球数不足？）"
ok "A 捕获宝可梦 ${POKEMON_ID}"

call GET "/pokemon?owner=me" "$TOKEN_A"
expect2xx "GET /pokemon 失败"
N1="$(jq 'length' <<<"$BODY")"
[[ "$N1" == "$((N0 + 1))" ]] || fail "宝可梦列表数量应为 $((N0 + 1))，实际 ${N1}"
jq -e --arg id "$POKEMON_ID" 'map(.id) | index($id) != null' <<<"$BODY" >/dev/null \
  || fail "列表中未找到 ${POKEMON_ID}"
ok "断言通过：A 宝可梦列表 ${N0} → ${N1}（+1）"

# ---- 7) 交易：新账号 72h 转账锁断言；A offer 宝可梦、0 积分；B→A 双方 confirm ----
step "7. A→B 交易（H10 转账锁 + offer 宝可梦，0 积分）"
PB0="$(points_of "$TOKEN_B")"
PA0="$(points_of "$TOKEN_A")"
call POST /trades "$TOKEN_A" \
  "{\"toPlayerId\":\"${B_NAME}\",\"offer\":{\"pokemonIds\":[],\"itemIds\":[],\"points\":10},\"request\":{\"pokemonIds\":[],\"itemIds\":[],\"points\":0},\"ttlSeconds\":600}"
[[ "$HTTP_CODE" == "409" ]] || fail "新账号 72h 转账锁应返回 409，实际 ${HTTP_CODE}"
[[ "$(jqget '.code')" == "TRANSFER_LOCKED" ]] || fail "应返回 TRANSFER_LOCKED，实际 $(jqget '.code')"
ok "断言通过：新账号 72h 转账锁生效（TRANSFER_LOCKED）"

call POST /trades "$TOKEN_A" \
  "{\"toPlayerId\":\"${B_NAME}\",\"offer\":{\"pokemonIds\":[\"${POKEMON_ID}\"],\"itemIds\":[],\"points\":0},\"request\":{\"pokemonIds\":[],\"itemIds\":[],\"points\":0},\"ttlSeconds\":600}"
expect2xx "创建交易失败"
TRADE_ID="$(jqget '.id')"
[[ "$(jqget '.status')" == "OPEN" ]] || fail "交易状态应为 OPEN"
ok "交易已创建 ${TRADE_ID}（0P 资产交换）"

call POST "/trades/${TRADE_ID}/confirm" "$TOKEN_B"
expect2xx "B 确认交易失败"
[[ "$(jqget '.confirmations.to')" == "true" ]] || fail "B 确认后 confirmations.to 应为 true"
ok "B 已确认（等待 A 确认）"

call POST "/trades/${TRADE_ID}/confirm" "$TOKEN_A"
expect2xx "A 确认交易失败"
[[ "$(jqget '.status')" == "EXECUTED" ]] || fail "双方确认后交易应为 EXECUTED，实际 $(jqget '.status')"
ok "交易已执行（EXECUTED）"

call GET "/pokemon/${POKEMON_ID}" "$TOKEN_B"
expect2xx "GET /pokemon/:id 失败"
[[ "$(jqget '.ownerId')" == "$B_NAME" ]] || fail "宝可梦归属应为 B，实际 $(jqget '.ownerId')"
ok "断言通过：宝可梦归属 A → B"

PA1="$(points_of "$TOKEN_A")"
PB1="$(points_of "$TOKEN_B")"
[[ "$PA1" == "$PA0" ]] || fail "0P 交易后 A 积分应保持 ${PA0}，实际 ${PA1}"
[[ "$PB1" == "$PB0" ]] || fail "0P 交易后 B 积分应保持 ${PB0}，实际 ${PB1}"
ok "断言通过：0P 交易积分不变 A ${PA0}→${PA1}，B ${PB0}→${PB1}"

# ---- 8) A 再捕一只（A 的出战队伍；B 用交易所得出战）----
step "8. A 捕捉第二只宝可梦（战斗队伍用）"
POKEMON_ID2="$(capture_one "$TOKEN_A" "$BALL_ID")" || fail "A 捕捉第二只失败（球数不足？）"
ok "A 捕获第二只 ${POKEMON_ID2}"

# ---- 9) 房间 + 押注 + B 认输 → SETTLED ----
step "9. 对战房间：创建 → 加入 → 双方押注确认"
WAGER=20
if (( PA1 < 20 || PB1 < 20 )); then
  WAGER=0
  warn "积分不足以押 20P，降级为 0P 友谊赛"
fi
call POST /battles/rooms "$TOKEN_A" \
  "{\"mode\":\"1v1\",\"wager\":{\"pokemonIds\":[],\"itemIds\":[],\"points\":${WAGER}},\"teamPokemonIds\":[\"${POKEMON_ID2}\"]}"
expect2xx "创建房间失败"
ROOM_ID="$(jqget '.id')"
[[ "$(jqget '.status')" == "WAITING" ]] || fail "房间状态应为 WAITING"
ok "房间已创建 ${ROOM_ID}"

call POST "/battles/rooms/${ROOM_ID}/join" "$TOKEN_B" \
  "{\"wager\":{\"pokemonIds\":[],\"itemIds\":[],\"points\":${WAGER}},\"teamPokemonIds\":[\"${POKEMON_ID}\"]}"
expect2xx "B 加入房间失败"
[[ "$(jqget '.status')" == "JOINED" ]] || fail "加入后房间状态应为 JOINED"
ok "B 已加入（各自押 ${WAGER}P）"

call POST "/battles/${ROOM_ID}/wager/confirm" "$TOKEN_A"
expect2xx "A 确认押注失败"
[[ "$(jqget '.confirmations.A')" == "true" ]] || fail "A 确认后 confirmations.A 应为 true"
ok "A 已确认押注（链上 escrow 待 B 确认）"

call POST "/battles/${ROOM_ID}/wager/confirm" "$TOKEN_B"
expect2xx "B 确认押注失败"
[[ "$(jqget '.status')" == "ACTIVE" ]] || fail "双方确认后房间应为 ACTIVE，实际 $(jqget '.status')"
BATTLE_ID="$(jqget '.battleId')"
[[ -n "$BATTLE_ID" && "$BATTLE_ID" != "null" ]] || fail "房间 ACTIVE 但缺少 battleId"
ok "战斗激活：${BATTLE_ID}（押注已链上托管）"

step "10. B 认输（forfeit）→ 断言 SETTLED 且 A 赢得押注"
PA_LOCKED="$(points_of "$TOKEN_A")"
call POST "/battles/${BATTLE_ID}/forfeit" "$TOKEN_B"
expect2xx "B forfeit 失败"
ok "B 已认输（HTTP ${HTTP_CODE}）"

settled=false
for i in $(seq 1 10); do
  call GET "/battles/${BATTLE_ID}" "$TOKEN_A"
  expect2xx "GET /battles/:id 失败"
  if [[ "$(jqget '.battle.status')" == "SETTLED" ]]; then settled=true; break; fi
  sleep 1
done
[[ "$settled" == "true" ]] || fail "对局未结算为 SETTLED（当前 $(jqget '.battle.status')）" "查看后端日志：finalize/forfeit 链上调用是否成功"
[[ "$(jqget '.battle.result.winnerId')" == "$A_NAME" ]] || fail "赢家应为 A（${A_NAME}），实际 $(jqget '.battle.result.winnerId')"
ok "断言通过：battle SETTLED，winner=${A_NAME}"

PA_END="$(points_of "$TOKEN_A")"
EXPECTED_PA=$((PA_LOCKED + 2 * WAGER))
[[ "$PA_END" == "$EXPECTED_PA" ]] || fail "A 应赢回双方押注：${PA_LOCKED}+$((2 * WAGER))=${EXPECTED_PA}，实际 ${PA_END}"
ok "断言通过：A 积分 ${PA_LOCKED} → ${PA_END}（赢得押注 ${WAGER}P）"

# ---- 11) 公平性复核：sha256(serverSeed) == commitHash ----
step "11. GET /fairness/ev_battle_${BATTLE_ID} 并用 openssl 复核 commit"
call GET "/fairness/ev_battle_${BATTLE_ID}"
expect2xx "fairness 查询失败" "战斗随机事件应在 finalize 时 reveal；检查后端日志"
SERVER_SEED="$(jqget '.event.serverSeed')"
COMMIT_HASH="$(jqget '.event.commitHash')"
[[ -n "$SERVER_SEED" && "$SERVER_SEED" != "null" ]] || fail "serverSeed 未揭示（status=$(jqget '.event.status')）"
RECALC="$(printf '%s' "$SERVER_SEED" | openssl dgst -sha256 -r | awk '{print $1}')"
MATCH="$(jq -n --arg a "$RECALC" --arg b "$COMMIT_HASH" '$a == $b')"
[[ "$MATCH" == "true" ]] || fail "sha256(serverSeed)!=commitHash：${RECALC} != ${COMMIT_HASH}"
ok "断言通过：sha256(serverSeed) == commitHash（commit-reveal 一致）"

# ---- 汇总 ----
printf '\n\033[32m════════════════════════════════════════\033[0m\n'
printf '\033[32m  SMOKE PASS —— %d 项断言全部通过\033[0m\n' "$PASS_COUNT"
printf '\033[32m════════════════════════════════════════\033[0m\n'
cat <<EOF
  用户:   A=${A_NAME}  B=${B_NAME}
  捕捉:   ${POKEMON_ID}（已交易给 B）/ ${POKEMON_ID2}
  交易:   ${TRADE_ID}（EXECUTED，0P）
  对战:   ${BATTLE_ID}（SETTLED，B 认输，A 赢得 ${WAGER}P 押注）
  公平性: ev_battle_${BATTLE_ID}（commit-reveal 复核通过）
EOF
