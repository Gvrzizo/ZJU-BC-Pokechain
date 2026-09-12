import { Injectable, Logger } from '@nestjs/common';
import { computeWagerHash } from '../fabric/chain.adapter';
import { ContractService } from '../fabric/contract.service';
import { ChainIdentity, SYSTEM_IDENTITY, WagerBundle } from '../fabric/chain.types';
import { BattleManagerService } from '../battles/battle-manager.service';
import { EngineMonInput } from '../battles/engine/battle-engine';
import { PokemonHpService } from '../pokemon/pokemon-hp.service';

/** 排位房与机器人场都是 wager=0 的链上对局（只争 rating / 练习） */
const EMPTY_WAGER = (): WagerBundle => ({ pokemonIds: [], items: [], points: 0 });

/**
 * 排位对局的链上/引擎启动器（docs/backend-api.md §11）。
 *
 * 普通大厅房间走 `BattlesService.confirmWager`（押注双确认时建房）；排位另有两处需要
 * **自己指定 battleId 才能先扣费/先登记** 的场景：
 *   - 积分场：准入积分必须在 CreateBattle 之前扣（扣失败即取消建房），
 *     reason 又要带 battleId（`arena:entry:<battleId>`）→ battleId 由排位侧生成；
 *   - 机器人场：机器人队伍是内存实体（无链上资产），joinRoom/confirmWager 的队伍校验过不去。
 * 两条路径都复用同一个引擎入口（`BattleManagerService.startBattle`），房间记账仍在
 * RankedService / RankedBotService 里完成。
 */
@Injectable()
export class RankedBattleLauncher {
  private readonly logger = new Logger(RankedBattleLauncher.name);

  constructor(
    private readonly contract: ContractService,
    private readonly manager: BattleManagerService,
    /** 当前 HP（链下 Redis，排位对局以现状出战，docs/backend-api.md §2） */
    private readonly hp: PokemonHpService,
  ) {}

  /** CreateBattle（wager=0、escrow 0）→ ActivateBattle → 起引擎。 */
  async launch(input: {
    battleId: string;
    playerA: string;
    playerB: string;
    teamA: EngineMonInput[];
    teamB: EngineMonInput[];
    /** 服务身份（默认 system）；机器人场同样用 system 代发 */
    as?: ChainIdentity;
  }): Promise<void> {
    const as = input.as ?? SYSTEM_IDENTITY;
    const wagerA = EMPTY_WAGER();
    const wagerB = EMPTY_WAGER();
    await this.contract.createBattle(as, {
      id: input.battleId,
      playerA: input.playerA,
      playerB: input.playerB,
      wagerA,
      wagerB,
      wagerHash: computeWagerHash(input.playerA, input.playerB, wagerA, wagerB),
    });
    await this.contract.activateBattle(as, input.battleId, { idemKey: `${input.battleId}-activate` });
    await this.manager.startBattle(input.battleId, input.playerA, input.playerB, input.teamA, input.teamB);
  }

  /** 链上宝可梦 → 引擎入参（队伍归属/IDLE 校验由调用方负责；HP 取链下当前值）。 */
  async loadTeam(pokemonIds: string[]): Promise<EngineMonInput[]> {
    const team: EngineMonInput[] = [];
    for (const id of pokemonIds) {
      const pokemon = await this.contract.getPokemon(id);
      team.push({
        pokemonId: pokemon.id,
        speciesId: pokemon.speciesId,
        level: pokemon.level,
        ivs: pokemon.ivs,
        evs: pokemon.evs,
        nature: pokemon.nature,
        moves: pokemon.moves,
        currentHp: await this.hp.currentHp(pokemon),
      });
    }
    return team;
  }

  /**
   * CreateBattle 之后中途失败（引擎起不来等）：把这场没人能进的空押注对局
   * 按 DRAW 收尾（链上退款语义，双方无可退资产），避免留下永久 ACTIVE 的孤儿对局。
   */
  async abandon(battleId: string): Promise<void> {
    try {
      await this.manager.settleAbandoned(battleId, 'ranked-launch-failed');
    } catch (err) {
      this.logger.warn(`abandon ${battleId} failed: ${(err as Error).message}`);
    }
  }
}
