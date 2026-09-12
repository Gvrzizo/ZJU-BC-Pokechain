#!/usr/bin/env bash
# PokeChain —— 部署 pokemoncc 链码（TypeScript / node）
# 流程：package → install(Org1,Org2) → approveformyorg(各一次) →
#       checkcommitreadiness → commit → querycommitted 验证
# 序列号 1，背书/初始化策略使用通道默认（见 docs/chaincode-api.md 第 4 节）。
# 幂等：已按相同 version/sequence 提交时直接退出。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

CC_NAME="pokemoncc"
CC_VERSION="1.0"
CC_LABEL="pokemoncc_1.0"
CC_SEQUENCE=1
CC_DIR="${ROOT_DIR}/chaincode/pokemon-cc"
PKG_FILE="${NETWORK_DIR}/channel-artifacts/${CC_NAME}.tar.gz"

ORG1_PEER_TLS_CERT="${NETWORK_DIR}/organizations/peerOrganizations/org1.pokechain.com/peers/peer0.org1.pokechain.com/tls/ca.crt"
ORG2_PEER_TLS_CERT="${NETWORK_DIR}/organizations/peerOrganizations/org2.pokechain.com/peers/peer0.org2.pokechain.com/tls/ca.crt"

stepln "步骤 1/7 前置检查"
[ -d "${CC_DIR}" ] || fatalln "链码目录不存在：${CC_DIR}（pokemon-cc 仓库尚未就绪）"
[ -f "${CC_DIR}/package.json" ] || fatalln "${CC_DIR} 缺少 package.json（node 链码打包要求 package.json 位于链码根目录）"
"${SCRIPTS_DIR}/prereq.sh"
docker ps --format '{{.Names}}' | grep -qx 'peer0.org1.pokechain.com' || fatalln "网络未运行，请先执行 ./scripts/up.sh"
docker ps --format '{{.Names}}' | grep -qx 'peer0.org2.pokechain.com' || fatalln "peer0.org2 未运行，请先执行 ./scripts/up.sh"

switchOrg 1
if peer lifecycle chaincode querycommitted -C "${CHANNEL_NAME}" -n "${CC_NAME}" --output json 2>/dev/null \
    | jq -e ".version == \"${CC_VERSION}\" and .sequence == ${CC_SEQUENCE}" >/dev/null 2>&1; then
  infoln "链码 ${CC_NAME} 已提交（version ${CC_VERSION}, sequence ${CC_SEQUENCE}），无需重复部署"
  exit 0
fi

stepln "步骤 2/7 打包链码（lang=node, label=${CC_LABEL}）"
# node 链码打包自动排除 node_modules；META-INF/statedb/couchdb/indexes 随包发布
mkdir -p "${NETWORK_DIR}/channel-artifacts"
peer lifecycle chaincode package "${PKG_FILE}" --path "${CC_DIR}" --lang node --label "${CC_LABEL}"
infoln "链码包：${PKG_FILE}"

stepln "步骤 3/7 安装到两组织 peer"
switchOrg 1
peer lifecycle chaincode install "${PKG_FILE}"
infoln "已安装到 peer0.org1"
switchOrg 2
peer lifecycle chaincode install "${PKG_FILE}"
infoln "已安装到 peer0.org2"

PACKAGE_ID="$(switchOrg 1 >/dev/null; peer lifecycle chaincode queryinstalled --output json \
  | jq -r ".installed_chaincodes[] | select(.label == \"${CC_LABEL}\") | .package_id" | head -n1)"
[ -n "${PACKAGE_ID}" ] && [ "${PACKAGE_ID}" != "null" ] || fatalln "未能从 queryinstalled 解析 Package ID（label=${CC_LABEL}）"
infoln "Package ID: ${PACKAGE_ID}"

stepln "步骤 4/7 approveformyorg（Org1 / Org2 各一次）"
approveForOrg() {
  local org="$1"
  switchOrg "${org}"
  # 重复 approve 同一 sequence 会报错，此处容忍该错误以保证幂等
  if ! peer lifecycle chaincode approveformyorg \
      -o localhost:7050 --ordererTLSHostnameOverride orderer.pokechain.com \
      --tls --cafile "${ORDERER_CA}" \
      --channelID "${CHANNEL_NAME}" --name "${CC_NAME}" \
      --version "${CC_VERSION}" --package-id "${PACKAGE_ID}" \
      --sequence "${CC_SEQUENCE}" 2>&1 | tee /tmp/pokechain-approve-org${org}.log; then
    if grep -qE "redefine uncommitted approved chaincode|already (defined|approved)" /tmp/pokechain-approve-org${org}.log; then
      warnln "Org${org} 已批准过该定义，跳过"
    else
      fatalln "Org${org} approveformyorg 失败（见 /tmp/pokechain-approve-org${org}.log）"
    fi
  else
    infoln "Org${org} 已批准"
  fi
}
approveForOrg 1
approveForOrg 2

stepln "步骤 5/7 checkcommitreadiness"
switchOrg 1
peer lifecycle chaincode checkcommitreadiness \
  --channelID "${CHANNEL_NAME}" --name "${CC_NAME}" \
  --version "${CC_VERSION}" --sequence "${CC_SEQUENCE}" --output json \
  | tee /tmp/pokechain-readiness.log \
  | jq -e '.approvals.Org1MSP == true and .approvals.Org2MSP == true' >/dev/null \
  || fatalln "提交就绪检查未通过（见 /tmp/pokechain-readiness.log）"
infoln "两组织均已批准，可以提交"

stepln "步骤 6/7 提交链码定义（commit）"
peer lifecycle chaincode commit \
  -o localhost:7050 --ordererTLSHostnameOverride orderer.pokechain.com \
  --tls --cafile "${ORDERER_CA}" \
  --channelID "${CHANNEL_NAME}" --name "${CC_NAME}" \
  --version "${CC_VERSION}" --sequence "${CC_SEQUENCE}" \
  --peerAddresses localhost:7051 --tlsRootCertFiles "${ORG1_PEER_TLS_CERT}" \
  --peerAddresses localhost:9051 --tlsRootCertFiles "${ORG2_PEER_TLS_CERT}"
infoln "链码定义已提交"

stepln "步骤 7/7 验证已提交（querycommitted）"
peer lifecycle chaincode querycommitted -C "${CHANNEL_NAME}" -n "${CC_NAME}" --output json | jq .
peer lifecycle chaincode querycommitted -C "${CHANNEL_NAME}" -n "${CC_NAME}" --output json \
  | jq -e ".version == \"${CC_VERSION}\" and .sequence == ${CC_SEQUENCE}" >/dev/null \
  || fatalln "querycommitted 结果与预期不符"

stepln "链码部署完成"
cat <<EOF
链码：${CC_NAME}  version=${CC_VERSION}  sequence=${CC_SEQUENCE}  通道=${CHANNEL_NAME}
背书策略：通道默认（MAJORITY Endorsement，即 Org1+Org2 均须背书）

下一步：
  ./scripts/seed-demo.sh    灌入演示数据（待后端就绪后实现）
  ./scripts/e2e-smoke.sh    端到端冒烟（待后端就绪后实现）
EOF
