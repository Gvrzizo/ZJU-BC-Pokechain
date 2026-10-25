#!/usr/bin/env bash
# PokeChain —— 一次性 enroll 链上服务身份（真链模式必需）
#
#   1) system   : CA 属性 role=system，后端 system 交易（Mint/ApplyGrowth/结算…）使用
#   2) opsadmin : CA 属性 role=admin，后端 admin 交易（GrantRole 等）使用（H20）
#
# 产物（只读挂载进 backend 容器）：
#   backend/.fabric-certs/system-cert.pem / system-key.pem
#   backend/.fabric-certs/admin-cert.pem  / admin-key.pem
#
# 幂等：证书已存在则跳过；CA 里已注册但 secret 不同则 enroll 401，脚本会明确提示
# 设置 FABRIC_SYSTEM_SECRET / FABRIC_ADMIN_SECRET 或手工重新注册，不会静默继续。
#
# 可用环境变量覆盖：
#   FABRIC_CA_URL          默认 https://localhost:7054
#   FABRIC_CA_NAME         默认 ca.org1.pokechain.com
#   FABRIC_SYSTEM_SECRET   默认 systempw
#   FABRIC_ADMIN_SECRET    默认 opsadminpw
#   FABRIC_CERT_STORE_DIR  默认 <repo>/backend/.fabric-certs
#   FORCE_ENROLL=1         忽略已有证书，强制重新 enroll（覆盖旧文件）

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

CA_URL="${FABRIC_CA_URL:-https://localhost:7054}"
CA_NAME="${FABRIC_CA_NAME:-ca.org1.pokechain.com}"
SYSTEM_SECRET="${FABRIC_SYSTEM_SECRET:-systempw}"
ADMIN_SECRET="${FABRIC_ADMIN_SECRET:-opsadminpw}"
CERT_DIR="${FABRIC_CERT_STORE_DIR:-${ROOT_DIR}/backend/.fabric-certs}"
CA_TLS="${NETWORK_DIR}/organizations/peerOrganizations/org1.pokechain.com/ca/ca.org1.pokechain.com-cert.pem"
CA_ADMIN_HOME="${CERT_DIR}/ca-admin"
FORCE_ENROLL="${FORCE_ENROLL:-0}"

setupFabricEnv
command -v fabric-ca-client >/dev/null 2>&1 || fatalln "找不到 fabric-ca-client（先运行 ./scripts/prereq.sh 下载 Fabric 2.5 二进制）"
[ -f "${CA_TLS}" ] || fatalln "CA 根证书不存在：${CA_TLS}（先运行 ./scripts/up.sh 生成网络）"

# enroll 之前先确认 CA 可达，避免把网络错误误报成密钥错误
if ! curl -sk --max-time 5 "${CA_URL}/cainfo" >/dev/null 2>&1; then
  fatalln "CA 不可达：${CA_URL}（先运行 ./scripts/up.sh / docker compose -f network/docker-compose.yaml up -d）"
fi

mkdir -p "${CERT_DIR}"
chmod 700 "${CERT_DIR}"

enrollCaAdmin() {
  # 每次重新 enroll 一份干净的 CA admin（旧 home 可能被后续 enroll 覆盖，见下方 key/cert 一致性检查）
  rm -rf "${CA_ADMIN_HOME}"
  export FABRIC_CA_CLIENT_HOME="${CA_ADMIN_HOME}"
  local adminId="${FABRIC_CA_ADMIN_ID:-admin}"
  local adminSecret="${FABRIC_CA_ADMIN_SECRET:-adminpw}"
  infoln "enroll CA 管理身份 ${adminId}（用于 register 服务身份）"
  local caHost="${CA_URL#https://}"
  caHost="${caHost#http://}"
  fabric-ca-client enroll -u "https://${adminId}:${adminSecret}@${caHost}" \
    --caname "${CA_NAME}" --tls.certfiles "${CA_TLS}" >/dev/null 2>&1 \
    || fatalln "CA 管理身份 enroll 失败（检查 FABRIC_CA_ADMIN_ID/SECRET 与 ${CA_URL}）"
}

# ensureServiceId <name> <secret> <role>
ensureServiceId() {
  local name="$1" secret="$2" role="$3"
  local prefix="$name"
  [ "${name}" = "opsadmin" ] && prefix="admin"

  if [ "${FORCE_ENROLL}" != "1" ] && [ -f "${CERT_DIR}/${prefix}-cert.pem" ] && [ -f "${CERT_DIR}/${prefix}-key.pem" ]; then
    infoln "${prefix} 身份已存在（${CERT_DIR}/${prefix}-cert.pem），跳过 enroll"
    return 0
  fi

  enrollCaAdmin

  # 已注册时 CA 返回 "identity already registered"；secret 未变时继续 enroll。
  export FABRIC_CA_CLIENT_HOME="${CA_ADMIN_HOME}"
  local registerLog
  registerLog="$(mktemp)"
  if ! fabric-ca-client register \
      --id.name "${name}" --id.secret "${secret}" --id.affiliation org1.department1 \
      --id.attrs "role=${role}:ecert" --caname "${CA_NAME}" \
      --tls.certfiles "${CA_TLS}" >"${registerLog}" 2>&1; then
    if grep -qi 'already registered' "${registerLog}"; then
      warnln "${name} 已在 CA 注册，尝试用现有 secret 继续 enroll（secret 不同会 401）"
    else
      cat "${registerLog}" >&2
      rm -f "${registerLog}"
      fatalln "${name} 注册失败（见上）"
    fi
  fi
  rm -f "${registerLog}"

  # 服务身份用自己的 client home：绝不能复用 ca-admin（否则 enroll 会覆盖 CA admin 的证书/私钥）
  local home="${CERT_DIR}/ca-${name}"
  rm -rf "${home}"
  export FABRIC_CA_CLIENT_HOME="${home}"
  local caHost="${CA_URL#https://}"
  caHost="${caHost#http://}"
  local enrollLog
  enrollLog="$(mktemp)"
  if ! fabric-ca-client enroll -u "https://${name}:${secret}@${caHost}" \
      --caname "${CA_NAME}" --tls.certfiles "${CA_TLS}" >"${enrollLog}" 2>&1; then
    cat "${enrollLog}" >&2
    rm -f "${enrollLog}"
    fatalln "enroll ${name} 失败。若 CA 中该身份是用不同 secret 注册的，请设置 FABRIC_SYSTEM_SECRET / FABRIC_ADMIN_SECRET，或先删除 CA 身份后重跑；不要静默继续。"
  fi
  rm -f "${enrollLog}"

  cp "${home}/msp/signcerts/cert.pem" "${CERT_DIR}/${prefix}-cert.pem"
  local skFile
  skFile="$(find "${home}/msp/keystore" -name '*_sk' -type f | head -n1)"
  [ -n "${skFile}" ] || fatalln "enroll ${name} 后找不到私钥（${home}/msp/keystore/*_sk）"
  cp "${skFile}" "${CERT_DIR}/${prefix}-key.pem"
  chmod 600 "${CERT_DIR}/${prefix}-key.pem"

  # 防止 C4 事故重现：拷贝的私钥必须与证书公钥匹配（否则 peer 报 "The signature is invalid"）
  local certPub keyPub
  certPub="$(openssl x509 -in "${CERT_DIR}/${prefix}-cert.pem" -noout -pubkey | openssl pkey -pubin -outform DER 2>/dev/null | openssl dgst -sha256)"
  keyPub="$(openssl pkey -in "${CERT_DIR}/${prefix}-key.pem" -pubout -outform DER 2>/dev/null | openssl dgst -sha256)"
  [ -n "${certPub}" ] && [ "${certPub}" = "${keyPub}" ] \
    || fatalln "${prefix} 的证书与私钥不匹配（${CERT_DIR}/${prefix}-*.pem）；删除后重跑本脚本"
  infoln "已写入 ${CERT_DIR}/${prefix}-cert.pem 与 ${prefix}-key.pem（role=${role}，证书/私钥匹配校验通过）"
}

ensureServiceId system "${SYSTEM_SECRET}" system
ensureServiceId opsadmin "${ADMIN_SECRET}" admin

stepln "服务身份就绪"
cat <<EOF
证书目录：${CERT_DIR}
  system-cert.pem / system-key.pem     （role=system）
  admin-cert.pem  / admin-key.pem      （role=admin，enrollmentID=opsadmin）

后端真链配置（容器内路径不同）：
  FABRIC_CERT_STORE_DIR=${CERT_DIR}            # 本机
  FABRIC_CERT_STORE_DIR=/app/.fabric-certs    # docker compose 真链覆盖文件
EOF
