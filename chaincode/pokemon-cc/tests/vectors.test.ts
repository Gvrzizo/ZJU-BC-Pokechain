import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256hex } from '../src/common/crypto';
import { World } from './helpers/harness';

/**
 * 链码 ↔ Mock 对拍向量（test-vectors/chain/*.json）。
 * 后端对应实现：backend/test/chain-vectors.spec.ts；两边必须同时绿。
 * 结构说明见 test-vectors/chain/README.md。
 */

const VECTOR_DIR = resolve(__dirname, '../../../test-vectors/chain');
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

function identityOf(spec: string | IdentitySpec | undefined): { mspId: string; role: string; enrollmentId?: string } {
  if (spec === undefined) return { mspId: 'Org1MSP', role: 'system', enrollmentId: 'system' };
  if (typeof spec === 'string') {
    if (spec === 'system' || spec === 'admin') return { mspId: 'Org1MSP', role: spec, enrollmentId: spec };
    return { mspId: 'Org1MSP', role: 'player', enrollmentId: spec };
  }
  return { mspId: spec.mspId ?? 'Org1MSP', role: spec.role ?? 'player', enrollmentId: spec.enrollmentId };
}

async function fixture(world: World): Promise<void> {
  for (const playerId of FIXTURE_PLAYERS) {
    await world.run(() =>
      world.player.RegisterPlayer(world.adminCtx(), playerId, `nick-${playerId}`, BASE_ISO, `fixture-reg-${playerId}`),
    );
  }
  for (const playerId of FIXTURE_PLAYERS) {
    const current = (await world.getPlayer(playerId)).points as number;
    await world.run(() =>
      world.player.AddPoints(world.systemCtx(), playerId, String(1000 - current), 'fixture-fund', BASE_ISO, `fixture-fund-${playerId}`),
    );
  }
}

async function runOp(world: World, step: Step, now: string, idem: string): Promise<void> {
  const a: Args = step.args ?? {};
  const spec = identityOf(step.as);
  const ctx = world.ctx(spec.mspId, spec.role, spec.enrollmentId === '' ? undefined : spec.enrollmentId);
  switch (step.op) {
    case 'registerPlayer':
      await world.run(() => world.player.RegisterPlayer(ctx, a.playerId, a.nickname ?? a.playerId, now, idem));
      return;
    case 'addPoints':
      await world.run(() => world.player.AddPoints(ctx, a.playerId, String(a.delta), a.reason ?? 'vector', now, idem));
      return;
    case 'transferPoints':
      await world.run(() => world.player.TransferPoints(ctx, a.fromId, a.toId, String(a.amount), now, idem));
      return;
    case 'transferPokemon':
      await world.run(() => world.pokemon.Transfer(ctx, a.id, a.toId, now, idem));
      return;
    case 'applyGrowth':
      await world.run(() => world.pokemon.ApplyGrowth(ctx, a.id, JSON.stringify(a.growth ?? {}), now, idem));
      return;
    case 'mintPokemon': {
      const eventId = `ev_${a.id}`;
      await world.commitReveal(eventId, 'capture', a.ownerId);
      await world.run(() =>
        world.pokemon.MintFromCapture(
          ctx,
          a.id,
          a.ownerId,
          String(a.speciesId ?? 25),
          a.name ?? 'pikachu',
          JSON.stringify(a.ivs ?? DEFAULT_IVS),
          a.nature ?? 'hardy',
          a.ability ?? 'static',
          String(a.shiny ?? false),
          JSON.stringify(a.moves ?? DEFAULT_MOVES),
          a.dnaHash ?? sha256hex(`dna-${a.id}`),
          eventId,
          now,
          idem,
        ),
      );
      return;
    }
    case 'mintItem': {
      const typeId = a.typeId ?? 'poke-ball';
      await world.run(() =>
        world.item.MintItem(
          ctx,
          a.id,
          a.ownerId,
          typeId,
          String(a.quantity ?? 5),
          a.uri ?? `minio://assets/items/${typeId}.png`,
          a.metadataHash ?? sha256hex(`meta-${a.id}`),
          now,
          idem,
        ),
      );
      return;
    }
    case 'createTrade':
      await world.run(() =>
        world.trade.CreateTrade(
          ctx,
          a.id,
          a.fromId,
          a.toId,
          JSON.stringify(a.offer ?? {}),
          JSON.stringify(a.request ?? {}),
          a.expiresAt ?? new Date(Date.parse(now) + 3_600_000).toISOString(),
          now,
          idem,
        ),
      );
      return;
    case 'confirmTrade':
      await world.run(() => world.trade.ConfirmTrade(ctx, a.id, a.playerId, now, idem));
      return;
    case 'createBattle': {
      const wagerA = a.wagerA ?? {};
      const wagerB = a.wagerB ?? {};
      const wagerHash = a.wagerHash ?? world.wagerHash(a.playerA, a.playerB, wagerA, wagerB);
      await world.run(() =>
        world.battle.CreateBattle(
          ctx,
          a.id,
          a.playerA,
          a.playerB,
          JSON.stringify(wagerA),
          JSON.stringify(wagerB),
          wagerHash,
          now,
          idem,
        ),
      );
      return;
    }
    case 'activateBattle':
      await world.run(() => world.battle.ActivateBattle(ctx, a.id, now, idem));
      return;
    case 'submitResult':
      await world.run(() =>
        world.battle.SubmitResult(ctx, a.id, a.winnerId, a.resultHash ?? sha256hex(`result|${a.id}`), a.serverSig ?? 'server-sig', now, idem),
      );
      return;
    case 'confirmResult':
      await world.run(() => world.battle.ConfirmResult(ctx, a.id, a.playerId, now, idem));
      return;
    case 'settleBattle':
      await world.run(() => world.battle.SettleBattle(ctx, a.id, now, idem));
      return;
    case 'cancelBattle':
      await world.run(() => world.battle.CancelBattle(ctx, a.id, a.reason ?? 'cancel', now, idem));
      return;
    case 'forfeitBattle':
      await world.run(() => world.battle.Forfeit(ctx, a.id, a.loserId, a.reason ?? 'forfeit', now, idem));
      return;
    default:
      throw new Error(`unknown vector op "${step.op}" (update both runners)`);
  }
}

async function assertState(world: World, check: StateCheck): Promise<void> {
  let actual: unknown;
  switch (check.kind) {
    case 'playerPoints':
      actual = (await world.getPlayer(check.playerId as string)).points;
      break;
    case 'pokemonOwner':
      actual = (await world.getPokemon(check.id as string)).ownerId;
      break;
    case 'pokemonStatus':
      actual = (await world.getPokemon(check.id as string)).status;
      break;
    case 'pokemonBond':
      actual = (await world.getPokemon(check.id as string)).bond;
      break;
    case 'pokemonLevel':
      actual = (await world.getPokemon(check.id as string)).level;
      break;
    case 'itemOwner':
      actual = (await world.getItem(check.id as string)).ownerId;
      break;
    case 'itemStatus':
      actual = (await world.getItem(check.id as string)).status;
      break;
    case 'itemQuantity':
      actual = (await world.getItem(check.id as string)).quantity;
      break;
    case 'tradeStatus':
      actual = (await world.getTrade(check.id as string)).status;
      break;
    case 'battleStatus':
      actual = (await world.getBattle(check.id as string)).status;
      break;
    case 'battleWinner':
      actual = (await world.getBattle(check.id as string)).result.winnerId;
      break;
    case 'battleResultHash':
      actual = (await world.getBattle(check.id as string)).result.resultHash;
      break;
    case 'battleArbiterNote':
      actual = (await world.getBattle(check.id as string)).arbiterNote;
      break;
    default:
      throw new Error(`unknown state check "${check.kind}" (update both runners)`);
  }
  if (actual !== check.equals) {
    throw new Error(`${check.kind} ${check.id ?? check.playerId}: expected ${JSON.stringify(check.equals)}, got ${JSON.stringify(actual)}`);
  }
}

function errorCode(err: unknown): string {
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

describe('chaincode ↔ mock 对拍向量', () => {
  for (const vector of loadVectors()) {
    test(vector.name, async () => {
      const world = new World();
      await fixture(world);
      for (const [index, step] of vector.steps.entries()) {
        const now = nowAt(index);
        const idemKey = step.args?.idemKey ?? `${vector.name}-${index}`;
        const expectOk = step.expect?.ok ?? true;
        let failure: unknown;
        try {
          await runOp(world, step, now, idemKey);
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
          await assertState(world, check);
        }
      }
    });
  }
});
