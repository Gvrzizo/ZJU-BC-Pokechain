import { Module } from '@nestjs/common';
import { FabricModule } from '../fabric/fabric.module';
import { BondService } from './bond.service';

/**
 * 羁绊挂钩（docs/backend-api.md §11）：PvP 结算与野怪收服的 BondUp 发放、
 * 每日每宠上限记账。Wild 与 Ranked 都直接依赖本模块，不再经由 RankedModule 中转。
 */
@Module({
  imports: [FabricModule],
  providers: [BondService],
  exports: [BondService],
})
export class BondModule {}
