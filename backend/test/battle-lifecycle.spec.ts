import { Subject } from 'rxjs';
import { JwtService } from '@nestjs/jwt';
import { BattleGateway } from '../src/battles/battle.gateway';
import { BattleManagerService } from '../src/battles/battle-manager.service';
import { BattlesService } from '../src/battles/battles.service';
import { SigningService } from '../src/battles/signing.service';
import { BattleLog } from '../src/battles/entities/battle-log.entity';
import { DisputeRecord } from '../src/battles/entities/dispute-record.entity';
import { AuditLog } from '../src/admin/entities/audit-log.entity';
import {
  SYSTEM_IDENTITY,
  makeBlocks,
  makeChain,
  makeConfig,
  makeHpService,
  makeRedis,
  mockRepo,
  registerPlayers,
  seedPokemon,
  userIdentity,
} from './helpers';

const BATTLE_CONFIG = {
  battle: {
    turnTimeoutMs: 30_000,
    disconnectTimeoutMs: 60_000,
    entryGraceMs: 90_000,
    settleFallbackMs: 300_000,
  },
};

type Push = { room: string; event: string; payload: Record<string, unknown> };

interface FakeClient {
  data: { username: string; sub: string; battles: string[] };
  rooms: string[];
  received: Array<{ event: string; payload: Record<string, unknown> }>;
  join: (room: string) => Promise<void>;
  emit: (event: string, payload: unknown) => void;
  disconnect: () => void;
}

/**
 * Full battle stack (manager + REST service layer + Socket.IO gateway) with an
 * in-memory chain/redis and a fake namespace, so a two-client flow can be
 * driven end to end without a running server.
 */
function makeStack(
  configValues: Record<string, unknown> = BATTLE_CONFIG,
  shared?: { chain: ReturnType<typeof makeChain>['chain']; contract: ReturnType<typeof makeChain>['contract']; redis: ReturnType<typeof makeRedis> },
) {
  const { chain, contract } = shared ?? makeChain();
  const redis = shared?.redis ?? makeRedis();
  const signing = new SigningService(makeConfig({ serverSigningKey: '' }));
  const manager = new BattleManagerService(
    contract,
    redis,
    signing,
    makeConfig(configValues),
    mockRepo<BattleLog>() as never,
  );
  const battles = new BattlesService(
    contract,
    redis,
    manager,
    { mustFindByUsername: async (u: string) => ({ username: u, fabricMspId: 'Org2MSP' }) } as never,
    makeBlocks(makeConfig(configValues)),
    makeHpService(redis),
    mockRepo<AuditLog>() as never,
    mockRepo<DisputeRecord>() as never,
    makeConfig(configValues),
  );
  battles.onModuleInit();

  const pushes: Push[] = [];
  const namespace = {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        pushes.push({ room, event, payload: payload as Record<string, unknown> });
      },
    }),
  };
  const gateway = new BattleGateway(
    new JwtService({ secret: 'test-secret' }),
    manager,
    { stream$: new Subject() } as never,
    battles,
  );
  gateway.server = namespace as never;
  gateway.afterInit();

  return { chain, contract, redis, manager, battles, gateway, pushes };
}

function fakeClient(username: string): FakeClient {
  const received: FakeClient['received'] = [];
  const rooms: string[] = [];
  return {
    data: { username, sub: username, battles: [] },
    rooms,
    received,
    join: async (room: string) => {
      rooms.push(room);
    },
    emit: (event: string, payload: unknown) => {
      received.push({ event, payload: payload as Record<string, unknown> });
    },
    disconnect: () => undefined,
  };
}

const of = (client: FakeClient, event: string) => client.received.filter((r) => r.event === event);
const pushed = (pushes: Push[], event: string) => pushes.filter((p) => p.event === event);

const WAGER = { pokemonIds: [] as string[], itemIds: [] as string[], points: 50 };

/** ash creates, gary joins, both confirm: the room is ACTIVE with a live engine. */
async function activateRoom(stack: ReturnType<typeof makeStack>) {
  const { chain, contract, battles } = stack;
  await registerPlayers(contract, 'ash', 'gary');
  const pa = await seedPokemon(chain, 'ash', { id: 'p_lc_a' });
  const pb = await seedPokemon(chain, 'gary', { id: 'p_lc_b' });
  const room = await battles.createRoom(userIdentity('ash'), {
    mode: '1v1',
    wager: { ...WAGER },
    teamPokemonIds: [pa.id],
  });
  await battles.joinRoom(userIdentity('gary'), room.id, {
    wager: { ...WAGER },
    teamPokemonIds: [pb.id],
  });
  const firstConfirm = await battles.confirmWager(userIdentity('ash'), room.id);
  const active = await battles.confirmWager(userIdentity('gary'), room.id);
  return { room, firstConfirm, active, battleId: active.battleId as string };
}

describe('battle entry: activation push -> both clients join (docs/backend-api.md §5)', () => {
  it('pushes battle:activated to both parties on the second wager confirmation', async () => {
    const stack = makeStack();
    const { battles } = stack;
    await registerPlayers(stack.contract, 'ash', 'gary');
    const pa = await seedPokemon(stack.chain, 'ash', { id: 'p_act_a' });
    const pb = await seedPokemon(stack.chain, 'gary', { id: 'p_act_b' });
    const room = await battles.createRoom(userIdentity('ash'), { mode: '1v1', wager: { ...WAGER }, teamPokemonIds: [pa.id] });
    await battles.joinRoom(userIdentity('gary'), room.id, { wager: { ...WAGER }, teamPokemonIds: [pb.id] });

    const firstConfirm = await battles.confirmWager(userIdentity('ash'), room.id);
    expect(firstConfirm.status).toBe('JOINED');
    expect(pushed(stack.pushes, 'battle:activated')).toHaveLength(0);

    const active = await battles.confirmWager(userIdentity('gary'), room.id);
    expect(active.status).toBe('ACTIVE');

    const activated = pushed(stack.pushes, 'battle:activated');
    expect(activated.map((p) => p.room).sort()).toEqual(['user:ash', 'user:gary']);
    for (const p of activated) {
      expect(p.payload).toEqual({ roomId: room.id, battleId: active.battleId });
    }
  });

  it('both clients join: each gets a snapshot with its own side, then the turn clock starts', async () => {
    const stack = makeStack();
    const { battleId } = await activateRoom(stack);

    const ash = fakeClient('ash');
    const gary = fakeClient('gary');

    await stack.gateway.onJoin(ash as never, { battleId });
    const ashState = of(ash, 'battle:state');
    expect(ashState).toHaveLength(1);
    expect(ashState[0].payload).toMatchObject({ battleId, you: 'A' });
    expect(ash.rooms).toContain(`battle:${battleId}`);

    // gary is not in yet: ash only learns that the clock waits for the opponent
    const entryBefore = pushed(stack.pushes, 'battle:entry');
    expect(entryBefore.at(-1)?.payload).toMatchObject({ awaitingPlayerIds: ['gary'] });
    expect(pushed(stack.pushes, 'battle:turn')).toHaveLength(0);

    await stack.gateway.onJoin(gary as never, { battleId });
    expect(of(gary, 'battle:state')[0].payload).toMatchObject({ battleId, you: 'B' });

    // both arrived -> first 30s turn clock
    const turns = pushed(stack.pushes, 'battle:turn');
    expect(turns).toHaveLength(1);
    expect(turns[0].room).toBe(`battle:${battleId}`);
    expect(turns[0].payload.awaitingPlayerIds).toEqual(['ash', 'gary']);
    expect(pushed(stack.pushes, 'battle:entry').at(-1)?.payload).toMatchObject({ awaitingPlayerIds: [] });
  });

  it('a party that never enters forfeits at the end of the entry grace (not a draw)', async () => {
    jest.useFakeTimers();
    try {
      const stack = makeStack();
      const { battleId, room } = await activateRoom(stack);

      const gary = fakeClient('gary');
      await stack.gateway.onJoin(gary as never, { battleId });
      expect(await stack.battles.listRooms()).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(91_000);

      const battle = await stack.contract.getBattle(battleId);
      expect(battle.status).toBe('SETTLED');
      expect(battle.result.winnerId).toBe('gary'); // ash forfeited, wager goes to gary
      expect((await stack.contract.getPlayer('gary')).points).toBe(1050);
      expect((await stack.contract.getPlayer('ash')).points).toBe(950);

      // the room is closed and no longer listed in the lobby
      expect(await stack.battles.listRooms()).toHaveLength(0);
      expect((await stack.battles.getRoom(room.id)).status).toBe('FINISHED');
      // the waiting client is told how it ended
      const ends = pushed(stack.pushes, 'battle:end');
      expect(ends).toHaveLength(1);
      expect(ends[0].payload).toMatchObject({ winnerId: 'gary', reason: 'entry-timeout' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('the turn clock waits for both parties: an idle pair only draws after both arrived', async () => {
    jest.useFakeTimers();
    try {
      const stack = makeStack();
      const { battleId } = await activateRoom(stack);
      const gary = fakeClient('gary');
      await stack.gateway.onJoin(gary as never, { battleId });

      // 29s with only gary in: the entry window is still open, no turn timeout
      await jest.advanceTimersByTimeAsync(29_000);
      expect((await stack.contract.getBattle(battleId)).status).toBe('ACTIVE');

      const ash = fakeClient('ash');
      await stack.gateway.onJoin(ash as never, { battleId });
      // both present but nobody acts: the documented 30s both-timeout draw applies
      await jest.advanceTimersByTimeAsync(31_000);

      const battle = await stack.contract.getBattle(battleId);
      expect(battle.status).toBe('RESULT_SUBMITTED');
      expect(battle.result.winnerId).toBe('DRAW');
      expect(await stack.battles.listRooms()).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('battle room lifecycle', () => {
  it('rejects a rejoin of a finished battle with a status instead of a stale room', async () => {
    const stack = makeStack();
    const { battleId } = await activateRoom(stack);
    await stack.manager.forfeit(battleId, 'ash');

    const late = fakeClient('ash');
    await stack.gateway.onJoin(late as never, { battleId });
    const errors = of(late, 'battle:error');
    expect(errors).toHaveLength(1);
    expect(errors[0].payload).toMatchObject({ code: 'BATTLE_NOT_LIVE', status: 'SETTLED' });
  });

  it('a non-party join is refused and unknown battles report no chain status', async () => {
    const stack = makeStack();
    const { battleId } = await activateRoom(stack);

    const outsider = fakeClient('brock');
    await stack.gateway.onJoin(outsider as never, { battleId });
    expect(of(outsider, 'battle:error')[0].payload).toMatchObject({ code: 'NOT_PARTY' });

    const ghost = fakeClient('ash');
    await stack.gateway.onJoin(ghost as never, { battleId: 'b_missing' });
    expect(of(ghost, 'battle:error')[0].payload).toMatchObject({ code: 'BATTLE_NOT_LIVE', status: null });
  });

  it('closes the room as soon as the engine ends the battle (timeout / knockout / forfeit)', async () => {
    const stack = makeStack();
    const { battleId, room } = await activateRoom(stack);

    await stack.battles.forfeit(userIdentity('ash'), battleId);
    expect((await stack.battles.getRoom(room.id)).status).toBe('FINISHED');
    expect(await stack.battles.listRooms()).toHaveLength(0);

    // a finished room stays out of the lobby even on a cold cache
    await stack.redis.del('cache:battle:lobby');
    expect(await stack.battles.listRooms()).toHaveLength(0);
  });

  it('reconciles a room left ACTIVE by a restart or the settle fallback', async () => {
    const stack = makeStack();
    const { battleId, room } = await activateRoom(stack);
    // chain settles out of band (e.g. the 5-minute SettleBattle fallback): the
    // room record stays ACTIVE because no engine 'end' event was emitted
    await stack.contract.submitBattleResult(SYSTEM_IDENTITY, battleId, 'gary', 'r'.repeat(64), 'sig');
    await stack.contract.settleBattle(SYSTEM_IDENTITY, battleId);

    // restart: same chain + redis, but a fresh in-memory engine registry
    const afterRestart = makeStack(BATTLE_CONFIG, {
      chain: stack.chain,
      contract: stack.contract,
      redis: stack.redis,
    });
    await stack.redis.del('cache:battle:lobby');

    expect(await afterRestart.battles.listRooms()).toHaveLength(0);
    expect((await afterRestart.battles.getRoom(room.id)).status).toBe('FINISHED');
  });

  it('keeps a live battle visible for both parties so they can rejoin', async () => {
    const stack = makeStack();
    const { battleId } = await activateRoom(stack);

    const rooms = await stack.battles.listRooms();
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ status: 'ACTIVE', playerA: 'ash', playerB: 'gary', battleId });

    const ash = fakeClient('ash');
    await stack.gateway.onJoin(ash as never, { battleId });
    expect(of(ash, 'battle:state')[0].payload).toMatchObject({ you: 'A' });
  });
});

/** Real-timer wait (these tests do not use fake timers): chain calls settle on the event loop. */
async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !cond()) await new Promise((r) => setTimeout(r, 10));
  return cond();
}

describe('battle:action over the socket: the client sends asset ids (docs/backend-api.md §5)', () => {
  /**
   * ash lv60 hyper-beam vs gary lv6 tackle, plus an unused second mon on ash's
   * side so switching has a legal target.
   */
  async function activate(stack: ReturnType<typeof makeStack>) {
    await registerPlayers(stack.contract, 'ash', 'gary');
    // 伤势持久化：ioredis-mock 同进程共享数据，清掉上一用例残留的 HP（本组用例要求满血队伍）
    await stack.redis.client.del('poke:hp:p_act_strong', 'poke:hp:p_act_bench', 'poke:hp:p_act_weak');
    const strong = await seedPokemon(stack.chain, 'ash', {
      id: 'p_act_strong',
      speciesId: 149,
      level: 60,
      moves: ['hyper-beam'],
    });
    const bench = await seedPokemon(stack.chain, 'ash', {
      id: 'p_act_bench',
      speciesId: 25,
      level: 30,
      moves: ['tackle'],
    });
    const weak = await seedPokemon(stack.chain, 'gary', {
      id: 'p_act_weak',
      speciesId: 133,
      level: 6,
      moves: ['tackle'],
    });
    const room = await stack.battles.createRoom(userIdentity('ash'), {
      mode: '1v1',
      wager: { ...WAGER },
      teamPokemonIds: [strong.id, bench.id],
    });
    await stack.battles.joinRoom(userIdentity('gary'), room.id, {
      wager: { ...WAGER },
      teamPokemonIds: [weak.id],
    });
    await stack.battles.confirmWager(userIdentity('ash'), room.id);
    const active = await stack.battles.confirmWager(userIdentity('gary'), room.id);
    return { battleId: active.battleId as string, room, strong, bench, weak };
  }

  /** both parties on the battle screen (entry grace passed, turn clock running) */
  async function bothIn(stack: ReturnType<typeof makeStack>, battleId: string) {
    const ash = fakeClient('ash');
    const gary = fakeClient('gary');
    await stack.gateway.onJoin(ash as never, { battleId });
    await stack.gateway.onJoin(gary as never, { battleId });
    return { ash, gary };
  }

  const lastState = (stack: ReturnType<typeof makeStack>) =>
    pushed(stack.pushes, 'battle:state').at(-1)?.payload.state as
      | { turn: number; A: { acted: boolean; active: number }; B: { acted: boolean; active: number } }
      | undefined;

  it('the moveId form the frontend sends resolves the turn instead of failing', async () => {
    const stack = makeStack();
    const { battleId } = await activate(stack);
    const { ash, gary } = await bothIn(stack, battleId);

    stack.gateway.onAction(ash as never, { battleId, seq: 1, action: { type: 'move', moveId: 'hyper-beam' } });
    expect(of(ash, 'battle:error')).toHaveLength(0);
    expect(lastState(stack)?.A.acted).toBe(true); // one side in: turn still open
    expect(lastState(stack)?.turn).toBe(1);

    stack.gateway.onAction(gary as never, { battleId, seq: 1, action: { type: 'move', moveId: 'tackle' } });
    expect(of(gary, 'battle:error')).toHaveLength(0);
    // hyper beam 150 on a lv6 eevee: the turn resolves and ends the battle
    expect(await waitFor(() => pushed(stack.pushes, 'battle:end').length === 1)).toBe(true);
    expect(pushed(stack.pushes, 'battle:end')[0].payload).toMatchObject({ winnerId: 'ash', reason: 'knockout' });
    expect(lastState(stack)?.turn).toBe(2);
    expect(await stack.battles.battleStatus(battleId)).toBe('RESULT_SUBMITTED');
  });

  it('an unusable move id surfaces as UNKNOWN_MOVE and does not consume the turn', async () => {
    const stack = makeStack();
    const { battleId } = await activate(stack);
    const { ash } = await bothIn(stack, battleId);

    stack.gateway.onAction(ash as never, {
      battleId,
      seq: 7,
      action: { type: 'move', moveId: 'flamethrower' },
    });

    const errors = of(ash, 'battle:error');
    expect(errors).toHaveLength(1);
    expect(errors[0].payload).toMatchObject({ code: 'UNKNOWN_MOVE', seq: 7 });
    expect(errors[0].payload.message).toContain('flamethrower');
    expect(await stack.battles.battleStatus(battleId)).toBe('ACTIVE');
    // the rejected action never reached the engine: the turn is still open
    expect(stack.manager.get(battleId)!.engine.publicState().A.acted).toBe(false);
  });

  it('a switch by pokemon id lands on the engine slot', async () => {
    const stack = makeStack();
    const { battleId, bench } = await activate(stack);
    const { ash, gary } = await bothIn(stack, battleId);

    stack.gateway.onAction(ash as never, {
      battleId,
      seq: 2,
      action: { type: 'switch', targetPokemonId: bench.id },
    });
    stack.gateway.onAction(gary as never, { battleId, seq: 2, action: { type: 'move', moveId: 'tackle' } });

    expect(of(ash, 'battle:error')).toHaveLength(0);
    expect(await waitFor(() => lastState(stack)?.turn === 2)).toBe(true);
    expect(lastState(stack)?.A.active).toBe(1); // bench mon is on the field
  });

  it('in-battle items are refused with ITEM_NOT_SUPPORTED instead of burning the turn', async () => {
    const stack = makeStack();
    const { battleId } = await activate(stack);
    const { ash } = await bothIn(stack, battleId);

    stack.gateway.onAction(ash as never, {
      battleId,
      seq: 4,
      action: { type: 'item', itemId: 'i_seed_v1_ash-potion' },
    });

    const errors = of(ash, 'battle:error');
    expect(errors).toHaveLength(1);
    expect(errors[0].payload).toMatchObject({ code: 'ITEM_NOT_SUPPORTED', seq: 4 });
    // no-op action was rejected, so the turn is not consumed
    expect(stack.manager.get(battleId)!.engine.publicState().A.acted).toBe(false);
  });

  it('an action from a non-party socket is refused', async () => {
    const stack = makeStack();
    const { battleId } = await activate(stack);
    const outsider = fakeClient('brock');
    stack.gateway.onAction(outsider as never, { battleId, seq: 1, action: { type: 'move', moveId: 'tackle' } });
    expect(of(outsider, 'battle:error')[0].payload).toMatchObject({ code: 'NOT_PARTY' });
  });
});
