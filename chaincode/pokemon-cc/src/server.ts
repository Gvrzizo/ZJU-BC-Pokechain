/**
 * chaincode-as-a-service (ccaas) entrypoint.
 *
 * Fabric 2.5 的默认 Docker builder 在 Docker 28/29 上会报
 * `write unix @->/run/docker.sock: broken pipe`（见 docs/remediation-guide-2026-10-25.md C4d），
 * 因此 Docker 较新时 deployCC.sh 改用 ccaas：peer 通过 connection.json 里的
 * `pokechain-cc:19999` 直连本进程，本进程用 CCID（= 链码 Package ID）向 peer 注册。
 *
 * 本文件不参与链码逻辑与单元测试，只在 ccaas 容器里运行。
 */
import { JSONSerializer } from 'fabric-contract-api';
import { contracts } from './index';

/* eslint-disable @typescript-eslint/no-var-requires */
// Bootstrap 是 CommonJS 默认导出（module.exports = Bootstrap），不能解构
const Bootstrap = require('fabric-shim/lib/contract-spi/bootstrap');

const ccid = process.env.CCID || process.env.CHAINCODE_ID || '';
const address = process.env.CHAINCODE_ADDRESS || '0.0.0.0:19999';

if (!ccid) {
  // 没有 CCID 时 peer 会拒绝注册；直接退出并让 compose 重启，避免容器看起来“健康”却不可用。
  console.error('[pokemoncc] CCID/CHAINCODE_ID is required in ccaas mode');
  process.exit(1);
}

const serializers = {
  transaction: 'jsonSerializer',
  serializers: { jsonSerializer: JSONSerializer },
};

Bootstrap.register(contracts, serializers, {}, 'pokemoncc', '1.0.0', { ccid, address }, true).catch(
  (err: Error) => {
    console.error(`[pokemoncc] chaincode server failed: ${err.message}`);
    process.exit(1);
  },
);

console.log(`[pokemoncc] ccaas chaincode server listening on ${address} (ccid=${ccid})`);
