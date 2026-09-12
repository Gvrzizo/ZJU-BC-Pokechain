import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { ContractService } from '../fabric/contract.service';
import { SYSTEM_IDENTITY } from '../fabric/chain.types';
import { BondChange } from './ranked.types';
import { utcDate } from './bot';
import {
  bondBatches,
  bondDailyAllowance,
  bondDailyKey,
  BOND_DAILY_TTL_SEC,
  pvpBondGrants,
  BondSide,
  WildBondKind,
  wildBondDelta,
  wildBondIdemKey,
  wildBondReason,
} from './bond';

export interface PvpBondInput {
  battleId: string;
  playerA: string;
  playerB: string;
  teamA: string[];
  teamB: string[];
  /** 链上 result.winnerId：玩家 id 或 'DRAW' */
  winnerId: string;
}

/** 野怪战斗的羁绊提升结果（不是 PvP 的胜负语义，故不复用 BondChange）。 */
export interface WildBondGrant {
  pokemonId: string;
  speciesId: number;
  name: string;
  kind: WildBondKind;
  before: number;
  after: number;
  delta: number;
}

/**
 * PvP 羁绊挂钩（docs/backend-api.md §11）：对局链上 SETTLED 后给双方参战队伍加羁绊。
 *
 * 长线化口径：赢家队 +2、输家队 +1（机器人场 ×0.5 向下取整），且**每日每宠上限 +6**
 * （`bond:day:<pokemonId>:<date>`，超出截断）。幂等由固定 idemKey 保证：同一天重放同一场
 * 既不会重复加分，也不会重复占用当日额度。
 */
@Injectable()
export class BondService {
  private readonly logger = new Logger(BondService.name);

  constructor(
    private readonly contract: ContractService,
    private readonly redis: RedisService,
  ) {}

  async grantPvpBond(input: PvpBondInput, opts: { scale?: number } = {}): Promise<BondChange[]> {
    const winnerSide: BondSide | null =
      input.winnerId === input.playerA ? 'A' : input.winnerId === input.playerB ? 'B' : null;
    const teamIds = [...input.teamA, ...input.teamB];
    if (teamIds.length === 0) return [];

    // 先取提升前的链上快照：既用于明细展示，也用来跳过已易主/已放生的宝可梦
    const before = new Map<string, { bond: number; ownerId: string; status: string }>();
    for (const id of teamIds) {
      const pokemon = await this.contract.getPokemon(id).catch(() => null);
      if (pokemon) before.set(id, { bond: pokemon.bond, ownerId: pokemon.ownerId, status: pokemon.status });
    }

    const grants = pvpBondGrants(input.battleId, { A: input.teamA, B: input.teamB }, winnerSide, opts);
    const date = utcDate();
    const changes: BondChange[] = [];
    for (const grant of grants) {
      const owner = grant.side === 'A' ? input.playerA : input.playerB;
      // 押注易主的宝可梦不再算"参战队伍"：链上易主已把 bond 重置为 30
      const eligible = grant.pokemonIds.filter((id) => {
        const snapshot = before.get(id);
        return !!snapshot && snapshot.ownerId === owner && snapshot.status !== 'RELEASED';
      });
      if (eligible.length === 0) continue;
      const result = winnerSide === null ? 'DRAW' : grant.side === winnerSide ? 'WIN' : 'LOSS';

      // 每日每宠上限：按"截断后的实际发放值"分组提交（同一组共用一次 BondUp）
      const byDelta = new Map<number, string[]>();
      let capped = 0;
      for (const id of eligible) {
        const used = await this.dailyUsed(id, date, grant.idemKey);
        const allowed = bondDailyAllowance(used, grant.delta);
        if (allowed <= 0) {
          capped += 1;
          continue;
        }
        byDelta.set(allowed, [...(byDelta.get(allowed) ?? []), id]);
      }
      if (capped > 0) {
        this.logger.log(`battle ${input.battleId}: ${capped} pokemon hit the daily bond cap (${grant.idemKey})`);
      }
      // 每日每宠上限：按"截断后的实际发放值"分组提交（同一组共用一次 BondUp）；
      // 分块序号跨组递增，避免多组时 idemKey 撞车（正常情况只有一组 → 与旧格式 `-0/-1...` 一致）
      const groups = [...byDelta.entries()].sort((a, b) => b[0] - a[0]);
      let blockIndex = 0;
      for (const [delta, ids] of groups) {
        for (const batch of bondBatches(ids)) {
          const batchKey = `${grant.idemKey}-${blockIndex}`;
          blockIndex += 1;
          const updated = await this.contract.bondUp(SYSTEM_IDENTITY, batch, delta, grant.reason, {
            idemKey: batchKey,
          });
          await this.recordDaily(batch, date, batchKey, delta);
          for (const pokemon of updated) {
            const snapshot = before.get(pokemon.id);
            const previous = snapshot?.bond ?? pokemon.bond - delta;
            changes.push({
              pokemonId: pokemon.id,
              speciesId: pokemon.speciesId,
              name: pokemon.name,
              side: grant.side,
              result,
              before: previous,
              after: pokemon.bond,
              delta: pokemon.bond - previous,
            });
          }
        }
      }
      this.logger.log(
        `battle ${input.battleId}: bond +${grant.delta} (${result}) on ${eligible.length} pokemon of ${owner}`,
      );
    }
    return changes;
  }

  /**
   * 野怪战斗羁绊（docs/backend-api.md §2/§11）：**收服成功出战宝可梦 +1**（每日每宠上限 +6），
   * 击倒不给（BOND_WILD_FAINT = 0）。幂等键 `<sessionId>-bond-<catch|faint>`（重放终态动作不会
   * 重复加、也不会重复占当日额度）；已易主/已放生/不存在返回 null。由 wild 战斗调用并自行容忍
   * 失败——羁绊是附加奖励，不应影响捕捉/结算主流程。
   */
  async grantWildBond(input: {
    sessionId: string;
    playerId: string;
    pokemonId: string;
    kind: WildBondKind;
  }): Promise<WildBondGrant | null> {
    const baseDelta = wildBondDelta(input.kind);
    if (baseDelta <= 0) return null;
    const pokemon = await this.contract.getPokemon(input.pokemonId).catch(() => null);
    if (!pokemon || pokemon.ownerId !== input.playerId || pokemon.status === 'RELEASED') return null;

    const idemKey = wildBondIdemKey(input.kind, input.sessionId);
    const date = utcDate();
    const used = await this.dailyUsed(input.pokemonId, date, idemKey);
    const delta = bondDailyAllowance(used, baseDelta);
    if (delta <= 0) {
      this.logger.log(`wild ${input.sessionId}: daily bond cap reached for ${input.pokemonId}`);
      return null;
    }
    const updated = await this.contract.bondUp(
      SYSTEM_IDENTITY,
      [input.pokemonId],
      delta,
      wildBondReason(input.kind, input.sessionId),
      { idemKey },
    );
    await this.recordDaily([input.pokemonId], date, idemKey, delta);
    const after = updated[0]?.bond ?? pokemon.bond;
    this.logger.log(
      `wild ${input.sessionId}: bond +${delta} (${input.kind}) on ${input.pokemonId} (${pokemon.bond} → ${after})`,
    );
    return {
      pokemonId: pokemon.id,
      speciesId: pokemon.speciesId,
      name: pokemon.name,
      kind: input.kind,
      before: pokemon.bond,
      after,
      delta: after - pokemon.bond,
    };
  }

  /**
   * 今日该宝可梦已获得的羁绊值；`excludeKey` 是本次要发放的 idemKey
   * （连同分块后缀）——重放同一场时自己的记录不计入，保证「重放既不重复加分也不重复占额度」。
   */
  private async dailyUsed(pokemonId: string, date: string, excludeKey: string): Promise<number> {
    const key = bondDailyKey(pokemonId, date);
    const record = await this.redis.client.hgetall(key).catch(() => null);
    let used = 0;
    for (const [field, value] of Object.entries(record ?? {})) {
      if (field === excludeKey || field.startsWith(`${excludeKey}-`)) continue;
      const parsed = Number.parseInt(value as string, 10);
      if (Number.isFinite(parsed)) used += Math.max(0, parsed);
    }
    return used;
  }

  /** 记账（HSETNX + TTL 2 天）：同一 field 只写一次，重复结算不会重复占额度。 */
  private async recordDaily(pokemonIds: string[], date: string, field: string, granted: number): Promise<void> {
    for (const pokemonId of pokemonIds) {
      const key = bondDailyKey(pokemonId, date);
      await this.redis.client
        .hsetnx(key, field, String(granted))
        .catch((err: Error) => this.logger.warn(`bond daily record failed for ${pokemonId}: ${err.message}`));
      await this.redis.client.expire(key, BOND_DAILY_TTL_SEC).catch(() => undefined);
    }
  }
}
