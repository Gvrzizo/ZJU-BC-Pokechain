#!/usr/bin/env bash
# PokeChain —— 完全重置：down --purge → up → deployCC
# 删除 organizations/ 与 channel-artifacts/ 后从零重建网络并部署链码。
# network/bin 与 network/config（下载的二进制）保留。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

stepln "PokeChain 网络完全重置"
"${SCRIPTS_DIR}/down.sh" --purge
"${SCRIPTS_DIR}/up.sh"
"${SCRIPTS_DIR}/deployCC.sh"

stepln "重置完成"
infoln "网络与链码均已从零重建"
