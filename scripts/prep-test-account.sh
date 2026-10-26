#!/usr/bin/env bash
# PokeChain —— 造一个"可直接繁殖"的测试账号
#
#   ./scripts/prep-test-account.sh                 # 自动生成用户名
#   ./scripts/prep-test-account.sh alice           # 指定用户名
#   BASE_URL=http://localhost:8080 ./scripts/prep-test-account.sh
#
# 做的事：注册（真链模式会自动向 CA 申领证书）→ 领御三家 → admin 发大师球与神奇糖果
#        → 用大师球再抓一只（保证有两只）→ 打印账号密码与操作步骤。
# 不做的事：不升级、不繁殖——糖果怎么喂、和谁繁殖由你自己在界面上决定。
#
# 依赖：curl、jq；admin 账号需已存在（跑过 seed 或已有 admin/demo1234）。

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

BASE_URL="${BASE_URL:-http://localhost:8080}"
API="${BASE_URL%/}/api/v1"

USERNAME="${1:-player$(date +%s)}"
PASSWORD="${PASSWORD:-Demo#1234}"
STARTER_SPECIES="${STARTER_SPECIES:-1}"   # 1 妙蛙种子 / 4 小火龙 / 7 杰尼龟
TARGET_MONS="${TARGET_MONS:-3}"           # 目标宝可梦数量（都可以当亲代）
CANDY_COUNT="${CANDY_COUNT:-$((15 * TARGET_MONS + 10))}"  # 每只升到 20 级约需 15 颗
BALL_COUNT="${BALL_COUNT:-5}"

nonce() { printf 'n%s' "$(date +%s%N)"; }
stamp() { printf '%s' "$(date +%s%3N)"; }

post() { # post <path> <token|-> <json>
  local auth=()
  [ "$2" != "-" ] && auth=(-H "Authorization: Bearer $2")
  curl -s -X POST "${API}$1" -H 'Content-Type: application/json' \
    -H "X-Nonce: $(nonce)" -H "X-Timestamp: $(stamp)" "${auth[@]}" -d "$3"
}

get() { # get <path> <token>
  curl -s "${API}$1" -H "Authorization: Bearer $2"
}

json_field() { jq -r "$1 // empty" 2>/dev/null; }

# ---- 0) 前置检查 ----
command -v jq >/dev/null 2>&1 || fatalln "需要 jq（apt install jq）"
curl -sf --max-time 5 "${API}/health" >/dev/null \
  || fatalln "后端不可达：${API}/health（先启动 docker compose）"

stepln "步骤 1/5 注册 ${USERNAME}"
REG="$(post /auth/register - "{\"username\":\"${USERNAME}\",\"password\":\"${PASSWORD}\",\"nickname\":\"${USERNAME}\"}")"
if echo "${REG}" | jq -e '.user.username' >/dev/null 2>&1; then
  infoln "注册成功（真链模式会同时向 CA 申领证书）"
elif echo "${REG}" | grep -q 'USERNAME_TAKEN\|already'; then
  warnln "用户名已存在，直接登录"
else
  warnln "注册返回：$(echo "${REG}" | head -c 200)"
fi

TOKEN="$(post /auth/login - "{\"username\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}" | json_field .accessToken)"
[ -n "${TOKEN}" ] || fatalln "登录失败：检查用户名/密码，或后端日志"

stepln "步骤 2/5 领取御三家（speciesId=${STARTER_SPECIES}）"
STARTER="$(post /users/me/starter "${TOKEN}" "{\"speciesId\":${STARTER_SPECIES}}")"
echo "${STARTER}" | jq -e '.id // .pokemon.id' >/dev/null 2>&1 \
  && infoln "已领取" || warnln "领取跳过（可能已领过）"

stepln "步骤 3/5 admin 发放神奇糖果 ×${CANDY_COUNT}、大师球 ×${BALL_COUNT}"
ADMIN_TOKEN="$(post /auth/login - '{"username":"admin","password":"demo1234"}' | json_field .accessToken)"
if [ -n "${ADMIN_TOKEN}" ]; then
  post /admin/items/mint "${ADMIN_TOKEN}" "{\"playerId\":\"${USERNAME}\",\"typeId\":\"rare-candy\",\"quantity\":${CANDY_COUNT}}" >/dev/null
  post /admin/items/mint "${ADMIN_TOKEN}" "{\"playerId\":\"${USERNAME}\",\"typeId\":\"master-ball\",\"quantity\":${BALL_COUNT}}" >/dev/null
  infoln "已发放"
else
  warnln "admin 登录失败（需要 admin/demo1234 且 seed 过）；糖果需要自己想办法"
fi

stepln "步骤 4/5 保证有两只宝可梦"
COUNT="$(get "/pokemon?owner=me" "${TOKEN}" | jq '[.. | objects | select(.docType=="pokemon")] | length')"
BALL="$(get "/items?owner=me" "${TOKEN}" | jq -r '[.. | objects | select(.typeId=="master-ball")][0].id // empty')"
while [ "${COUNT:-0}" -lt "${TARGET_MONS}" ]; do
  if [ -z "${BALL}" ]; then
    warnln "没有大师球，只能凑到 ${COUNT} 只"
    break
  fi
  EVENT="$(post /capture/encounter "${TOKEN}" '{"zoneId":"route-grass"}' | json_field .eventId)"
  [ -n "${EVENT}" ] || { warnln "遇敌失败，停止捕捉"; break; }
  post /capture/attempt "${TOKEN}" "{\"eventId\":\"${EVENT}\",\"ballItemId\":\"${BALL}\"}" >/dev/null
  NEW_COUNT="$(get "/pokemon?owner=me" "${TOKEN}" | jq '[.. | objects | select(.docType=="pokemon")] | length')"
  if [ "${NEW_COUNT:-0}" -le "${COUNT:-0}" ]; then
    warnln "捕捉未成功（数量未增加），停止"
    break
  fi
  COUNT="${NEW_COUNT}"
  infoln "已捕捉第 ${COUNT} 只"
done
infoln "宝可梦数量：${COUNT}（目标 ${TARGET_MONS}）"

stepln "步骤 5/5 汇总"
MONS="$(get "/pokemon?owner=me" "${TOKEN}" | jq -r '[.. | objects | select(.docType=="pokemon")] | .[] | "  \(.id)  \(.name)  Lv\(.level)  IV合计\((.ivs.hp + .ivs.atk + .ivs.def + .ivs.spatk + .ivs.spdef + .ivs.speed))"')"
# 真链上可能出现多个同 typeId 堆叠（CouchDB 富查询有延迟，合并未必立刻生效），这里按总量求和
CANDIES="$(get "/items?owner=me" "${TOKEN}" | jq -r '[.. | objects | select(.typeId=="rare-candy") | .quantity] | add // 0')"
POINTS="$(get /users/me "${TOKEN}" | jq -r '.user.points // 0')"

cat <<EOF

┌──────────────────────────────────────────────────────────────┐
│  测试账号已就绪                                              │
├──────────────────────────────────────────────────────────────┤
  地址：${BASE_URL}
  账号：${USERNAME}
  密码：${PASSWORD}

  宝可梦：
${MONS}

  神奇糖果：${CANDIES} 颗      积分：${POINTS}P

  接下来（界面操作）：
   1. 登录 → 队伍页，选中一只宝可梦
   2. 背包里用「神奇糖果」喂到 20 级（每次 +1 级，约 15 颗）
   3. 另一只同样喂到 20 级（等级不够时培育屋会列出原因）
   4. 队伍页 → 选中一只 → 点「培育屋」→ 选另一只 → 繁殖（200P）
   5. 子代 Lv1，可在队伍里查看履历与血统
└──────────────────────────────────────────────────────────────┘
EOF
