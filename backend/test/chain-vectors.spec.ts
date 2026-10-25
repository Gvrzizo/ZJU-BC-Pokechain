import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { computeWagerHash } from '../src/fabric/chain.adapter';
import { sha256hex } from '../src/common/utils/crypto.util';
import {
  ADMIN_IDENTITY,
  ChainIdentity,
  SYSTEM_IDENTITY,
} from '../src/fabric/chain.types';
import { MockChainAdapter } from '../src/fabric/mock-chain.adapter';

/**
 * 链码 ↔ Mock 对拍向量（test-vectors/chain/*.json）。
 * 链码对应实现：chaincode/pokemon-cc/tests/vectors.test.ts；两边必须同时绿。
 * 结构说明见 test-vectors/chain/README.md。
 */

const VECTOR_DIR = resolve(__dirname, '../../test-vectors/chain');
const BASE_ISO = '2026-01-01T00:00:00.000Z';
const BASE_MS = Date.parse(BASE_ISO);
const FIXTURE_PLAYERS = ['alice', 'bob', 'carol'];
const SERVER_SEED = 'aa11bb22cc33dd44ee55ff660011223344556677889900aabbccddeeff00112233';
const CLIENT_SEED = 'c1e27a8b9d0ef123c1e27a8b9d0ef123';
const DEFAULT_IVS = { hp: 10, atk: 12, def: 8, spatk: 15, spdef: 14, speed: 20 };
const DEFAULT_MOVES = ['thunder-shock', 'growl'];

type Args = Record<string, any>;

interface IdentitySpec {
  role?: string;
  enrollmentId?: string;
  mspId?: string;
}

interface Step {
  op: string;
  as?: string | IdentitySpec;
  args?: Args;
  expect?: { ok: boolean; code?: string };
  state?: StateCheck[];
}

interface StateCheck {
  kind: string;
  id?: string;
  playerId?: string;
  equals: unknown;
}

interface Vector {
  name: string;
  description?: string;
  steps: Step[];
}

function nowAt(stepIndex: number): string {
  return new Date(BASE_MS + stepIndex * 60_000).toISOString();
}

function identityOf(spec: string | IdentitySpec | undefined): ChainIdentity {
  if (spec === undefined) return SYSTEM_IDENTITY;
  if (typeof spec === 'string') {
    if (spec === 'system' || spec === 'admin') return { userId: spec, role: spec, mspId: 'Org1MSP' };
    return { userId: spec, role: 'player', mspId: 'Org1MSP' };
  }
  return {
    userId: spec.enrollmentId ?? '',
    role: (spec.role ?? 'player') as ChainIdentity['role'],
    mspId: spec.mspId ?? 'Org1MSP',
  };
}

async function fixture(chain: MockChainAdapter): Promise<void> {
  for (const playerId of FIXTURE_PLAYERS) {
    await chain.registerPlayer(ADMIN_IDENTITY, {
      playerId,
      nickname: `nick-${playerId}`,
      nowISO: BASE_ISO,
      idemKey: `fixture-reg-${playerId}`,
    });
  }
  for (const playerId of FIXTURE_PLAYERS) {
    const current = (await chain.getPlayer(playerId)).points;
    await chain.addPoints(SYSTEM_IDENTITY, {
      playerId,
      delta: 1000 - current,
      reason: 'fixture-fund',
      nowISO: BASE_ISO,
      idemKey: `fixture-fund-${playerId}`,
    });
  }
}

async function runOp(chain: MockChainAdapter, step: Step, now: string, idemKey: string): Promise<void> {
  const a: Args = step.args ?? {};
  const as = identityOf(step.as);
  const meta = { nowISO: now, idemKey };
  switch (step.op) {
    case 'registerPlayer':
      await chain.registerPlayer(as, { playerId: a.playerId, nickname: a.nickname ?? a.playerId, ...meta });
      return;
    case 'addPoints':
      await chain.addPoints(as, { playerId: a.playerId, delta: a.delta, reason: a.reason ?? 'vector', ...meta });
      return;
    case 'transferPoints':
      await chain.transferPoints(as, { fromId: a.fromId, toId: a.toId, amount: a.amount, ...meta });
      return;
    case 'transferPokemon':
      await chain.transferPokemon(as, { id: a.id, toId: a.toId, ...meta });
      return;
    case 'applyGrowth':
      await chain.applyGrowth(as, { id: a.id, growth: a.growth ?? {}, ...meta });
      return;
    case 'mintPokemon': {
      const eventId = `ev_${a.id}`;
      await chain.commitRandom(SYSTEM_IDENTITY, {
        eventId,
        purpose: 'capture',
        playerId: a.ownerId,
        commitHash: sha256hex(SERVER_SEED),
        clientSeed: CLIENT_SEED,
        meta: '',
        nowISO: now,
        idemKey: `idem-commit-${eventId}`,
      });
      await chain.revealAndVerify(SYSTEM_IDENTITY, {
        eventId,
        serverSeed: SERVER_SEED,
        nowISO: now,
        idemKey: `idem-reveal-${eventId}`,
      });
      await chain.mintFromCapture(as, {
        id: a.id,
        playerId: a.ownerId,
        speciesId: a.speciesId ?? 25,
        name: a.name ?? 'pikachu',
        ivs: a.ivs ?? DEFAULT_IVS,
        nature: a.nature ?? 'hardy',
        ability: a.ability ?? 'static',
        shiny: a.shiny ?? false,
        moves: a.moves ?? DEFAULT_MOVES,
        dnaHash: a.dnaHash ?? sha256hex(`dna-${a.id}`),
        eventId,
        ...meta,
      });
      return;
    }
    case 'mintItem': {
      const typeId = a.typeId ?? 'poke-ball';
      await chain.mintItem(as, {
        id: a.id,
        playerId: a.ownerId,
        typeId,
        quantity: a.quantity ?? 5,
        uri: a.uri ?? `minio://assets/items/${typeId}.png`,
        metadataHash: a.metadataHash ?? sha256hex(`meta-${a.id}`),
        ...meta,
      });
      return;
    }
    case 'createTrade':
      await chain.createTrade(as, {
        id: a.id,
        fromId: a.fromId,
        toId: a.toId,
        offer: a.offer ?? { pokemonIds: [], itemIds: [], points: 0 },
        request: a.request ?? { pokemonIds: [], itemIds: [], points: 0 },
        expiresAt: a.expiresAt ?? new Date(Date.parse(now) + 3_600_000).toISOString(),
        ...meta,
      });
      return;
    case 'confirmTrade':
      await chain.confirmTrade(as, { id: a.id, playerId: a.playerId, ...meta });
      return;
    case 'createBattle': {
      const wagerA = a.wagerA ?? {};
      const wagerB = a.wagerB ?? {};
      const wagerHash = a.wagerHash ?? computeWagerHash(a.playerA, a.playerB, wagerA, wagerB);
      await chain.createBattle(as, {
        id: a.id,
        playerA: a.playerA,
        playerB: a.playerB,
        wagerA,
        wagerB,
        wagerHash,
        ...meta,
      });
      return;
    }
    case 'activateBattle':
      await chain.activateBattle(as, { id: a.id, ...meta });
      return;
    case 'submitResult':
      await chain.submitBattleResult(as, {
        id: a.id,
        winnerId: a.winnerId,
        resultHash: a.resultHash ?? sha256hex(`result|${a.id}`),
        serverSig: a.serverSig ?? 'server-sig',
        ...meta,
      });
      return;
    case 'confirmResult':
      await chain.confirmBattleResult(as, { id: a.id, playerId: a.playerId, ...meta });
      return;
    case 'settleBattle':
      await chain.settleBattle(as, { id: a.id, ...meta });
      return;
    case 'cancelBattle':
      await chain.cancelBattle(as, { id: a.id, reason: a.reason ?? 'cancel', ...meta });
      return;
    case 'forfeitBattle':
      await chain.forfeitBattle(as, { id: a.id, loserId: a.loserId, reason: a.reason ?? 'forfeit', ...meta });
      return;
    default:
      throw new Error(`unknown vector op "${step.op}" (update both runners)`);
  }
}

async function assertState(chain: MockChainAdapter, check: StateCheck): Promise<void> {
  let actual: unknown;
  switch (check.kind) {
    case 'playerPoints':
      actual = (await chain.getPlayer(check.playerId as string)).points;
      break;
    case 'pokemonOwner':
      actual = (await chain.getPokemon(check.id as string)).ownerId;
      break;
    case 'pokemonStatus':
      actual = (await chain.getPokemon(check.id as string)).status;
      break;
    case 'pokemonBond':
      actual = (await chain.getPokemon(check.id as string)).bond;
      break;
    case 'pokemonLevel':
      actual = (await chain.getPokemon(check.id as string)).level;
      break;
    case 'itemOwner':
      actual = (await chain.getItem(check.id as string)).ownerId;
      break;
    case 'itemStatus':
      actual = (await chain.getItem(check.id as string)).status;
      break;
    case 'itemQuantity':
      actual = (await chain.getItem(check.id as string)).quantity;
      break;
    case 'tradeStatus':
      actual = (await chain.getTrade(check.id as string)).status;
      break;
    case 'battleStatus':
      actual = (await chain.getBattle(check.id as string)).status;
      break;
    case 'battleWinner':
      actual = (await chain.getBattle(check.id as string)).result.winnerId;
      break;
    case 'battleResultHash':
      actual = (await chain.getBattle(check.id as string)).result.resultHash;
      break;
    case 'battleArbiterNote':
      actual = (await chain.getBattle(check.id as string)).arbiterNote;
      break;
    default:
      throw new Error(`unknown state check "${check.kind}" (update both runners)`);
  }
  if (actual !== check.equals) {
    throw new Error(`${check.kind} ${check.id ?? check.playerId}: expected ${JSON.stringify(check.equals)}, got ${JSON.stringify(actual)}`);
  }
}

function errorCode(err: unknown): string {
  const coded = err as { code?: string; message?: string };
  if (typeof coded?.code === 'string') return coded.code;
  const message = err instanceof Error ? err.message : String(err);
  const match = /^([A-Z][A-Z0-9_]+):/.exec(message);
  return match ? match[1] : message;
}

function loadVectors(): Vector[] {
  return readdirSync(VECTOR_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(VECTOR_DIR, file), 'utf8')) as Vector);
}

describe('mock ↔ chaincode 对拍向量', () => {
  for (const vector of loadVectors()) {
    it(vector.name, async () => {
      const chain = new MockChainAdapter();
      await fixture(chain);
      for (const [index, step] of vector.steps.entries()) {
        const now = nowAt(index);
        const idemKey = step.args?.idemKey ?? `${vector.name}-${index}`;
        const expectOk = step.expect?.ok ?? true;
        let failure: unknown;
        try {
          await runOp(chain, step, now, idemKey);
        } catch (err) {
          failure = err;
        }
        if (expectOk && failure !== undefined) {
          throw new Error(`step ${index} ${step.op}: expected success, got ${errorCode(failure)}: ${(failure as Error).message}`);
        }
        if (!expectOk) {
          if (failure === undefined) {
            throw new Error(`step ${index} ${step.op}: expected ${step.expect?.code}, but call succeeded`);
          }
          const code = errorCode(failure);
          if (code !== step.expect?.code) {
            throw new Error(`step ${index} ${step.op}: expected ${step.expect?.code}, got ${code}: ${(failure as Error).message}`);
          }
        }
        for (const check of step.state ?? []) {
          await assertState(chain, check);
        }
      }
    });
  }
});
