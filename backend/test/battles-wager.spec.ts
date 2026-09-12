import { EventEmitter } from 'events';
import { ValidationPipe } from '@nestjs/common';
import { BattlesService } from '../src/battles/battles.service';
import { CreateRoomDto, JoinRoomDto } from '../src/battles/dto/room.dto';
import { childStackId, computeWagerHash } from '../src/fabric/chain.adapter';
import {
  SYSTEM_IDENTITY,
  makeBlocks,
  makeChain,
  makeConfig,
  makeHpService,
  makeRedis,
  mintBall,
  mockRepo,
  registerPlayers,
  seedPokemon,
  userIdentity,
} from './helpers';

/** 部分数量押注经 REST 层的归一/预检/链上锁定（docs/backend-api.md §5）。 */

type Contract = ReturnType<typeof makeChain>['contract'];

function makeService(contract: Contract): BattlesService {
  const manager = { events: new EventEmitter(), get: () => undefined, startBattle: async () => undefined };
  const users = { mustFindByUsername: async (u: string) => ({ username: u, fabricMspId: 'Org1MSP' }) };
  return new BattlesService(
    contract,
    makeRedis(),
    manager as never,
    users as never,
    makeBlocks(),
    makeHpService(),
    mockRepo() as never,
    mockRepo() as never,
    makeConfig(),
  );
}

async function setup() {
  const { chain, contract } = makeChain();
  await registerPlayers(contract, 'ash', 'gary');
  const pikaA = await seedPokemon(chain, 'ash', { id: 'p_a' });
  const pikaB = await seedPokemon(chain, 'gary', { id: 'p_b' });
  return { chain, contract, svc: makeService(contract), pikaA, pikaB };
}

describe('battle wager DTO (whitelist)', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: false,
    transformOptions: { enableImplicitConversion: true },
  });
  const body = (wager: Record<string, unknown>) => ({ mode: '1v1', wager, teamPokemonIds: ['p_a'] });
  const transformCreate = (payload: Record<string, unknown>) =>
    pipe.transform(payload, { type: 'body', metatype: CreateRoomDto }) as Promise<CreateRoomDto>;

  it('keeps items:[{id,qty}] through the whitelist and strips unknown fields', async () => {
    const dto = await transformCreate(body({ pokemonIds: [], items: [{ id: 'i_1', qty: 3 }], points: 5, bogus: 1 }));
    expect(dto.wager.items).toEqual([{ id: 'i_1', qty: 3 }]);
    expect(dto.wager.points).toBe(5);
    expect((dto.wager as unknown as Record<string, unknown>).bogus).toBeUndefined();
  });

  it('rejects qty < 1 / non-integer qty and an entry without id', async () => {
    await expect(transformCreate(body({ items: [{ id: 'i_1', qty: 0 }] }))).rejects.toThrow();
    await expect(transformCreate(body({ items: [{ id: 'i_1', qty: 1.5 }] }))).rejects.toThrow();
    await expect(transformCreate(body({ items: [{ qty: 2 }] }))).rejects.toThrow();
  });

  it('still accepts the legacy itemIds form (Trade DTO stays untouched)', async () => {
    const dto = await transformCreate(body({ pokemonIds: [], itemIds: ['i_1'], points: 0 }));
    expect(dto.wager.itemIds).toEqual(['i_1']);
    expect(dto.wager.items).toBeUndefined();

    const join = (await pipe.transform(
      { wager: { items: [{ id: 'i_1', qty: 2 }] }, teamPokemonIds: ['p_a'] },
      { type: 'body', metatype: JoinRoomDto },
    )) as JoinRoomDto;
    expect(join.wager.items).toEqual([{ id: 'i_1', qty: 2 }]);
  });
});

describe('BattlesService wager bundle (room create/join)', () => {
  it('passes items through to the room unchanged', async () => {
    const { contract, svc, pikaA } = await setup();
    await mintBall(contract, 'ash', 'i_balls', 'poke-ball', 10);
    const room = await svc.createRoom(userIdentity('ash'), {
      mode: '1v1',
      wager: { pokemonIds: [], items: [{ id: 'i_balls', qty: 3 }], points: 10 },
      teamPokemonIds: [pikaA.id],
    });
    expect(room.wagerA).toEqual({ pokemonIds: [], items: [{ id: 'i_balls', qty: 3 }], points: 10 });
    expect((await svc.getRoom(room.id)).wagerA.items).toEqual([{ id: 'i_balls', qty: 3 }]);
    expect((await svc.listRooms())[0].wagerA.items).toEqual([{ id: 'i_balls', qty: 3 }]);
  });

  it('resolves the legacy itemIds whole-stack form to an explicit quantity', async () => {
    const { contract, svc, pikaA } = await setup();
    await mintBall(contract, 'ash', 'i_balls', 'poke-ball', 6);
    const room = await svc.createRoom(userIdentity('ash'), {
      mode: '1v1',
      wager: { pokemonIds: [], itemIds: ['i_balls'], points: 0 },
      teamPokemonIds: [pikaA.id],
    });
    expect(room.wagerA.items).toEqual([{ id: 'i_balls', qty: 6 }]);
  });

  it('normalizes legacy rooms stored before the items field existed', async () => {
    const { svc } = await setup();
    const redis = (svc as unknown as { redis: ReturnType<typeof makeRedis> }).redis;
    await redis.setJson('battle:room:r_legacy', {
      id: 'r_legacy',
      mode: '1v1',
      playerA: 'ash',
      playerB: null,
      wagerA: { pokemonIds: [], itemIds: ['i_balls'], points: 0 },
      wagerB: null,
      teamA: ['p_a'],
      teamB: null,
      confirmations: { A: false, B: false },
      status: 'WAITING',
      battleId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const room = await svc.getRoom('r_legacy');
    expect(room.wagerA).toEqual({ pokemonIds: [], items: [{ id: 'i_balls', qty: 0 }], points: 0 });
  });

  it('rejects qty over holdings / qty < 1 with friendly codes before the chain is touched', async () => {
    const { contract, svc, pikaA } = await setup();
    await mintBall(contract, 'ash', 'i_balls', 'poke-ball', 10);
    const create = (wager: Record<string, unknown>) =>
      svc.createRoom(userIdentity('ash'), { mode: '1v1', wager: wager as never, teamPokemonIds: [pikaA.id] });

    await expect(create({ items: [{ id: 'i_balls', qty: 11 }] })).rejects.toThrow(/INSUFFICIENT_QUANTITY/);
    await expect(create({ items: [{ id: 'i_balls', qty: 11 }] })).rejects.toThrow(/has 10, cannot wager 11/);
    await expect(create({ items: [{ id: 'i_balls', qty: 0 }] })).rejects.toThrow(/INVALID_PARAM/);
    await expect(create({ items: [{ id: 'i_ghost', qty: 1 }] })).rejects.toThrow(/ITEM_NOT_FOUND/);
    expect((await contract.getItem('i_balls')).status).toBe('IDLE');
  });

  it("rejects wagering somebody else's stack or a locked stack", async () => {
    const { contract, svc, pikaA } = await setup();
    await mintBall(contract, 'gary', 'i_gary', 'poke-ball', 5);
    await expect(
      svc.createRoom(userIdentity('ash'), {
        mode: '1v1',
        wager: { pokemonIds: [], items: [{ id: 'i_gary', qty: 1 }], points: 0 },
        teamPokemonIds: [pikaA.id],
      }),
    ).rejects.toThrow(/NOT_OWNER/);

    await mintBall(contract, 'ash', 'i_locked', 'poke-ball', 2);
    const wagerA = { pokemonIds: [], itemIds: ['i_locked'], points: 0 };
    const wagerB = { pokemonIds: [], itemIds: [], points: 0 };
    await contract.createBattle(SYSTEM_IDENTITY, {
      id: 'b_lock',
      playerA: 'ash',
      playerB: 'gary',
      wagerA,
      wagerB,
      wagerHash: computeWagerHash('ash', 'gary', wagerA, wagerB),
    });
    await expect(
      svc.createRoom(userIdentity('ash'), {
        mode: '1v1',
        wager: { pokemonIds: [], items: [{ id: 'i_locked', qty: 1 }], points: 0 },
        teamPokemonIds: [pikaA.id],
      }),
    ).rejects.toThrow(/ASSET_LOCKED/);
  });
});

describe('BattlesService wager confirmation (chain lock paths)', () => {
  async function activatedRoom(wagerA: Record<string, unknown>, wagerB: Record<string, unknown>, held = 5) {
    const ctx = await setup();
    await mintBall(ctx.contract, 'ash', 'i_balls', 'poke-ball', held);
    const room = await ctx.svc.createRoom(userIdentity('ash'), {
      mode: '1v1',
      wager: wagerA as never,
      teamPokemonIds: [ctx.pikaA.id],
    });
    const joined = await ctx.svc.joinRoom(userIdentity('gary'), room.id, {
      wager: wagerB as never,
      teamPokemonIds: [ctx.pikaB.id],
    });
    expect(joined.status).toBe('JOINED');
    await ctx.svc.confirmWager(userIdentity('ash'), room.id);
    const active = await ctx.svc.confirmWager(userIdentity('gary'), room.id);
    return { ...ctx, active };
  }

  it('partial wager splits the parent stack and locks a deterministic child stack', async () => {
    const { contract, active } = await activatedRoom({ items: [{ id: 'i_balls', qty: 3 }], points: 0 }, { items: [], points: 0 }, 10);
    expect(active.status).toBe('ACTIVE');
    const battleId = active.battleId as string;

    const battle = await contract.getBattle(battleId);
    expect(battle.wagerA.items).toEqual([{ id: 'i_balls', qty: 3 }]);
    expect(battle.wagerB).toEqual({ pokemonIds: [], items: [], points: 0 });

    expect(await contract.getItem('i_balls')).toMatchObject({ quantity: 7, status: 'IDLE', lockRef: '' });
    expect(await contract.getItem(childStackId('i_balls', battleId))).toMatchObject({
      id: `i_balls#w${battleId}`,
      ownerId: 'ash',
      quantity: 3,
      status: 'LOCKED_BATTLE',
      lockRef: battleId,
    });
  });

  it('waging the full stack locks the parent itself (no child stack)', async () => {
    const { contract, active } = await activatedRoom({ items: [{ id: 'i_balls', qty: 5 }], points: 0 }, { items: [], points: 0 });
    const battleId = active.battleId as string;
    expect(await contract.getItem('i_balls')).toMatchObject({ quantity: 5, status: 'LOCKED_BATTLE', lockRef: battleId });
    await expect(contract.getItem(childStackId('i_balls', battleId))).rejects.toThrow(/ITEM_NOT_FOUND/);
  });
});
