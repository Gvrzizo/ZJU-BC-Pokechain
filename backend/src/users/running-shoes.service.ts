import { Injectable } from '@nestjs/common';
import { sha256hex } from '../common/utils/crypto.util';
import { ContractService } from '../fabric/contract.service';
import { ChainIdentity, ItemState } from '../fabric/chain.types';
import { StarterService } from './starter.service';

/** 跑鞋 typeId（`game-data/items.data.ts`，kind='key'：非消耗品、不上架、不可回收）。 */
export const RUNNING_SHOES_TYPE_ID = 'running-shoes';

/** 按住 Shift 跑步的速度倍率（前端 `game/running.ts` 与 OverworldScene 共用这份口径）。 */
export const RUNNING_SPEED_MULTIPLIER = 2;

/** 跑鞋 ID 确定到玩家名：重复领取/中途重试都命中文档或幂等键，不会多发。 */
export function runningShoesItemId(playerId: string): string {
  return `i_running-shoes_${sha256hex(playerId).slice(0, 16)}`;
}

export interface RunningShoesClaimResult {
  /** 跑鞋堆叠（重复领取时返回已有的那一份） */
  item: ItemState;
  /** true = 本次领取；false = 之前已经领过（老账号同样能领，只是这里会给 false） */
  claimed: boolean;
  /** 跑步速度倍率（前端提示文案用） */
  speedMultiplier: number;
}

/**
 * 跑鞋领取（docs/backend-api.md §3「道具获取途径」）：一次性、幂等、新老账号都可领。
 *
 * 铸造复用新手礼包的固定 idemKey 机制（`starter-<playerId>-running-shoes`），
 * 道具 ID 由玩家名派生（`runningShoesItemId`），因此：
 * - 重复调用：先命中文档 → 直接返回已有堆叠（`claimed:false`，不报错）；
 * - 并发调用：两笔 MintItem 共用一个 idemKey → 第二笔拿回首笔结果，只铸一份。
 *
 * 跑鞋不参与任何链上校验（不能使用/消耗/回收），速度倍率在前端生效。
 */
@Injectable()
export class RunningShoesService {
  constructor(
    private readonly contract: ContractService,
    private readonly starters: StarterService,
  ) {}

  async claim(as: ChainIdentity): Promise<RunningShoesClaimResult> {
    const owned = await this.contract
      .queryItemsByOwner(as.userId)
      .then((items) => items.find((item) => item.typeId === RUNNING_SHOES_TYPE_ID) ?? null);
    if (owned) return { item: owned, claimed: false, speedMultiplier: RUNNING_SPEED_MULTIPLIER };

    const [item] = await this.starters.grantGift(
      as.userId,
      [{ typeId: RUNNING_SHOES_TYPE_ID, quantity: 1 }],
      () => runningShoesItemId(as.userId),
    );
    return {
      item,
      claimed: true,
      speedMultiplier: RUNNING_SPEED_MULTIPLIER,
    };
  }
}
