import { EventEmitter } from 'events';
import { HttpException, ValidationPipe } from '@nestjs/common';
import { BattlesService, RoomKickedEvent, TEAM_SIZE_MAX, assertTeamSize, assertTeamUnique } from '../src/battles/battles.service';
import { PlayerBlockService } from '../src/users/player-block.service';
import { PlayerBlock } from '../src/users/entities/player-block.entity';
import { WagerTemplateService } from '../src/battles/wager-template.service';
import { WagerTemplate } from '../src/battles/entities/wager-template.entity';
import {
  BlockPlayerDto,
  CreateRoomDto,
  JoinRoomDto,
  KickPlayerDto,
  SaveTemplateDto,
  UpdateRoomDto,
} from '../src/battles/dto/room.dto';
import { computeStats, normalizeEvs } from '../src/game-data/stats';
import { getSpecies } from '../src/game-data/species.data';
import { sanitizeRoomText } from '../src/battles/room-text';
import {
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

/**
 * 押注房体验补完（docs/backend-api.md §5）：押注富化 / 房主请离 / 屏蔽名单 /
 * 房名备注 / 加入留言 / 押注模板。
 */

type Contract = ReturnType<typeof makeChain>['contract'];

interface Stack {
  chain: ReturnType<typeof makeChain>['chain'];
  contract: Contract;
  redis: ReturnType<typeof makeRedis>;
  svc: BattlesService;
  blocks: PlayerBlockService;
  kicks: RoomKickedEvent[];
}

async function makeStack(config: Record<string, unknown> = {}): Promise<Stack> {
  const { chain, contract } = makeChain();
  const manager = { events: new EventEmitter(), get: () => undefined, startBattle: async () => undefined };
  const blocks = makeBlocks(makeConfig(config));
  const redis = makeRedis();
  const svc = new BattlesService(
    contract,
    redis,
    manager as never,
    { mustFindByUsername: async (u: string) => ({ username: u, fabricMspId: 'Org1MSP' }) } as never,
    blocks,
    makeHpService(redis),
    mockRepo() as never,
    mockRepo() as never,
    makeConfig(config),
  );
  const kicks: RoomKickedEvent[] = [];
  svc.events.on('kicked', (e: RoomKickedEvent) => kicks.push(e));
  return { chain, contract, redis, svc, blocks, kicks };
}

const WAGER = (over: Record<string, unknown> = {}) => ({
  pokemonIds: [],
  items: [],
  points: 0,
  ...over,
});

const ROOM_DTO = (over: Partial<CreateRoomDto> = {}) =>
  ({ mode: '1v1', wager: WAGER(), teamPokemonIds: ['p_ash'], ...over }) as CreateRoomDto;

const JOIN_DTO = (over: Partial<JoinRoomDto> = {}) =>
  ({ wager: WAGER(), teamPokemonIds: ['p_gary'], ...over }) as JoinRoomDto;

function makePipe() {
  return new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: false,
    transformOptions: { enableImplicitConversion: true },
  });
}

describe('押注富化 GET /battles/rooms/:id', () => {
  it('双方 wager 富化为可读明细（宝可梦中文名/等级/闪光/羁绊/能力值，道具中英文名与数量）', async () => {
    const { chain, contract, svc } = await makeStack();
    await registerPlayers(contract, 'ash', 'gary');
    const pika = await seedPokemon(chain, 'ash', { id: 'p_ash', speciesId: 25, level: 20, shiny: true, bond: 55 });
    const charmander = await seedPokemon(chain, 'gary', { id: 'p_gary', speciesId: 4, level: 12, bond: 40 });
    await mintBall(contract, 'ash', 'i_ball', 'poke-ball', 5);

    const room = await svc.createRoom(
      userIdentity('ash'),
      ROOM_DTO({
        name: '  挑战房  ',
        note: ' 规则：3v3 禁传说 ',
        wager: WAGER({ pokemonIds: ['p_ash'], items: [{ id: 'i_ball', qty: 3 }], points: 25 }),
      }),
    );
    expect(room.name).toBe('挑战房');
    expect(room.note).toBe('规则：3v3 禁传说');

    await svc.joinRoom(
      userIdentity('gary'),
      room.id,
      JOIN_DTO({ message: '来战！', wager: WAGER({ pokemonIds: ['p_gary'], points: 5 }) }),
    );

    const detail = await svc.roomDetail(room.id);
    const species = getSpecies(25)!;
    expect(detail.wagerDetailA.pokemon[0]).toEqual({
      id: pika.id,
      name: 'pikachu',
      speciesId: 25,
      nameZh: '皮卡丘',
      level: 20,
      shiny: true,
      bond: 55,
      stats: computeStats(species.base, pika.ivs, normalizeEvs(pika.evs), pika.level, pika.nature),
      unavailable: false,
    });
    expect(detail.wagerDetailA.items[0]).toEqual({
      id: 'i_ball',
      typeId: 'poke-ball',
      name: 'Poké Ball',
      nameZh: '精灵球',
      qty: 3,
      held: 5,
      unavailable: false,
    });
    expect(detail.wagerDetailA.totals).toEqual({ pokemon: 1, itemQty: 3, points: 25 });

    expect(detail.wagerDetailB?.pokemon[0]).toMatchObject({ id: charmander.id, nameZh: '小火龙', level: 12, shiny: false });
    expect(detail.wagerDetailB?.totals).toEqual({ pokemon: 1, itemQty: 0, points: 5 });
    expect(detail.joinMessage).toBe('来战！');
  });

  it('资产链上读不到时富化为 unavailable 占位（清单仍完整，前端可提示已失效）', async () => {
    const { chain, contract, svc } = await makeStack();
    await registerPlayers(contract, 'ash', 'gary');
    await seedPokemon(chain, 'ash', { id: 'p_ash' });
    await seedPokemon(chain, 'gary', { id: 'p_gary' });

    const room = await svc.createRoom(
      userIdentity('ash'),
      ROOM_DTO({ wager: WAGER({ pokemonIds: ['p_ash', 'p_ghost'] }) }),
    );
    const detail = await svc.roomDetail(room.id);
    expect(detail.wagerDetailA.pokemon).toHaveLength(2);
    expect(detail.wagerDetailA.pokemon[1]).toMatchObject({ id: 'p_ghost', unavailable: true, speciesId: null, stats: null });
    expect(detail.wagerDetailB).toBeNull();
    expect(detail.wagerDetailA.items).toEqual([]);
  });
});

describe('房名与备注（≤30 / ≤100，trim + 转义）', () => {
  it('创建时 trim 并转义 HTML，PATCH 由房主修改、非房主 403', async () => {
    const { chain, contract, svc } = await makeStack();
    await registerPlayers(contract, 'ash', 'gary');
    await seedPokemon(chain, 'ash', { id: 'p_ash' });
    await seedPokemon(chain, 'gary', { id: 'p_gary' });

    const room = await svc.createRoom(
      userIdentity('ash'),
      ROOM_DTO({ name: ' <b>赌一局</b>&"球" ', note: '  规则\n  3v3  ' }),
    );
    expect(room.name).toBe('&lt;b&gt;赌一局&lt;/b&gt;&amp;&quot;球&quot;');
    expect(room.note).toBe('规则 3v3');
    expect(sanitizeRoomText('  a  <script>  ')).toBe('a &lt;script&gt;');

    const updated = await svc.updateRoom(userIdentity('ash'), room.id, { name: '改名了', note: '' } as UpdateRoomDto);
    expect(updated.name).toBe('改名了');
    expect(updated.note).toBe('');

    await expect(svc.updateRoom(userIdentity('gary'), room.id, { name: 'hack' })).rejects.toThrow(/NOT_HOST/);
    await expect(svc.updateRoom(userIdentity('ash'), room.id, {})).rejects.toThrow(/INVALID_PARAM/);
  });

  it('房名 31 字 / 备注 101 字被 DTO 拒绝，30 / 100 字放行且未知字段被白名单剥离', async () => {
    const pipe = makePipe();
    const body = (over: Record<string, unknown>) => ({ mode: '1v1', wager: WAGER(), teamPokemonIds: ['p_ash'], ...over });

    await expect(
      pipe.transform(body({ name: 'x'.repeat(31) }), { type: 'body', metatype: CreateRoomDto }),
    ).rejects.toThrow();
    await expect(
      pipe.transform(body({ note: 'y'.repeat(101) }), { type: 'body', metatype: CreateRoomDto }),
    ).rejects.toThrow();

    const ok = (await pipe.transform(body({ name: 'x'.repeat(30), note: 'y'.repeat(100), evil: '<script>' }), {
      type: 'body',
      metatype: CreateRoomDto,
    })) as CreateRoomDto & { evil?: string };
    expect(ok.name).toHaveLength(30);
    expect(ok.note).toHaveLength(100);
    expect(ok.evil).toBeUndefined();
  });

  it('激活后不能再改房名（409 ROOM_NOT_OPEN）', async () => {
    const { chain, contract, svc } = await makeStack();
    await registerPlayers(contract, 'ash', 'gary');
    await seedPokemon(chain, 'ash', { id: 'p_ash' });
    await seedPokemon(chain, 'gary', { id: 'p_gary' });
    const room = await svc.createRoom(userIdentity('ash'), ROOM_DTO());
    await svc.joinRoom(userIdentity('gary'), room.id, JOIN_DTO());
    await svc.confirmWager(userIdentity('ash'), room.id);
    const active = await svc.confirmWager(userIdentity('gary'), room.id);
    expect(active.status).toBe('ACTIVE');

    await expect(svc.updateRoom(userIdentity('ash'), room.id, { name: 'x' })).rejects.toThrow(/ROOM_NOT_OPEN/);
  });
});

describe('房主拒绝权 POST /battles/rooms/:id/kick', () => {
  async function joinedRoom() {
    const stack = await makeStack();
    await registerPlayers(stack.contract, 'ash', 'gary', 'brock');
    await seedPokemon(stack.chain, 'ash', { id: 'p_ash' });
    await seedPokemon(stack.chain, 'gary', { id: 'p_gary' });
    await mintBall(stack.contract, 'gary', 'i_gball', 'poke-ball', 4);
    const room = await stack.svc.createRoom(userIdentity('ash'), ROOM_DTO({ name: '等一个对手' }));
    await stack.svc.joinRoom(
      userIdentity('gary'),
      room.id,
      JOIN_DTO({ message: '轻点打', wager: WAGER({ items: [{ id: 'i_gball', qty: 2 }] }) }),
    );
    return { ...stack, roomId: room.id };
  }

  it('确认押注前可请离：房间回 WAITING、B 的押注/留言清空、双方确认状态重置并推送给被踢者', async () => {
    const { svc, kicks, roomId } = await joinedRoom();
    // 房主已确认过一次，请离后必须重新确认（押注清单变了）
    await svc.confirmWager(userIdentity('ash'), roomId);

    const room = await svc.kick(userIdentity('ash'), roomId, 'gary');
    expect(room.status).toBe('WAITING');
    expect(room.playerB).toBeNull();
    expect(room.wagerB).toBeNull();
    expect(room.teamB).toBeNull();
    expect(room.joinMessage).toBeNull();
    expect(room.confirmations).toEqual({ A: false, B: false });
    expect(room.name).toBe('等一个对手');
    expect(kicks).toEqual([{ roomId, hostId: 'ash', playerId: 'gary' }]);

    await expect(svc.confirmWager(userIdentity('gary'), roomId)).rejects.toThrow(/ROOM_NOT_READY/);

    // 被踢者可以重新加入（房间已回到可加入状态）
    const rejoined = await svc.joinRoom(userIdentity('gary'), roomId, JOIN_DTO({ message: '再来' }));
    expect(rejoined.status).toBe('JOINED');
    expect(rejoined.joinMessage).toBe('再来');
  });

  it('越权 / 目标不在房间 / 激活后：NOT_HOST、PLAYER_NOT_IN_ROOM、ROOM_NOT_OPEN', async () => {
    const { svc, contract, roomId } = await joinedRoom();
    await expect(svc.kick(userIdentity('gary'), roomId, 'ash')).rejects.toThrow(/NOT_HOST/);
    await expect(svc.kick(userIdentity('brock'), roomId, 'gary')).rejects.toThrow(/NOT_HOST/);
    await expect(svc.kick(userIdentity('ash'), roomId, 'brock')).rejects.toThrow(/PLAYER_NOT_IN_ROOM/);

    await svc.confirmWager(userIdentity('ash'), roomId);
    const active = await svc.confirmWager(userIdentity('gary'), roomId);
    expect(active.status).toBe('ACTIVE');
    await expect(svc.kick(userIdentity('ash'), roomId, 'gary')).rejects.toThrow(/ROOM_NOT_OPEN/);
    // 押注已链上锁定，被踢者仍留在对局里（只能走 forfeit / 结算）
    const battle = await contract.getBattle(active.battleId!);
    expect(battle.playerB).toBe('gary');
  });
});

describe('屏蔽名单 POST/DELETE /battles/rooms/block', () => {
  it('被屏蔽者加入该房主房间 403 BLOCKED_BY_HOST，取消屏蔽后恢复；名单带剩余有效期', async () => {
    const { chain, contract, svc } = await makeStack();
    await registerPlayers(contract, 'ash', 'gary', 'brock');
    await seedPokemon(chain, 'ash', { id: 'p_ash' });
    await seedPokemon(chain, 'gary', { id: 'p_gary' });
    await seedPokemon(chain, 'brock', { id: 'p_brock' });
    const room = await svc.createRoom(userIdentity('ash'), ROOM_DTO({ name: '只欢迎熟人' }));

    const entry = await svc.blockPlayer(userIdentity('ash'), 'gary');
    expect(entry.playerId).toBe('gary');
    expect(entry.remainingMs).toBeGreaterThan(29 * 60 * 1000);
    expect(entry.remainingMs).toBeLessThanOrEqual(30 * 60 * 1000);

    await expect(svc.joinRoom(userIdentity('gary'), room.id, JOIN_DTO())).rejects.toThrow(/BLOCKED_BY_HOST/);

    const list = await svc.listBlockedPlayers(userIdentity('ash'));
    expect(list.map((e) => e.playerId)).toEqual(['gary']);
    expect(await svc.listBlockedPlayers(userIdentity('gary'))).toEqual([]);

    // 屏蔽只作用于房主维度：其他人／其他房间不受影响
    const brockRoom = await svc.createRoom(userIdentity('brock'), {
      mode: '1v1',
      wager: WAGER(),
      teamPokemonIds: ['p_brock'],
    } as CreateRoomDto);
    expect((await svc.joinRoom(userIdentity('gary'), brockRoom.id, JOIN_DTO())).playerB).toBe('gary');

    await svc.unblockPlayer(userIdentity('ash'), 'gary');
    expect(await svc.listBlockedPlayers(userIdentity('ash'))).toEqual([]);
    expect((await svc.joinRoom(userIdentity('gary'), room.id, JOIN_DTO())).playerB).toBe('gary');
  });

  it('TTL 到期后自动失效（默认 30 分钟，可配置），过期记录在列表里被清理', async () => {
    const { svc, blocks } = await makeStack({ BATTLE_BLOCK_TTL_MS: 30 });
    const entry = await svc.blockPlayer(userIdentity('ash'), 'gary');
    expect(entry.remainingMs).toBeLessThanOrEqual(30);
    expect(await blocks.isBlocked('ash', 'gary')).toBe(true);

    await new Promise((r) => setTimeout(r, 45));
    expect(await blocks.isBlocked('ash', 'gary')).toBe(false);
    expect(await svc.listBlockedPlayers(userIdentity('ash'))).toEqual([]);
  });

  it('过期记录不再拦截（可直接注入已过期行验证），屏蔽自己是 INVALID_PARAM', async () => {
    const repo = mockRepo<PlayerBlock>();
    const blocks = new PlayerBlockService(repo as never, makeConfig());
    const past = new Date(Date.now() - 1000);
    repo.rows.push({
      id: 'pb_old',
      blockerId: 'ash',
      blockedId: 'gary',
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: past,
    } as never);
    expect(await blocks.isBlocked('ash', 'gary')).toBe(false);
    expect(await blocks.list('ash')).toEqual([]);
    expect(repo.rows).toHaveLength(0); // 列表读取顺手清理过期行

    await expect(blocks.block('ash', 'ash')).rejects.toThrow(/INVALID_PARAM/);
  });

  it('屏蔽 / 解除的 DTO 需要 playerId', async () => {
    const pipe = makePipe();
    await expect(pipe.transform({}, { type: 'body', metatype: BlockPlayerDto })).rejects.toThrow();
    await expect(pipe.transform({ playerId: 'gary' }, { type: 'body', metatype: BlockPlayerDto })).resolves.toMatchObject({
      playerId: 'gary',
    });
    await expect(pipe.transform({}, { type: 'body', metatype: KickPlayerDto })).rejects.toThrow();
  });
});

describe('加入留言（join.message ≤100）', () => {
  it('留言透传给房主（房间响应 + 房间详情），无留言为 null，被 DTO 限制在 100 字', async () => {
    const { chain, contract, svc } = await makeStack();
    await registerPlayers(contract, 'ash', 'gary');
    await seedPokemon(chain, 'ash', { id: 'p_ash' });
    await seedPokemon(chain, 'gary', { id: 'p_gary' });

    const room = await svc.createRoom(userIdentity('ash'), ROOM_DTO());
    expect(room.joinMessage).toBeNull();
    const joined = await svc.joinRoom(userIdentity('gary'), room.id, JOIN_DTO({ message: '  <b>承让</b>  ' }));
    expect(joined.joinMessage).toBe('&lt;b&gt;承让&lt;/b&gt;');
    expect((await svc.listRooms())[0].joinMessage).toBe('&lt;b&gt;承让&lt;/b&gt;');

    const pipe = makePipe();
    await expect(
      pipe.transform({ wager: WAGER(), teamPokemonIds: ['p_gary'], message: 'm'.repeat(101) }, {
        type: 'body',
        metatype: JoinRoomDto,
      }),
    ).rejects.toThrow();
    const ok = (await pipe.transform(
      { wager: WAGER(), teamPokemonIds: ['p_gary'], message: 'm'.repeat(100) },
      { type: 'body', metatype: JoinRoomDto },
    )) as JoinRoomDto;
    expect(ok.message).toHaveLength(100);
  });
});

describe('押注模板 GET/POST/DELETE /battles/templates', () => {
  const service = () => {
    const repo = mockRepo<WagerTemplate>();
    return { repo, templates: new WagerTemplateService(repo as never) };
  };

  it('保存 / 列表（只含自己的）/ 删除；名称 trim 转义、押注归一为链上形态', async () => {
    const { templates } = service();
    const saved = await templates.save('ash', {
      name: '  球战  ',
      note: '  押两个球  ',
      wager: { pokemonIds: ['p_ash'], items: [{ id: 'i_ball', qty: 2 }], points: 10 },
    } as SaveTemplateDto);
    expect(saved.name).toBe('球战');
    expect(saved.note).toBe('押两个球');
    expect(saved.wager).toEqual({ pokemonIds: ['p_ash'], items: [{ id: 'i_ball', qty: 2 }], points: 10 });

    await templates.save('gary', {
      name: 'gary 的',
      wager: { pokemonIds: [], items: [], points: 1 },
    } as SaveTemplateDto);
    const mine = await templates.list('ash');
    expect(mine.map((t) => t.name)).toEqual(['球战']);

    // 旧 itemIds 形态同样归一到 items
    const legacy = await templates.save('ash', {
      name: '旧格式',
      wager: { pokemonIds: [], itemIds: ['i_ball'], points: 0 },
    } as unknown as SaveTemplateDto);
    expect(legacy.wager.items).toEqual([{ id: 'i_ball', qty: 0 }]);

    await templates.remove('ash', saved.id);
    await expect(templates.remove('ash', saved.id)).rejects.toThrow(/TEMPLATE_NOT_FOUND/);
    // 别人的模板删不掉（按 ownerId 维度查不到 = 404）
    await expect(templates.remove('gary', saved.id)).rejects.toThrow(/TEMPLATE_NOT_FOUND/);
    await expect(templates.list('gary')).resolves.toHaveLength(1);
  });

  it('每用户最多 10 个（第 11 个 409 TEMPLATE_LIMIT），名称 / 备注长度由 DTO 限制', async () => {
    const { templates } = service();
    for (let i = 0; i < 10; i += 1) {
      await templates.save('ash', { name: `模板${i}`, wager: { pokemonIds: [], items: [], points: 0 } } as SaveTemplateDto);
    }
    await expect(
      templates.save('ash', { name: '第 11 个', wager: { pokemonIds: [], items: [], points: 0 } } as SaveTemplateDto),
    ).rejects.toThrow(/TEMPLATE_LIMIT/);
    await expect(templates.list('ash')).resolves.toHaveLength(10);

    const pipe = makePipe();
    const wager = { pokemonIds: [], items: [], points: 0 };
    await expect(
      pipe.transform({ name: 'n'.repeat(31), wager }, { type: 'body', metatype: SaveTemplateDto }),
    ).rejects.toThrow();
    await expect(
      pipe.transform({ name: 'ok', note: 'n'.repeat(101), wager }, { type: 'body', metatype: SaveTemplateDto }),
    ).rejects.toThrow();
    await expect(
      pipe.transform({ name: 'ok', wager: { items: [{ id: 'i_1', qty: 0 }] } }, { type: 'body', metatype: SaveTemplateDto }),
    ).rejects.toThrow();
  });
});

describe('出战队伍数量限制 1-6（docs/backend-api.md §5）', () => {
  it('assertTeamSize 边界：0 / 7 只 400 INVALID_TEAM_SIZE，1 / 6 只放行', () => {
    expect(() => assertTeamSize([])).toThrow(/^INVALID_TEAM_SIZE:/);
    expect(() => assertTeamSize(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toThrow(/^INVALID_TEAM_SIZE:/);
    expect(() => assertTeamSize(['a'])).not.toThrow();
    expect(() => assertTeamSize(Array.from({ length: 6 }, (_, i) => `p${i}`))).not.toThrow();
    expect(TEAM_SIZE_MAX).toBe(6);
  });

  it('创建 / 加入房间带 7 只 → 400 INVALID_TEAM_SIZE（6 只放行，先于资产校验）', async () => {
    const { chain, contract, svc } = await makeStack();
    await registerPlayers(contract, 'ash', 'gary');
    const ashTeam = Array.from({ length: 6 }, (_, i) => `p_ash_${i}`);
    const garyTeam = Array.from({ length: 6 }, (_, i) => `p_gary_${i}`);
    for (const id of ashTeam) await seedPokemon(chain, 'ash', { id });
    for (const id of garyTeam) await seedPokemon(chain, 'gary', { id });

    // 第 7 只在链上不存在也没关系：规模校验先于归属校验（不会被误报 NOT_OWNER）
    const err = await svc
      .createRoom(userIdentity('ash'), ROOM_DTO({ teamPokemonIds: [...ashTeam, 'p_ghost'] }))
      .catch((e: HttpException) => e);
    expect(err.message).toMatch(/^INVALID_TEAM_SIZE:/);
    expect(err.getStatus()).toBe(400);

    const room = await svc.createRoom(userIdentity('ash'), ROOM_DTO({ teamPokemonIds: ashTeam }));
    expect(room.teamA).toHaveLength(6);

    const joinErr = await svc
      .joinRoom(userIdentity('gary'), room.id, JOIN_DTO({ teamPokemonIds: [...garyTeam, 'p_ghost'] }))
      .catch((e: HttpException) => e);
    expect(joinErr.message).toMatch(/^INVALID_TEAM_SIZE:/);
    expect(joinErr.getStatus()).toBe(400);
    // 失败的加入没有把玩家写进房间
    expect((await svc.getRoom(room.id)).playerB).toBeNull();

    const joined = await svc.joinRoom(userIdentity('gary'), room.id, JOIN_DTO({ teamPokemonIds: garyTeam }));
    expect(joined.teamB).toHaveLength(6);
  });
});

describe('出战队伍去重（H2：同一只宝可梦不能占多个槽位）', () => {
  it('assertTeamUnique 边界：重复 id 400 DUPLICATE_TEAM，1-6 只不同 id 放行', () => {
    expect(() => assertTeamUnique(['p1', 'p1'])).toThrow(/^DUPLICATE_TEAM:/);
    expect(() => assertTeamUnique(['p1', 'p2', 'p3'])).not.toThrow();
    expect(() => assertTeamUnique([])).not.toThrow();
  });

  it('创建 / 加入房间带重复宝可梦 → 400 DUPLICATE_TEAM（6 条命攻击被拒，房间未创建）', async () => {
    const { chain, contract, svc } = await makeStack();
    await registerPlayers(contract, 'ash', 'gary');
    await seedPokemon(chain, 'ash', { id: 'p_ash' });
    await seedPokemon(chain, 'gary', { id: 'p_gary' });

    // 6 个相同 id：规模合法，但去重校验先于资产/归属校验
    const before = (await svc.listRooms()).length;
    const err = await svc
      .createRoom(userIdentity('ash'), ROOM_DTO({ teamPokemonIds: Array.from({ length: 6 }, () => 'p_ash') }))
      .catch((e: HttpException) => e);
    expect(err.message).toMatch(/^DUPLICATE_TEAM:/);
    expect(err.getStatus()).toBe(400);
    expect(await svc.listRooms()).toHaveLength(before);

    // 正常队伍可建房；加入方重复同样被拒且不写 playerB
    const room = await svc.createRoom(userIdentity('ash'), ROOM_DTO({ teamPokemonIds: ['p_ash'] }));
    const joinErr = await svc
      .joinRoom(userIdentity('gary'), room.id, JOIN_DTO({ teamPokemonIds: ['p_gary', 'p_gary'] }))
      .catch((e: HttpException) => e);
    expect(joinErr.message).toMatch(/^DUPLICATE_TEAM:/);
    expect(joinErr.getStatus()).toBe(400);
    expect((await svc.getRoom(room.id)).playerB).toBeNull();
    const joined = await svc.joinRoom(userIdentity('gary'), room.id, JOIN_DTO({ teamPokemonIds: ['p_gary'] }));
    expect(joined.teamB).toEqual(['p_gary']);
  });
});

describe('房主删除房间 DELETE /battles/rooms/:id', () => {
  it('WAITING 房间：房主可删，房间记录 / 房间索引 / 大厅缓存一并清理', async () => {
    const { chain, contract, redis, svc } = await makeStack();
    await registerPlayers(contract, 'ash', 'gary');
    await seedPokemon(chain, 'ash', { id: 'p_ash' });
    const room = await svc.createRoom(userIdentity('ash'), ROOM_DTO({ name: '要撤了' }));
    await svc.listRooms(); // 先把大厅列表写进缓存
    expect(await redis.getJson('cache:battle:lobby')).not.toBeNull();

    expect(await svc.deleteRoom(userIdentity('ash'), room.id)).toEqual({ deleted: true, roomId: room.id });
    await expect(svc.getRoom(room.id)).rejects.toThrow(/ROOM_NOT_FOUND/);
    // ioredis-mock 在同进程内共享数据：只断言"这个房间"从索引/缓存里消失
    expect(await redis.get('cache:battle:lobby')).toBeNull();
    expect(await redis.smembers('battle:rooms')).not.toContain(room.id);
    expect((await svc.listRooms()).map((r) => r.id)).not.toContain(room.id);

    // 幂等性：重复删除 404
    await expect(svc.deleteRoom(userIdentity('ash'), room.id)).rejects.toThrow(/ROOM_NOT_FOUND/);
  });

  it('非房主 403 NOT_HOST；有人加入 409 ROOM_NOT_EMPTY（先 kick 再删）；激活后 409 ROOM_NOT_OPEN', async () => {
    const { chain, contract, svc } = await makeStack();
    await registerPlayers(contract, 'ash', 'gary', 'brock');
    await seedPokemon(chain, 'ash', { id: 'p_ash' });
    await seedPokemon(chain, 'gary', { id: 'p_gary' });
    const room = await svc.createRoom(userIdentity('ash'), ROOM_DTO());

    const notHost = await svc.deleteRoom(userIdentity('gary'), room.id).catch((e: HttpException) => e);
    expect(notHost.message).toMatch(/^NOT_HOST:/);
    expect(notHost.getStatus()).toBe(403);

    await svc.joinRoom(userIdentity('gary'), room.id, JOIN_DTO());
    const notEmpty = await svc.deleteRoom(userIdentity('ash'), room.id).catch((e: HttpException) => e);
    expect(notEmpty.message).toMatch(/^ROOM_NOT_EMPTY:/);
    expect(notEmpty.getStatus()).toBe(409);
    expect(notEmpty.message).toContain('kick');
    // 房间还在，挑战者也还在
    expect((await svc.getRoom(room.id)).playerB).toBe('gary');

    // 先请离 → 房间回 WAITING → 可删
    await svc.kick(userIdentity('ash'), room.id, 'gary');
    await svc.deleteRoom(userIdentity('ash'), room.id);
    await expect(svc.getRoom(room.id)).rejects.toThrow(/ROOM_NOT_FOUND/);

    // 激活后的房间不可删（资产已链上锁定）
    const active = await svc.createRoom(userIdentity('ash'), ROOM_DTO({ name: '打完再说' }));
    await svc.joinRoom(userIdentity('gary'), active.id, JOIN_DTO());
    await svc.confirmWager(userIdentity('ash'), active.id);
    await svc.confirmWager(userIdentity('gary'), active.id);
    const opened = await svc.deleteRoom(userIdentity('ash'), active.id).catch((e: HttpException) => e);
    expect(opened.message).toMatch(/^ROOM_NOT_OPEN:/);
    expect(opened.getStatus()).toBe(409);
    expect((await svc.getRoom(active.id)).status).toBe('ACTIVE');
  });
});

describe('互看出战队伍（房间详情 teamDetailA/B，所有人可见）', () => {
  it('双方出战队伍富化为 id/昵称/种族/等级/闪光/羁绊/能力值；未加入时 B 为 null', async () => {
    const { chain, contract, svc } = await makeStack();
    await registerPlayers(contract, 'ash', 'gary');
    const pika = await seedPokemon(chain, 'ash', {
      id: 'p_team_a1',
      speciesId: 25,
      level: 22,
      shiny: true,
      bond: 55,
      moves: ['tackle'],
    });
    const charmander = await seedPokemon(chain, 'ash', { id: 'p_team_a2', speciesId: 4, level: 12, bond: 40 });
    const gyarados = await seedPokemon(chain, 'gary', { id: 'p_team_b1', speciesId: 130, level: 30, bond: 70 });

    const room = await svc.createRoom(
      userIdentity('ash'),
      ROOM_DTO({ teamPokemonIds: [pika.id, charmander.id] }),
    );
    const waiting = await svc.roomDetail(room.id);
    expect(waiting.teamDetailA.map((m) => m.id)).toEqual([pika.id, charmander.id]);
    expect(waiting.teamDetailA[0]).toMatchObject({
      id: pika.id,
      name: 'pikachu',
      speciesId: 25,
      nameZh: '皮卡丘',
      level: 22,
      shiny: true,
      bond: 55,
      unavailable: false,
    });
    const species = getSpecies(25)!;
    expect(waiting.teamDetailA[0].stats).toEqual(
      computeStats(species.base, pika.ivs, normalizeEvs(pika.evs), pika.level, pika.nature),
    );
    // 契约：只有公开字段（不含 IV / EV / 性格等私有数据）
    expect(Object.keys(waiting.teamDetailA[0]).sort()).toEqual(
      ['id', 'name', 'speciesId', 'nameZh', 'level', 'shiny', 'bond', 'stats', 'unavailable'].sort(),
    );
    expect(waiting.teamDetailB).toBeNull();

    await svc.joinRoom(userIdentity('gary'), room.id, JOIN_DTO({ teamPokemonIds: [gyarados.id] }));
    const detail = await svc.roomDetail(room.id);
    expect(detail.teamDetailB?.map((m) => m.id)).toEqual([gyarados.id]);
    expect(detail.teamDetailB?.[0]).toMatchObject({ nameZh: '暴鲤龙', level: 30, bond: 70 });
    // teamA/teamB 仍是 id 数组（引擎/结算用），富化结果另开字段
    expect(detail.teamA).toEqual([pika.id, charmander.id]);
    expect(detail.teamB).toEqual([gyarados.id]);
  });

  it('链上读不到的成员富化为 unavailable 占位（不改写队伍 id 列表）', async () => {
    const { chain, contract, svc, redis } = await makeStack();
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', { id: 'p_team_ok' });
    const room = await svc.createRoom(userIdentity('ash'), ROOM_DTO({ teamPokemonIds: ['p_team_ok'] }));
    // 直接改房间记录模拟"成员已被清理"（正常流程里队伍在创建时已校验归属）
    const stored = await redis.getJson<{ teamA: string[] }>(`battle:room:${room.id}`);
    await redis.setJson(`battle:room:${room.id}`, { ...stored, teamA: ['p_team_ok', 'p_team_gone'] }, 3600);

    const detail = await svc.roomDetail(room.id);
    expect(detail.teamA).toEqual(['p_team_ok', 'p_team_gone']);
    expect(detail.teamDetailA).toHaveLength(2);
    expect(detail.teamDetailA[1]).toMatchObject({ id: 'p_team_gone', unavailable: true, speciesId: null, stats: null });
  });
});
