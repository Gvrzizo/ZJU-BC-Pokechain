import { BattleLog } from '../battles/entities/battle-log.entity';
import { BattleState } from '../fabric/chain.types';

/** Battle randomness events committed by BattleManagerService.startBattle. */
export const BATTLE_EVENT_PREFIX = 'ev_battle_';

export interface BattleFairnessPayload {
  battleId: string;
  /** `DRAW` when the chain stores a draw. */
  winnerId: string;
  /** sha256(canonical(turnLog)); chain fallback when the local replay row is gone. */
  resultHash: string;
  /** DER hex secp256k1 signature over sha256(resultHash bytes). */
  serverSig: string;
  serverKeyId: string;
  /** null when no battle_logs row exists (e.g. reconciled/arbitrated battle). */
  turnLog: unknown[] | null;
}

export interface BattleLogSource {
  findOne(options: {
    where: { battleId: string };
    order: { createdAt: 'DESC' };
  }): Promise<BattleLog | null>;
}

export interface BattleChainSource {
  getBattle(battleId: string): Promise<BattleState>;
}

export interface BattleFairnessSources {
  /** Absent only in unit tests that construct the controller without a DB. */
  battleLogs?: BattleLogSource;
  contract: BattleChainSource;
  /** SigningService.keyId: fallback for battle_logs rows written before H19. */
  fallbackKeyId?: string;
}

/** Parse `ev_battle_<battleId>`; capture/mint events return undefined. */
export function parseBattleEventId(eventId: string): string | undefined {
  if (!eventId.startsWith(BATTLE_EVENT_PREFIX)) return undefined;
  const battleId = eventId.slice(BATTLE_EVENT_PREFIX.length);
  return battleId.length > 0 ? battleId : undefined;
}

/**
 * Battle audit payload for `GET /fairness/:eventId`:
 * - resultHash/serverSig/turnLog come from the latest battle_logs row (the replay),
 * - winnerId comes from the chain; chain resultHash/serverSig are the fallback when
 *   the local replay log is missing (reconciled/arbitrated battle, DB reset), in which
 *   case turnLog is null so the UI can degrade without claiming a recomputation pass.
 * Lookup failures never break the disclosure endpoint.
 */
export async function buildBattleFairness(
  battleId: string,
  sources: BattleFairnessSources,
): Promise<BattleFairnessPayload> {
  const [log, chain] = await Promise.all([
    sources.battleLogs
      ? sources.battleLogs
          .findOne({ where: { battleId }, order: { createdAt: 'DESC' } })
          .catch(() => null)
      : Promise.resolve(null),
    sources.contract.getBattle(battleId).catch(() => null),
  ]);
  return {
    battleId,
    winnerId: chain?.result?.winnerId ?? '',
    resultHash: log?.resultHash || chain?.result?.resultHash || '',
    serverSig: log?.serverSig || chain?.result?.serverSig || '',
    // fingerprint only known when a local log exists; pre-H19 rows fall back to the current key id
    serverKeyId: log ? log.serverKeyId || sources.fallbackKeyId || '' : '',
    turnLog: Array.isArray(log?.turnsJson) ? log.turnsJson : null,
  };
}
