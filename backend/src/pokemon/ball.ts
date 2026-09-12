import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/utils/errors';
import { ContractService } from '../fabric/contract.service';
import { ItemState } from '../fabric/chain.types';
import { getItemType, ItemTypeDef } from '../game-data/items.data';

export interface ResolvedBall {
  item: ItemState;
  type: ItemTypeDef;
  /** 球倍率（精灵球 1 / 超级球 1.5 / 高级球 2 / 大师球 255） */
  bonus: number;
}

/** 投球前置校验：归属 → 类型是球 → 有库存。快速捕捉与野怪战斗共用同一套错误码。 */
export async function resolveOwnedBall(
  contract: ContractService,
  playerId: string,
  ballItemId: string,
): Promise<ResolvedBall> {
  const item = await contract.getItem(ballItemId).catch(() => null);
  if (!item || item.ownerId !== playerId) {
    throw new AppException('NOT_OWNER', `ball ${ballItemId} is not owned by you`, HttpStatus.FORBIDDEN);
  }
  const type = getItemType(item.typeId);
  if (!type || type.kind !== 'ball') {
    throw new AppException('NOT_A_BALL', `item type ${item.typeId} cannot be used for capture`, HttpStatus.BAD_REQUEST);
  }
  if (item.quantity <= 0) {
    throw new AppException('INSUFFICIENT_QUANTITY', `no ${item.typeId} left`, HttpStatus.BAD_REQUEST);
  }
  return { item, type, bonus: type.ballBonus ?? 1 };
}
