#!/usr/bin/env bash
# PokeChain —— 一键启动 Fabric 2.5 双组织测试网络
# 流程：prereq → cryptogen → configtxgen → compose up → 等就绪 →
#       创建 gamechannel → 两组织 peer 加入 → 锚节点 → 完成提示
# 幂等：已生成的证书/通道不会重建；已加入的 peer 不会重复 join。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

# ---------------------------------------------------------------- 函数定义

waitForPeer() {
  local org="$1" n=0
  switchOrg "${org}"
  until peer channel list >/dev/null 2>&1; do
    n=$((n + 1))
    [ "${n}" -ge 30 ] && fatalln "Org${org} peer 未在预期时间内就绪，请查看：docker logs peer0.org${org}.pokechain.com"
    infoln "等待 Org${org} peer 就绪（${n}/30）..."
    sleep 2
  done
  infoln "Org${org} peer 已就绪"
}

createChannel() {
  switchOrg 1
  if peer channel list 2>/dev/null | grep -qw "${CHANNEL_NAME}"; then
    infoln "通道 ${CHANNEL_NAME} 已存在，跳过创建"
    return 0
  fi
  local n=0
  # orderer 可能尚未就绪，重试直到成功
  until peer channel create \
      -o localhost:7050 --ordererTLSHostnameOverride orderer.pokechain.com \
      -c "${CHANNEL_NAME}" \
      -f "${NETWORK_DIR}/channel-artifacts/${CHANNEL_NAME}.tx" \
      --outputBlock "${NETWORK_DIR}/channel-artifacts/${CHANNEL_NAME}.block" \
      --tls --cafile "${ORDERER_CA}" >/dev/null 2>&1; do
    n=$((n + 1))
    [ "${n}" -ge 30 ] && fatalln "创建通道 ${CHANNEL_NAME} 失败（orderer 未就绪？docker logs orderer.pokechain.com）"
    infoln "创建通道重试中（${n}/30）..."
    sleep 2
  done
  infoln "通道 ${CHANNEL_NAME} 已创建"
}

joinChannel() {
  local org="$1"
  switchOrg "${org}"
  if peer channel list 2>/dev/null | grep -qw "${CHANNEL_NAME}"; then
    infoln "Org${org} peer 已在通道中，跳过 join"
    return 0
  fi
  local n=0
  until peer channel join -b "${NETWORK_DIR}/channel-artifacts/${CHANNEL_NAME}.block" >/dev/null 2>&1; do
    n=$((n + 1))
    [ "${n}" -ge 15 ] && fatalln "Org${org} peer 加入通道失败"
    infoln "Org${org} join 重试中（${n}/15）..."
    sleep 2
  done
  infoln "Org${org} peer 已加入通道 ${CHANNEL_NAME}"
}

# 幂等设置锚节点：若通道配置中已是期望值则跳过，否则走 configtxlator 更新流程
updateAnchorPeer() {
  local org="$1" msp host port
  if [ "${org}" = "1" ]; then
    msp="Org1MSP"; host="peer0.org1.pokechain.com"; port=7051
  else
    msp="Org2MSP"; host="peer0.org2.pokechain.com"; port=9051
  fi
  switchOrg "${org}"

  local work n=0
  work="$(mktemp -d)"
  until peer channel fetch config "${work}/config_block.pb" \
      -o localhost:7050 --ordererTLSHostnameOverride orderer.pokechain.com \
      -c "${CHANNEL_NAME}" --tls --cafile "${ORDERER_CA}" >/dev/null 2>&1; do
    n=$((n + 1))
    [ "${n}" -ge 15 ] && fatalln "Org${org} 拉取通道配置失败"
    sleep 2
  done

  (cd "${work}" && configtxlator proto_decode --input config_block.pb --type common.Block --output config_block.json)
  jq '.data.data[0].payload.data.config' "${work}/config_block.json" > "${work}/config.json"

  if jq -e "[.channel_group.groups.Application.groups.${msp}.values.AnchorPeers.value.anchor_peers[]? | select(.host==\"${host}\" and .port==${port})] | length > 0" "${work}/config.json" >/dev/null; then
    infoln "Org${org} 锚节点已是 ${host}:${port}（随通道创建配置生效），跳过更新"
    rm -rf "${work}"
    return 0
  fi

  jq ".channel_group.groups.Application.groups.${msp}.values += {\"AnchorPeers\":{\"mod_policy\":\"Admins\",\"value\":{\"anchor_peers\":[{\"host\":\"${host}\",\"port\":${port}}]},\"version\":\"0\"}}" \
    "${work}/config.json" > "${work}/modified_config.json"

  (
    cd "${work}"
    configtxlator proto_encode --input config.json --type common.Config --output config.pb
    configtxlator proto_encode --input modified_config.json --type common.Config --output modified_config.pb
    configtxlator compute_update --channel_id "${CHANNEL_NAME}" --original config.pb --updated modified_config.pb --output config_update.pb
    configtxlator proto_decode --input config_update.pb --type common.ConfigUpdate --output config_update.json
  )
  echo "{\"payload\":{\"header\":{\"channel_header\":{\"channel_id\":\"${CHANNEL_NAME}\",\"type\":2}},\"data\":{\"config_update\":$(cat "${work}/config_update.json")}}}" \
    | jq . > "${work}/config_update_in_envelope.json"
  (cd "${work}" && configtxlator proto_encode --input config_update_in_envelope.json --type common.Envelope --output config_update_in_envelope.pb)

  peer channel update -f "${work}/config_update_in_envelope.pb" -c "${CHANNEL_NAME}" \
    -o localhost:7050 --ordererTLSHostnameOverride orderer.pokechain.com \
    --tls --cafile "${ORDERER_CA}" >/dev/null
  rm -rf "${work}"
  infoln "Org${org} 锚节点已更新为 ${host}:${port}"
}

# ---------------------------------------------------------------- 主流程

stepln "步骤 1/7 环境前置检查"
"${SCRIPTS_DIR}/prereq.sh"
setupFabricEnv

stepln "步骤 2/7 生成组织加密材料（cryptogen）"
if [ -d "${NETWORK_DIR}/organizations/peerOrganizations" ]; then
  infoln "network/organizations 已存在，跳过 cryptogen（如需重建请运行 scripts/reset.sh）"
else
  (
    cd "${NETWORK_DIR}"
    cryptogen generate --config=crypto-config-orderer.yaml --output=organizations
    cryptogen generate --config=crypto-config-org1.yaml --output=organizations
    cryptogen generate --config=crypto-config-org2.yaml --output=organizations
  )
  infoln "加密材料已生成到 network/organizations"
fi
# CA 容器需要固定文件名的 CA 私钥（cryptogen 生成的是 <hex>_sk）
for o in org1 org2; do
  caDir="${NETWORK_DIR}/organizations/peerOrganizations/${o}.pokechain.com/ca"
  if [ -d "${caDir}" ] && [ ! -f "${caDir}/priv_sk" ]; then
    cp "${caDir}"/*_sk "${caDir}/priv_sk"
    infoln "已复制 ${o} CA 私钥为 ca/priv_sk"
  fi
done
mkdir -p "${NETWORK_DIR}/organizations/fabric-ca/org1" "${NETWORK_DIR}/organizations/fabric-ca/org2"

stepln "步骤 3/7 生成创世块与通道交易（configtxgen）"
mkdir -p "${NETWORK_DIR}/channel-artifacts"
if [ -f "${NETWORK_DIR}/channel-artifacts/genesis.block" ] && [ -f "${NETWORK_DIR}/channel-artifacts/${CHANNEL_NAME}.tx" ]; then
  infoln "channel-artifacts 已存在，跳过 configtxgen"
else
  FABRIC_CFG_PATH="${NETWORK_DIR}" configtxgen \
    -profile TwoOrgsOrdererGenesis -channelID system-channel \
    -outputBlock "${NETWORK_DIR}/channel-artifacts/genesis.block"
  FABRIC_CFG_PATH="${NETWORK_DIR}" configtxgen \
    -profile TwoOrgsChannel -channelID "${CHANNEL_NAME}" \
    -outputCreateChannelTx "${NETWORK_DIR}/channel-artifacts/${CHANNEL_NAME}.tx"
  infoln "已生成 genesis.block 与 ${CHANNEL_NAME}.tx"
fi

stepln "步骤 4/7 启动网络（docker compose）"
cleanupChaincodeContainers
docker compose -f "${COMPOSE_FILE}" up -d

stepln "步骤 5/7 等待 orderer 与 peer 就绪"
waitForPeer 1
waitForPeer 2

stepln "步骤 6/7 创建通道并加入 peer"
createChannel
joinChannel 1
joinChannel 2

stepln "步骤 7/7 设置两组织锚节点"
updateAnchorPeer 1
updateAnchorPeer 2

stepln "网络启动完成"
cat <<EOF
拓扑：orderer.pokechain.com:7050 (Raft 单节点)
      peer0.org1.pokechain.com:7051 + couchdb0 + ca.org1:7054
      peer0.org2.pokechain.com:9051 + couchdb1 + ca.org2:8054
通道：${CHANNEL_NAME}

下一步：
  ./scripts/deployCC.sh    部署 pokemoncc 链码
  ./scripts/down.sh        停止网络（-v 清数据卷，保留 organizations）
  ./scripts/reset.sh       全部清理后重建并部署链码
EOF
