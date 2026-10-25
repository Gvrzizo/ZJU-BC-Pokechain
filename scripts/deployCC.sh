#!/usr/bin/env bash
# PokeChain —— 部署 pokemoncc 链码（TypeScript / node）
# 流程：package → install(Org1,Org2) → approveformyorg(各一次) →
#       checkcommitreadiness → commit → querycommitted 验证
#
# 两种运行方式（C4d）：
#   * node  ：peer 的默认 Docker builder 在 peer 容器内构建链码镜像（Docker ≤ 27 可用）
#   * ccaas ：chaincode-as-a-service，链码在 pokechain-cc 容器里跑 gRPC 服务，peer 直连
#             （Docker 28/29 的 docker builder 会报 write unix @->/run/docker.sock: broken pipe）
#   CC_LANG=auto（默认）按 Docker 主版本自动选择：≥28 用 ccaas，否则 node。
#
# 幂等：已按相同 version/sequence 提交时直接退出（ccaas 会顺带确保链码容器在跑）。
# 升级：CC_VERSION=1.2 CC_SEQUENCE=3 ./scripts/deployCC.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

CC_NAME="pokemoncc"
CC_VERSION="${CC_VERSION:-1.0}"
CC_SEQUENCE="${CC_SEQUENCE:-1}"
CC_LABEL="${CC_LABEL:-${CC_NAME}_$(printf '%s' "${CC_VERSION}" | tr '.' '_')}"
CC_LANG="${CC_LANG:-auto}"
CCAAS_SERVICE="pokechain-cc"
CCAAS_ADDRESS="${CCAAS_ADDRESS:-pokechain-cc:19999}"
CC_DIR="${ROOT_DIR}/chaincode/pokemon-cc"
PKG_DIR="${NETWORK_DIR}/channel-artifacts"

ORG1_PEER_TLS_CERT="${NETWORK_DIR}/organizations/peerOrganizations/org1.pokechain.com/peers/peer0.org1.pokechain.com/tls/ca.crt"
ORG2_PEER_TLS_CERT="${NETWORK_DIR}/organizations/peerOrganizations/org2.pokechain.com/peers/peer0.org2.pokechain.com/tls/ca.crt"

# ---------------------------------------------------------------- helpers

resolveCcLang() {
  case "${CC_LANG}" in
    node|ccaas) return 0 ;;
    auto) ;;
    *) fatalln "CC_LANG 只能是 auto|node|ccaas（当前 ${CC_LANG}）" ;;
  esac
  local major
  major="$(docker version --format '{{.Server.Version}}' 2>/dev/null | cut -d. -f1)"
  if [ -n "${major}" ] && [ "${major}" -ge 28 ] 2>/dev/null; then
    CC_LANG="ccaas"
    warnln "Docker ${major}.x 的默认 builder 与 Fabric 2.5 node 链码不兼容，自动使用 ccaas（可用 CC_LANG=node 强制）"
  else
    CC_LANG="node"
  fi
}

packageCcaas() {
  local work
  work="$(mktemp -d)"
  printf '{"address":"%s","dial_timeout":"10s","tls_required":false}\n' "${CCAAS_ADDRESS}" >"${work}/connection.json"
  printf '{"type":"ccaas","label":"%s"}\n' "${CC_LABEL}" >"${work}/metadata.json"
  (cd "${work}" && tar cfz code.tar.gz connection.json && tar cfz "${PKG_FILE}" metadata.json code.tar.gz)
  rm -rf "${work}"
}

packageNode() {
  peer lifecycle chaincode package "${PKG_FILE}" --path "${CC_DIR}" --lang node --label "${CC_LABEL}"
}

installedPackageId() {
  switchOrg 1 >/dev/null
  peer lifecycle chaincode queryinstalled --output json 2>/dev/null \
    | jq -r --arg label "${CC_LABEL}" '.installed_chaincodes[]? | select(.label == $label) | .package_id' \
    | head -n1
}

ensureCcaasRunning() {
  local pkgId="$1"
  [ -n "${pkgId}" ] || fatalln "ccaas 模式需要 Package ID（${CC_LABEL} 未安装？）"
  # 始终 compose up --build：镜像层有缓存，代码变更后需要重建镜像；
  # CCID/镜像没变时 compose 会复用容器，不会无谓重启。
  infoln "确保链码容器 ${CCAAS_SERVICE} 运行（CCID=${pkgId}，按最新源码重建镜像）"
  CCID="${pkgId}" docker compose -f "${COMPOSE_FILE}" --profile ccaas up -d --no-deps --build "${CCAAS_SERVICE}"
  local n=0
  until docker inspect -f '{{.State.Running}}' "${CCAAS_SERVICE}" 2>/dev/null | grep -q '^true$'; do
    n=$((n + 1))
    if [ "${n}" -ge 30 ]; then
      docker logs --tail 40 "${CCAAS_SERVICE}" >&2 || true
      fatalln "链码容器 ${CCAAS_SERVICE} 未在预期时间内运行（见上）"
    fi
    sleep 2
  done
  local current
  current="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${CCAAS_SERVICE}" 2>/dev/null | sed -n 's/^CCID=//p' || true)"
  [ "${current}" = "${pkgId}" ] || fatalln "链码容器 CCID=${current:-<空>} 与 Package ID ${pkgId} 不一致（docker inspect ${CCAAS_SERVICE}）"
  infoln "链码容器已运行：${CCAAS_SERVICE} → ${CCAAS_ADDRESS}（CCID=${pkgId}）"
}

# ---------------------------------------------------------------- 主流程

stepln "步骤 1/7 前置检查"
[ -d "${CC_DIR}" ] || fatalln "链码目录不存在：${CC_DIR}（pokemon-cc 仓库尚未就绪）"
[ -f "${CC_DIR}/package.json" ] || fatalln "${CC_DIR} 缺少 package.json（node 链码打包要求 package.json 位于链码根目录）"
"${SCRIPTS_DIR}/prereq.sh"
docker ps --format '{{.Names}}' | grep -qx 'peer0.org1.pokechain.com' || fatalln "网络未运行，请先执行 ./scripts/up.sh"
docker ps --format '{{.Names}}' | grep -qx 'peer0.org2.pokechain.com' || fatalln "peer0.org2 未运行"
resolveCcLang
infoln "链码 ${CC_NAME} version=${CC_VERSION} sequence=${CC_SEQUENCE} lang=${CC_LANG} label=${CC_LABEL}"

mkdir -p "${PKG_DIR}"
PKG_FILE="${PKG_DIR}/${CC_NAME}-${CC_VERSION}-${CC_LANG}.tar.gz"

# 已提交相同 version/sequence：不重复 commit，但 ccaas 必须确保运行时容器活着。
switchOrg 1
if peer lifecycle chaincode querycommitted -C "${CHANNEL_NAME}" -n "${CC_NAME}" --output json 2>/dev/null \
    | jq -e ".version == \"${CC_VERSION}\" and .sequence == ${CC_SEQUENCE}" >/dev/null 2>&1; then
  infoln "链码 ${CC_NAME} 已提交（version ${CC_VERSION}, sequence ${CC_SEQUENCE}），无需重复部署"
  if [ "${CC_LANG}" = "ccaas" ]; then
    pkgId="$(installedPackageId)"
    [ -n "${pkgId}" ] || fatalln "ccaas 模式：未找到 label=${CC_LABEL} 的已安装链码包；用 CC_VERSION/CC_SEQUENCE 升级或重装"
    ensureCcaasRunning "${pkgId}"
  fi
  exit 0
fi

stepln "步骤 2/7 打包链码（lang=${CC_LANG}, label=${CC_LABEL}）"
if [ "${CC_LANG}" = "ccaas" ]; then
  packageCcaas
else
  packageNode
fi
infoln "链码包：${PKG_FILE}"

stepln "步骤 3/7 安装到两组织 peer"
switchOrg 1
peer lifecycle chaincode install "${PKG_FILE}"
infoln "已安装到 peer0.org1"
switchOrg 2
peer lifecycle chaincode install "${PKG_FILE}"
infoln "已安装到 peer0.org2"

PACKAGE_ID="$(installedPackageId)"
[ -n "${PACKAGE_ID}" ] && [ "${PACKAGE_ID}" != "null" ] || fatalln "未能从 queryinstalled 解析 Package ID（label=${CC_LABEL}）"
infoln "Package ID: ${PACKAGE_ID}"

if [ "${CC_LANG}" = "ccaas" ]; then
  # peer 在 invoke 时才连链码服务；先让容器起来，后续 GetPlayer 验证才可用。
  ensureCcaasRunning "${PACKAGE_ID}"
fi

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
      --sequence "${CC_SEQUENCE}" 2>&1 | tee "/tmp/pokechain-approve-org${org}.log"; then
    if grep -qE "redefine uncommitted approved chaincode|already (defined|approved)" "/tmp/pokechain-approve-org${org}.log"; then
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
switchOrg 1
peer lifecycle chaincode querycommitted -C "${CHANNEL_NAME}" -n "${CC_NAME}" --output json | jq .
peer lifecycle chaincode querycommitted -C "${CHANNEL_NAME}" -n "${CC_NAME}" --output json \
  | jq -e ".version == \"${CC_VERSION}\" and .sequence == ${CC_SEQUENCE}" >/dev/null \
  || fatalln "querycommitted 结果与预期不符"

stepln "链码部署完成"
cat <<EOF
链码：${CC_NAME}  version=${CC_VERSION}  sequence=${CC_SEQUENCE}  lang=${CC_LANG}  通道=${CHANNEL_NAME}
背书策略：通道默认（MAJORITY Endorsement，即 Org1+Org2 均须背书）
$( [ "${CC_LANG}" = "ccaas" ] && echo "运行时：${CCAAS_SERVICE}（容器内 gRPC ${CCAAS_ADDRESS}，CCID=${PACKAGE_ID}）" )

下一步：
  ./scripts/real-chain-smoke.sh   # 先验 querycommitted + GetPlayer，再跑端到端冒烟
  ./scripts/seed-demo.sh          # 灌入演示数据（mock 模式）
EOF
