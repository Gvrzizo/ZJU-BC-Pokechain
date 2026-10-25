#!/usr/bin/env bash
# PokeChain —— 真链冒烟前置检查（先验链码/运行时，再可选跑 REST e2e）
#
#   ./scripts/real-chain-smoke.sh               # 只检查 querycommitted + 链码容器
#   ./scripts/real-chain-smoke.sh <用户名>      # 额外用 peer chaincode query 验证 GetPlayer
#   ./scripts/real-chain-smoke.sh <用户名> --e2e # 再跑 BASE_URL 的 e2e-smoke.sh
#
# 为什么需要它：e2e-smoke.sh 走 REST，链码没起来 / ccaas 容器没跑时会在
# “注册用户”阶段报 500，看起来像后端 bug。先跑本脚本能直接定位链码侧问题。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

PLAYER="${PLAYER_ID:-}"
RUN_E2E=0
for arg in "$@"; do
  case "${arg}" in
    --e2e) RUN_E2E=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) fatalln "未知参数：${arg}（支持 --e2e）" ;;
    *) PLAYER="${arg}" ;;
  esac
done

setupFabricEnv
docker ps --format '{{.Names}}' | grep -qx 'peer0.org1.pokechain.com' || fatalln "Fabric 网络未运行，请先 ./scripts/up.sh"

stepln "步骤 1/3 检查链码定义（querycommitted）"
switchOrg 1
COMMITTED="$(peer lifecycle chaincode querycommitted -C "${CHANNEL_NAME}" -n pokemoncc --output json 2>&1)" \
  || fatalln "querycommitted 失败：${COMMITTED}"
echo "${COMMITTED}" | jq -e '.approvals.Org1MSP == true and .approvals.Org2MSP == true' >/dev/null \
  || fatalln "链码未获两组织批准：${COMMITTED}"
infoln "已提交：version=$(jq -r .version <<<"${COMMITTED}") sequence=$(jq -r .sequence <<<"${COMMITTED}")," \
  "approvals=$(jq -c .approvals <<<"${COMMITTED}")"

stepln "步骤 2/3 检查链码运行时"
if docker ps --format '{{.Names}}' | grep -qx 'pokechain-cc'; then
  infoln "ccaas 运行时容器 pokechain-cc 正在运行（$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' pokechain-cc | sed -n 's/^CCID=//p')）"
else
  CC_CONTAINERS="$(docker ps --format '{{.Names}}' | grep '^dev-peer0' || true)"
  if [ -n "${CC_CONTAINERS}" ]; then
    infoln "node 链码容器：${CC_CONTAINERS}"
  else
    warnln "没有发现 pokechain-cc 或 dev-peer0.* 链码容器；若链码不是 chaincode-as-a-service，首次 invoke 时 peer 会自动拉链码"
  fi
fi

stepln "步骤 3/3 检查 GetPlayer"
if [ -n "${PLAYER}" ]; then
  RESULT="$(peer chaincode query -C "${CHANNEL_NAME}" -n pokemoncc \
    -c "{\"Args\":[\"PlayerContract:GetPlayer\",\"${PLAYER}\"]}" 2>&1)" \
    || fatalln "GetPlayer 失败（${PLAYER}）：${RESULT}"
  jq -e '.playerId' <<<"${RESULT}" >/dev/null 2>&1 \
    || fatalln "GetPlayer 返回非玩家 JSON：${RESULT}"
  infoln "GetPlayer ${PLAYER} → points=$(jq -r .points <<<"${RESULT}") rating=$(jq -r .rating <<<"${RESULT}")"
else
  warnln "未提供用户名，跳过 GetPlayer（用法：./scripts/real-chain-smoke.sh <用户名>）"
  warnln "新环境可先注册账号或运行 FABRIC_MOCK=false npm run seed 建档"
fi

if [ "${RUN_E2E}" -eq 1 ]; then
  stepln "附加：运行 e2e-smoke.sh"
  BASE_URL="${BASE_URL:-http://localhost:3000}" "${SCRIPTS_DIR}/e2e-smoke.sh"
else
  stepln "真链冒烟前置检查通过"
  infoln "下一步：BASE_URL=http://localhost:3000 ./scripts/e2e-smoke.sh（或加 --e2e 重跑本脚本）"
fi
