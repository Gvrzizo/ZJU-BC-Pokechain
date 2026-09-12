import { Context, Contract, Returns, Transaction } from 'fabric-contract-api';
import { assertISO, fail, optionalMeta, requireHex, requireHex64, requireNonEmpty } from '../common/assert';
import { computeResultHash, sha256hex } from '../common/crypto';
import { withIdempotency } from '../common/idempotency';
import { RandPurpose, RandomCommit } from '../common/model';
import { emit, exists, loadRand, saveRand } from '../common/state';

const PURPOSES: RandPurpose[] = ['capture', 'battle', 'mint'];

export class RandomContract extends Contract {
  constructor() {
    super('RandomContract');
  }

  @Transaction()
  public async Commit(
    ctx: Context,
    eventId: string,
    purpose: string,
    playerId: string,
    commitHash: string,
    clientSeed: string,
    nowISO: string,
    idemKey: string,
    meta?: string,
  ): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireNonEmpty(eventId, 'eventId');
      requireNonEmpty(playerId, 'playerId');
      if (!PURPOSES.includes(purpose as RandPurpose)) {
        fail('INVALID_PARAM', `purpose must be one of ${PURPOSES.join('|')}, got "${purpose}"`);
      }
      requireHex64(commitHash, 'commitHash');
      requireHex(clientSeed, 'clientSeed');
      assertISO(nowISO, 'nowISO');
      const context = optionalMeta(meta, 'meta');
      if (await exists(ctx, 'rand', eventId)) {
        fail('RAND_EXISTS', `random event ${eventId} already committed`);
      }
      const rand: RandomCommit = {
        docType: 'rand',
        eventId,
        purpose: purpose as RandPurpose,
        playerId,
        commitHash: commitHash.toLowerCase(),
        clientSeed,
        serverSeed: '',
        resultHash: '',
        status: 'COMMITTED',
        createdAt: nowISO,
        meta: context,
      };
      await saveRand(ctx, rand);
      emit(ctx, 'RandomCommitted', { eventId, purpose, playerId, meta: context });
      return JSON.stringify(rand);
    });
  }

  @Transaction()
  public async RevealAndVerify(
    ctx: Context,
    eventId: string,
    serverSeed: string,
    nowISO: string,
    idemKey: string,
  ): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireNonEmpty(eventId, 'eventId');
      requireNonEmpty(serverSeed, 'serverSeed');
      assertISO(nowISO, 'nowISO');
      const rand = await loadRand(ctx, eventId);
      if (rand.status !== 'COMMITTED') {
        fail('BAD_STATE', `random event ${eventId} is ${rand.status}, expected COMMITTED`);
      }
      if (sha256hex(serverSeed) !== rand.commitHash) {
        fail('SEED_MISMATCH', `sha256(serverSeed) does not match commitHash of ${eventId}`);
      }
      rand.serverSeed = serverSeed;
      rand.resultHash = computeResultHash(serverSeed, rand.clientSeed, eventId);
      rand.status = 'REVEALED';
      await saveRand(ctx, rand);
      emit(ctx, 'RandomRevealed', { eventId, resultHash: rand.resultHash });
      return JSON.stringify(rand);
    });
  }

  @Transaction(false)
  @Returns('string')
  public async GetRandom(ctx: Context, eventId: string): Promise<string> {
    return JSON.stringify(await loadRand(ctx, eventId));
  }
}
