import { EVOLUTIONS, EvolutionRule, getSpecies } from '../game-data/species.data';

/**
 * 进化信息（docs/backend-api.md §2）：`GET /pokemon` 与 `GET /pokemon/:id` 随详情返回，
 * 前端据此画进化链预览（当前 → 目标 sprite、条件、"可以进化！"）。
 */
export interface EvolutionStep {
  fromSpeciesId: number;
  targetSpeciesId: number;
  /** 目标种族英文名（与链上 Pokemon.name 同口径） */
  targetName: string;
  /** 目标种族中文名（图鉴缺条目时回落到英文名） */
  targetNameZh: string;
  /** 等级条件（EVOLUTIONS 每条都有；石头进化同样要求这个等级） */
  minLevel: number;
  /** 有值 = 需要对应进化石道具（雷之石/水之石/火之石） */
  stoneTypeId?: string;
  /** 等级条件已满足 */
  levelOk: boolean;
  /** **现在就能进化**：纯等级进化且等级达标（石头进化要看玩家是否持有并使用石头） */
  canEvolveNow: boolean;
}

function toStep(rule: EvolutionRule, level: number): EvolutionStep {
  const target = getSpecies(rule.to);
  const levelOk = level >= rule.minLevel;
  return {
    fromSpeciesId: rule.from,
    targetSpeciesId: rule.to,
    targetName: target?.name ?? `#${rule.to}`,
    targetNameZh: target?.nameZh ?? target?.name ?? `#${rule.to}`,
    minLevel: rule.minLevel,
    ...(rule.stoneTypeId ? { stoneTypeId: rule.stoneTypeId } : {}),
    levelOk,
    canEvolveNow: levelOk && !rule.stoneTypeId,
  };
}

/**
 * 该种族在当前等级下的全部进化分支（伊布三条石头线都在内），
 * 「现在能进化」优先，然后是石头进化，最后按等级要求从低到高。
 */
export function evolutionSteps(speciesId: number, level: number): EvolutionStep[] {
  return EVOLUTIONS.filter((rule) => rule.from === speciesId)
    .map((rule) => toStep(rule, level))
    .sort(
      (a, b) =>
        Number(b.canEvolveNow) - Number(a.canEvolveNow) ||
        Number(Boolean(a.stoneTypeId)) - Number(Boolean(b.stoneTypeId)) ||
        a.minLevel - b.minLevel ||
        a.targetSpeciesId - b.targetSpeciesId,
    );
}

/** 详情里默认展示的那条（无分支返回 null）。 */
export function preferredEvolution(speciesId: number, level: number): EvolutionStep | null {
  return evolutionSteps(speciesId, level)[0] ?? null;
}

/** 是否有"等级进化"分支已经可走（升级/收服结果里的 canEvolve 用它）。 */
export function canEvolveNow(speciesId: number, level: number): boolean {
  return EVOLUTIONS.some((rule) => rule.from === speciesId && !rule.stoneTypeId && level >= rule.minLevel);
}

/** `POST /pokemon/:id/evolve` 不带石头时走的规则：纯等级进化且等级达标。 */
export function levelEvolutionRule(speciesId: number, level: number): EvolutionRule | undefined {
  return EVOLUTIONS.find((rule) => rule.from === speciesId && !rule.stoneTypeId && level >= rule.minLevel);
}

/** 带石头时的规则（石头 id 由道具模块给出）。 */
export function stoneEvolutionRule(
  speciesId: number,
  stoneTypeId: string,
): EvolutionRule | undefined {
  return EVOLUTIONS.find((rule) => rule.from === speciesId && rule.stoneTypeId === stoneTypeId);
}
