#!/usr/bin/env bash
# PokeChain —— 停止并清理 Fabric 网络
# 默认：compose down -v（删除容器与数据卷），保留 organizations/ 与 channel-artifacts/
# 用法：
#   ./scripts/down.sh            停止网络，保留加密材料与通道产物
#   ./scripts/down.sh --purge    额外删除 organizations/ 与 channel-artifacts/（完全重置）

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

PURGE=0
for arg in "$@"; do
  case "${arg}" in
    --purge) PURGE=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fatalln "未知参数：${arg}（支持 --purge）" ;;
  esac
done

stepln "步骤 1/2 停止并清理网络容器与数据卷"
cleanupChaincodeContainers
if [ -f "${COMPOSE_FILE}" ]; then
  docker compose -f "${COMPOSE_FILE}" down -v --remove-orphans
else
  warnln "未找到 ${COMPOSE_FILE}，跳过 compose down"
fi

# ccaas 链码运行时（compose profile 服务；down 通常已移除，best-effort 兜底）
docker rm -f pokechain-cc >/dev/null 2>&1 || true
# 清理链码镜像（peer 构建的 dev-peer0.* 镜像），best-effort
cc_images=$(docker images --format '{{.Repository}}' | grep '^dev-peer0' || true)
if [ -n "${cc_images}" ]; then
  warnln "清理链码镜像：$(echo "${cc_images}" | tr '\n' ' ')"
  echo "${cc_images}" | xargs -r docker rmi -f >/dev/null 2>&1 || true
fi

if [ "${PURGE}" -eq 1 ]; then
  stepln "步骤 2/2 删除 organizations 与 channel-artifacts"
  rm -rf "${NETWORK_DIR}/organizations" "${NETWORK_DIR}/channel-artifacts"
  infoln "已删除（network/bin 与 network/config 保留，避免重复下载）"
else
  stepln "步骤 2/2 保留加密材料"
  infoln "organizations/ 与 channel-artifacts/ 已保留（加 --purge 可一并删除）"
fi

infoln "网络已停止"
