import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/utils/errors';
import { ContractService } from '../fabric/contract.service';
import { ItemState } from '../fabric/chain.types';
import { getItemType, ItemTypeDef } from '../game-data/items.data';
import { captureProbability } from './capture-derive';

/** 背包里每个可投球堆叠的当前成功率（前端球按钮百分比直接用它，避免前端复算漂移）。 */
export interface OwnedBallChance {
  itemId: string;
  typeId: string;
  name: string;
  nameZh: string;
  quantity: number;
  ballBonus: number;
  chance: number;
}

/**
 * 本人 IDLE 球堆叠的成功率列表（官方公式，按 HP 计算）。
 * 快速捕捉的降级路径等价于满血投球，传 `maxHp=1, hp=1`；野怪战斗传野怪当前 HP。
 */
export async function ownedBallChances(
  contract: ContractService,
  playerId: string,
  maxHp: number,
  hp: number,
  catchRate: number,
): Promise<OwnedBallChance[]> {
  const items = await contract.queryItemsByOwner(playerId).catch(() => []);
  return items
    .filter((i) => i.status === 'IDLE' && i.quantity > 0 && getItemType(i.typeId)?.kind === 'ball')
    .map((i) => {
      const type = getItemType(i.typeId)!;
      const bonus = type.ballBonus ?? 1;
      return {
        itemId: i.id,
        typeId: i.typeId,
        name: type.name,
        nameZh: type.nameZh,
        quantity: i.quantity,
        ballBonus: bonus,
        chance: captureProbability(maxHp, hp, catchRate, bonus),
      };
    })
    .sort((a, b) => a.ballBonus - b.ballBonus);
}

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
