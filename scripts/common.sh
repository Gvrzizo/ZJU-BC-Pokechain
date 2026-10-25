#!/usr/bin/env bash
# PokeChain —— 公共函数库，由 up.sh / deployCC.sh / down.sh / reset.sh source。
# 不要直接执行本文件。

# 注意：本文件会被 source，不能在此 set -euo pipefail 之外依赖调用方的 shell 选项；
# 各调用脚本均自行 set -euo pipefail。

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK_DIR="${ROOT_DIR}/network"
SCRIPTS_DIR="${ROOT_DIR}/scripts"
COMPOSE_FILE="${NETWORK_DIR}/docker-compose.yaml"
CHANNEL_NAME="gamechannel"
ORDERER_CA="${NETWORK_DIR}/organizations/ordererOrganizations/pokechain.com/orderers/orderer.pokechain.com/msp/tlscacerts/tlsca.pokechain.com-cert.pem"

stepln()  { printf '\n\033[1;36m========== %s ==========\033[0m\n' "$*"; }
infoln()  { printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
warnln()  { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
errorln() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; }
fatalln() { errorln "$*"; exit 1; }

# 将 network/bin 加入 PATH；peer CLI 读取 network/config/core.yaml（若存在）。
# configtxgen 需要另行指定 FABRIC_CFG_PATH=${NETWORK_DIR}（找 configtx.yaml）。
setupFabricEnv() {
  if [ -d "${NETWORK_DIR}/bin" ]; then
    export PATH="${NETWORK_DIR}/bin:${PATH}"
  fi
  if [ -d "${NETWORK_DIR}/config" ]; then
    export FABRIC_CFG_PATH="${NETWORK_DIR}/config"
  fi
}

# 切换 peer CLI 上下文到指定组织的 Admin 身份：switchOrg 1|2
switchOrg() {
  local org="${1:-}"
  setupFabricEnv
  export CORE_PEER_TLS_ENABLED=true
  case "${org}" in
    1)
      export CORE_PEER_LOCALMSPID="Org1MSP"
      export CORE_PEER_TLS_ROOTCERT_FILE="${NETWORK_DIR}/organizations/peerOrganizations/org1.pokechain.com/peers/peer0.org1.pokechain.com/tls/ca.crt"
      export CORE_PEER_MSPCONFIGPATH="${NETWORK_DIR}/organizations/peerOrganizations/org1.pokechain.com/users/Admin@org1.pokechain.com/msp"
      export CORE_PEER_ADDRESS=localhost:7051
      ;;
    2)
      export CORE_PEER_LOCALMSPID="Org2MSP"
      export CORE_PEER_TLS_ROOTCERT_FILE="${NETWORK_DIR}/organizations/peerOrganizations/org2.pokechain.com/peers/peer0.org2.pokechain.com/tls/ca.crt"
      export CORE_PEER_MSPCONFIGPATH="${NETWORK_DIR}/organizations/peerOrganizations/org2.pokechain.com/users/Admin@org2.pokechain.com/msp"
      export CORE_PEER_ADDRESS=localhost:9051
      ;;
    *)
      fatalln "switchOrg: 未知组织 '${org}'（仅支持 1|2）"
      ;;
  esac
  infoln "peer CLI 上下文：${CORE_PEER_LOCALMSPID} @ ${CORE_PEER_ADDRESS}"
}

# 清理 peer 启动的链码容器（dev-peer0.*），best-effort，不报错。
cleanupChaincodeContainers() {
  local cc_containers
  cc_containers=$(docker ps -a --format '{{.Names}}' | grep '^dev-peer0' || true)
  if [ -n "${cc_containers}" ]; then
    warnln "清理残留链码容器：${cc_containers}"
    echo "${cc_containers}" | xargs -r docker rm -f >/dev/null 2>&1 || true
  fi
  # ccaas 链码运行时（deployCC.sh 以 compose profile 启动，名字固定）
  if docker ps -a --format '{{.Names}}' | grep -qx 'pokechain-cc'; then
    warnln "清理 ccaas 链码容器：pokechain-cc"
    docker rm -f pokechain-cc >/dev/null 2>&1 || true
  fi
}
