import { Logger } from '@nestjs/common';
import { sha256hex } from '../common/utils/crypto.util';
import { ContractService } from '../fabric/contract.service';
import { SYSTEM_IDENTITY } from '../fabric/chain.types';
import { ZONES } from '../game-data/encounter.data';

/**
 * H13：大师球的玩家侧来源——**传说图鉴 6/6**。
 *
 * 六个传说区（天空之柱/海底洞窟/熔岩洞窟/古代遗迹/南方孤岛/诞生之岛）各至少拥有一只
 * 池内传说（三神柱/双水都算同一区达成），即发放大师球 ×1。每人一次：
 * idemKey 固定 `legendary-dex-<playerId>`，重放/重复收服不会叠加。
 *
 * 触发点在两条铸造链路（快速捕捉 capture.service / 野怪战斗 wild.service）之后；
 * 失败只告警不抛出——捕捉主链路已上链，下一次收服会再尝试补偿（幂等）。
 */
const MASTER_BALL_TYPE_ID = 'master-ball';

export function legendaryDexItemId(playerId: string): string {
  return `i_dex_${playerId}`;
}

export async function grantLegendaryDexReward(
  contract: ContractService,
  playerId: string,
  logger?: Logger,
): Promise<boolean> {
  const owned = await contract.queryPokemonByOwner(playerId);
  const species = new Set(owned.map((p) => p.speciesId));
  const zones = ZONES.filter((zone) => zone.legendary === true);
  const completed = zones.every((zone) => (zone.poolSpeciesIds ?? []).some((id) => species.has(id)));
  if (!completed) return false;
  try {
    await contract.mintItem(
      SYSTEM_IDENTITY,
      {
        id: legendaryDexItemId(playerId),
        playerId,
        typeId: MASTER_BALL_TYPE_ID,
        quantity: 1,
        uri: `minio://assets/items/${MASTER_BALL_TYPE_ID}.png`,
        metadataHash: sha256hex(`legendary-dex|${playerId}`),
      },
      { idemKey: `legendary-dex-${playerId}` },
    );
    logger?.log(`legendary dex complete for ${playerId}: granted ${MASTER_BALL_TYPE_ID}`);
    return true;
  } catch (err) {
    logger?.warn(`legendary dex reward failed for ${playerId}: ${(err as Error).message}`);
    return false;
  }
}
