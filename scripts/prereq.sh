#!/usr/bin/env bash
# PokeChain —— 环境前置检查
# 1) 检查 docker / docker compose v2 / curl / jq
# 2) 若 network/bin 缺少 cryptogen/configtxgen/configtxlator/peer，
#    用官方 install-fabric.sh 下载到 network/bin（同时产生 network/config）。
# 环境变量：
#   FABRIC_VERSION           Fabric 二进制版本（默认 2.5.9，与 compose 镜像一致）
#   CA_VERSION               Fabric CA 版本（默认 1.5.12）
#   FABRIC_INSTALL_BINARIES  设为 off 时跳过二进制下载（需自行保证二进制在 PATH 上）

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

FABRIC_VERSION="${FABRIC_VERSION:-2.5.9}"
CA_VERSION="${CA_VERSION:-1.5.12}"
REQUIRED_BINS=(cryptogen configtxgen configtxlator peer)

stepln "步骤 1/3 检查 Docker 环境"
command -v docker >/dev/null 2>&1 || fatalln "未找到 docker，请先安装 Docker Engine"
docker info >/dev/null 2>&1 || fatalln "Docker 守护进程未运行（或当前用户无权限，试试 sudo / 加入 docker 组）"
docker compose version >/dev/null 2>&1 || fatalln "未找到 docker compose v2（请安装 Docker Compose 插件）"
infoln "$(docker --version)"
infoln "$(docker compose version)"

stepln "步骤 2/3 检查宿主机工具（curl / jq）"
command -v curl >/dev/null 2>&1 || fatalln "未找到 curl"
command -v jq >/dev/null 2>&1 || fatalln "未找到 jq（锚节点配置更新依赖 jq，请安装：sudo apt install jq）"
infoln "curl / jq 可用"

stepln "步骤 3/3 检查 Fabric 二进制（${REQUIRED_BINS[*]}，要求 ${FABRIC_VERSION%.*}.x）"
setupFabricEnv

# 二进制存在且大版本.小版本与 FABRIC_VERSION 一致（如 2.5）才算可用：
# PATH 上可能存在其他项目的旧版 Fabric 二进制（如 2.4.x，不支持 Application V2_5）。
bin_ok() {
  local b="$1" v
  command -v "${b}" >/dev/null 2>&1 || return 1
  v="$("${b}" version 2>/dev/null | sed -n 's/^ *Version: //p' | head -n1)"
  [ -n "${v}" ] || v="$("${b}" --version 2>/dev/null | sed -n 's/^ *Version: //p' | head -n1)"
  [ -n "${v}" ] || return 1
  [ "${v%.*}" = "${FABRIC_VERSION%.*}" ]
}

missing=()
for b in "${REQUIRED_BINS[@]}"; do
  bin_ok "${b}" || missing+=("${b}")
done

if [ "${#missing[@]}" -eq 0 ]; then
  infoln "全部二进制就绪：$(command -v cryptogen)（$(peer version | sed -n 's/^ *Version: //p' | head -n1)）"
  exit 0
fi

if [ "${FABRIC_INSTALL_BINARIES:-on}" = "off" ]; then
  fatalln "缺少或版本不符（需 ${FABRIC_VERSION%.*}.x）：${missing[*]}，且 FABRIC_INSTALL_BINARIES=off 禁止自动下载。
请手动将 Fabric ${FABRIC_VERSION} 的 bin/ 放到 network/bin/ 或加入 PATH 最前（注意 PATH 上可能存在其他项目的旧版 Fabric 二进制）。"
fi

infoln "缺少或版本不符（需 ${FABRIC_VERSION%.*}.x）：${missing[*]}，使用官方 install-fabric.sh 下载 Fabric ${FABRIC_VERSION} 二进制到 network/bin ..."
(
  cd "${NETWORK_DIR}"
  if [ ! -f install-fabric.sh ]; then
    curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
    chmod +x install-fabric.sh
  fi
  ./install-fabric.sh --fabric-version "${FABRIC_VERSION}" --ca-version "${CA_VERSION}" binary
)

for b in "${REQUIRED_BINS[@]}"; do
  [ -x "${NETWORK_DIR}/bin/${b}" ] || fatalln "下载后仍缺少 ${NETWORK_DIR}/bin/${b}，请检查网络/GitHub 可达性（可设 FABRIC_INSTALL_BINARIES=off 后手动安装）"
done
infoln "Fabric 二进制下载完成：$("${NETWORK_DIR}/bin/peer" version --output json 2>/dev/null | jq -r .Version 2>/dev/null || echo ok)"
