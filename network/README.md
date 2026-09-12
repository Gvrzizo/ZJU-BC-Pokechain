# PokeChain Fabric 2.5 测试网络

双组织测试网络：Org1（游戏运营商）+ Org2（仲裁方），单节点 Raft orderer，CouchDB 状态库，通道 `gamechannel`。节点证书由 **cryptogen** 生成；两个 **Fabric CA 仅用于用户身份的注册/enroll**（后端注册用户钱包用），CA 的签名密钥复用 cryptogen 生成的组织 CA。

## 拓扑与端口

| 容器 | 宿主机端口 | 容器网络内地址 | 说明 |
|---|---|---|---|
| orderer.pokechain.com | 7050 | orderer.pokechain.com:7050 | 单节点 etcdraft（课程简化） |
| peer0.org1.pokechain.com | 7051 | peer0.org1.pokechain.com:7051 | Org1 peer，链码端口 7052（仅容器内） |
| peer0.org2.pokechain.com | 9051 | peer0.org2.pokechain.com:9051 | Org2 peer，链码端口 9052（仅容器内） |
| ca.org1.pokechain.com | 7054 | ca.org1.pokechain.com:7054 | Org1 用户 CA（admin/adminpw） |
| ca.org2.pokechain.com | 8054 | ca.org2.pokechain.com:8054 | Org2 用户 CA（admin/adminpw） |
| couchdb0 | 不暴露 | couchdb0:5984 | Org1 状态库（admin/adminpw，仅容器网络内） |
| couchdb1 | 不暴露 | couchdb1:5984 | Org2 状态库（同上） |

容器间互联一律使用容器名；宿主机工具（peer CLI、后端）用 `localhost:端口`。所有节点 TLS 证书均带 `localhost`/`127.0.0.1` SAN（见 crypto-config-*.yaml 的 `SANS`），因此宿主机直连不会报 x509 主机名错误。

## 依赖

- Docker Engine + Docker Compose v2（`docker compose version`）
- `curl`、`jq`
- Fabric 二进制（cryptogen/configtxgen/configtxlator/peer）：首次运行 `scripts/up.sh` 时自动下载到 `network/bin`（版本可用 `FABRIC_VERSION`/`CA_VERSION` 覆盖，默认 2.5.9 / 1.5.12，与 compose 镜像一致）

## 启动 / 停止

```bash
./scripts/up.sh          # 一键：检查依赖→生成证书→创世块→起容器→建通道→锚节点
./scripts/deployCC.sh    # 部署 chaincode/pokemon-cc（label pokemoncc_1.0，sequence 1）
./scripts/down.sh        # 停止并清数据卷，保留 organizations/ 证书
./scripts/down.sh --purge  # 连证书与通道产物一起删
./scripts/reset.sh       # --purge 后重新 up + deployCC
```

脚本幂等：重复运行 `up.sh`/`deployCC.sh` 不会重复建通道或重复提交链码。

## 目录结构

```
network/
├── crypto-config-orderer.yaml   # cryptogen：orderer 组织（Domain pokechain.com）
├── crypto-config-org1.yaml      # cryptogen：Org1（peer0 + Admin + User1）
├── crypto-config-org2.yaml      # cryptogen：Org2
├── configtx.yaml                # TwoOrgsOrdererGenesis / TwoOrgsChannel（App capabilities V2_5）
├── docker-compose.yaml          # 独立 compose（name: pokechain，网络 pokechain_net）
├── connection-profile-org1.json # 后端 fabric-gateway 连接模板（Org1）
├── connection-profile-org2.json # 后端连接模板（Org2，仲裁方）
├── bin/ config/                 # install-fabric.sh 下载的二进制与配置（首次 up 时生成）
├── install-fabric.sh            # 官方下载脚本（首次 up 时下载）
├── organizations/               # cryptogen 输出（首次 up 时生成）
│   ├── ordererOrganizations/pokechain.com/...
│   ├── peerOrganizations/org1.pokechain.com/
│   │   ├── ca/                  # 组织 CA（priv_sk 为 *_sk 的复制，供 CA 容器挂载）
│   │   ├── msp/ peers/ users/ tlsca/
│   ├── peerOrganizations/org2.pokechain.com/...
│   └── fabric-ca/org1|org2/     # CA 服务数据（含 CA 自签 TLS 证书 tls-cert.pem）
└── channel-artifacts/           # genesis.block、gamechannel.tx、gamechannel.block、链码包
```

`bin/`、`config/`、`organizations/`、`channel-artifacts/`、`install-fabric.sh` 均为生成物，不要提交 git（见根 `.gitignore`）。

## 后端如何连接

以 Org1 为例（`connection-profile-org1.json`，路径相对仓库根目录）：

- peer：`grpcs://localhost:7051`，TLS CA cert = `organizations/peerOrganizations/org1.pokechain.com/peers/peer0.org1.pokechain.com/tls/ca.crt`，SNI/hostname override = `peer0.org1.pokechain.com`（证书 SAN 也含 localhost，二者皆可）
- mspId：`Org1MSP`；管理员身份在 `organizations/peerOrganizations/org1.pokechain.com/users/Admin@org1.pokechain.com/msp`
- 注册用户：`https://localhost:7054`，caName `ca.org1.pokechain.com`，TLS cert = `organizations/fabric-ca/org1/tls-cert.pem`，bootstrap registrar `admin/adminpw`；注册时用 `--id.attrs role=xxx:ecert` 之类的属性写入 ecert，链码用 `getAttrValue('role')` 读取（见 `docs/chaincode-api.md`）

Org2 同理（peer 9051、CA 8054、`Org2MSP`）。

## 进入 peer CLI 调试

方式一：宿主机直接用下载的 peer 二进制（推荐）：

```bash
source scripts/common.sh   # 或直接 export 下列变量
switchOrg 1                # 切到 Org1 Admin；switchOrg 2 切 Org2
peer channel list
peer lifecycle chaincode querycommitted -C gamechannel
peer chaincode query -C gamechannel -n pokemoncc \
  -c '{"Args":["PlayerContract:GetPlayer","u_xxx"]}'
```

方式二：进容器：

```bash
docker exec -it peer0.org1.pokechain.com bash
peer channel list
```

看日志：`docker logs -f orderer.pokechain.com` / `peer0.org1.pokechain.com` / 链码容器 `docker ps --filter name=dev-`。
CouchDB 不暴露宿主机端口，查看数据用：`docker exec couchdb0 curl -s admin:adminpw@localhost:5984/gamechannel\_pokemoncc/_all_docs`。

## 常见问题

**二进制下载失败（GitHub 被墙/超时）**
`FABRIC_INSTALL_BINARIES=off ./scripts/up.sh` 跳过自动下载，然后自行把 Fabric 2.5.9 的 `bin/`（含 cryptogen/configtxgen/configtxlator/peer）放到 `network/bin/`（或加入 PATH），把 `config/`（含 core.yaml）放到 `network/config/`。也可以换版本：`FABRIC_VERSION=2.5.9 CA_VERSION=1.5.12 ./scripts/prereq.sh`。

**x509: certificate is valid for ... not localhost**
说明证书是旧配置生成的（无 localhost SAN）。`./scripts/down.sh --purge && ./scripts/up.sh` 重建即可；不要在生产环境这么干。

**CA 容器启动失败 / enroll 不受信**
CA 签名密钥来自 `organizations/peerOrganizations/orgN.pokechain.com/ca/priv_sk`（up.sh 自动从 `*_sk` 复制）。若手工改过证书，删除 `organizations/fabric-ca/` 与该文件后重跑 up.sh。

**approveformyorg 报 "redefine uncommitted approved chaincode"**
说明该组织已批准过同 sequence 的定义。deployCC.sh 对此幂等跳过；若要升级链码，需递增 `CC_VERSION`/`CC_SEQUENCE` 后重跑（脚本内常量，按需修改）。

**端口被占用（7050/7051/7054/8054/9051）**
`sudo lsof -i :7051` 找到占用进程；或先 `./scripts/down.sh` 清理上次未停干净的网络。

**链码容器/镜像残留**
`down.sh` 已 best-effort 清理 `dev-peer0.*` 容器与镜像；顽固残留可 `docker ps -a --filter name=dev-`、`docker images 'dev-peer0*'` 手动删除。

**peer CLI 报 "no configuration found" / 找不到 core.yaml**
脚本会自动 `export FABRIC_CFG_PATH=network/config`（二进制下载自带）。若用了自备二进制而没有 network/config，请自行准备 core.yaml 或保持 `FABRIC_CFG_PATH` 指向正确目录。

**CouchDB 索引未生效**
索引文件必须位于链码源码的 `META-INF/statedb/couchdb/indexes/`，打包时自动带入（见 `docs/chaincode-api.md` 第 3 节）。安装后可查：`docker exec couchdb0 curl -s admin:adminpw@localhost:5984/gamechannel\_pokemoncc/_index`。
