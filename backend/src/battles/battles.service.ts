import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../common/redis/redis.service';
import { AppException } from '../common/utils/errors';
import { computeWagerHash, normalizeWagerBundle } from '../fabric/chain.adapter';
import { ContractService } from '../fabric/contract.service';
import { ChainIdentity, SYSTEM_IDENTITY, WagerBundle, WagerInput } from '../fabric/chain.types';
import { AuditLog } from '../admin/entities/audit-log.entity';
import { PlayerBlockService } from '../users/player-block.service';
import { UsersService } from '../users/users.service';
import { PokemonHpService } from '../pokemon/pokemon-hp.service';
import { BattleManagerService } from './battle-manager.service';
import { errorCodeOf } from './battle-error';
import { DisputeRecord } from './entities/dispute-record.entity';
import { BattleMoveInfo, battleMoveCatalog } from './battle-moves';
import { EngineMonInput } from './engine/battle-engine';
import { CreateRoomDto, JOIN_MESSAGE_MAX, JoinRoomDto, ROOM_NAME_MAX, ROOM_NOTE_MAX, UpdateRoomDto } from './dto/room.dto';
import { sanitizeRoomText } from './room-text';
import { WagerDetail, WagerPokemonDetail, enrichTeam, enrichWager } from './wager-detail';

export interface BattleRoom {
  id: string;
  mode: '1v1';
  /** 房主自定义房名（trim+转义后；空串 = 未命名，前端回退显示"房主 X 的房间"） */
  name: string;
  /** 房主备注：说明赌什么 / 规则（trim+转义后） */
  note: string;
  playerA: string;
  playerB: string | null;
  /** 归一后的押注包（`items:[{id,qty}]`，与链上 CreateBattle 同形态） */
  wagerA: WagerBundle;
  wagerB: WagerBundle | null;
  teamA: string[];
  teamB: string[] | null;
  /** 加入者留言（≤100 字，房间回 WAITING 时清空），房主在确认面板看到 */
  joinMessage: string | null;
  confirmations: { A: boolean; B: boolean };
  status: 'WAITING' | 'JOINED' | 'ACTIVE' | 'FINISHED';
  battleId: string | null;
  createdAt: string;
  /** 最近一次写入（房间状态 / 押注确认 / 结算）；对账用它判断房间是否长期停滞 */
  updatedAt?: string;
}

/** 房间详情（GET /battles/rooms/:id）：房间本体 + 双方押注/出战队伍的富化明细。 */
export interface BattleRoomDetail extends BattleRoom {
  wagerDetailA: WagerDetail;
  wagerDetailB: WagerDetail | null;
  /** 房主出战队伍的富化明细（所有人可看，含旁观者） */
  teamDetailA: WagerPokemonDetail[];
  /** 加入者出战队伍的富化明细（未加入时为 null） */
  teamDetailB: WagerPokemonDetail[] | null;
}

export interface BattleActivatedEvent {
  roomId: string;
  battleId: string;
  playerIds: string[];
}

/** 房主请离加入者（`battle:room-kicked` 推送 + 大厅轮询兜底） */
export interface RoomKickedEvent {
  roomId: string;
  hostId: string;
  playerId: string;
}

/**
 * 对局结算广播（docs/backend-api.md §11）：ranked/bond 挂钩消费。
 * 广播发生在 settle 之后（引擎自行结束或 REST 确认结算），监听方会再复核链上状态，
 * 因此即使此刻链上还是 RESULT_SUBMITTED（等确认/兜底）也能安全登记待办。
 */
export interface BattleSettledEvent {
  battleId: string;
  roomId: string | null;
  playerA: string;
  playerB: string;
  /** 参战队伍（羁绊挂钩按队伍加分） */
  teamA: string[];
  teamB: string[];
}

/** 出战队伍规模：1-6 只（房间创建/加入与排位入队同一口径，docs/backend-api.md §5/§11） */
export const TEAM_SIZE_MIN = 1;
export const TEAM_SIZE_MAX = 6;

/** 队伍规模校验：违规 400 `INVALID_TEAM_SIZE`（链上/引擎按最多 6 只设计）。 */
export function assertTeamSize(pokemonIds: string[]): void {
  const size = Array.isArray(pokemonIds) ? pokemonIds.length : 0;
  if (size < TEAM_SIZE_MIN || size > TEAM_SIZE_MAX) {
    throw new AppException(
      'INVALID_TEAM_SIZE',
      `teamPokemonIds must contain ${TEAM_SIZE_MIN}-${TEAM_SIZE_MAX} pokemon, got ${size}`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * 出战队伍去重（H2 / docs/review-2026-10-25.md）：同一只宝可梦不能占多个槽位
 * （否则「最强一只 ×6」等于 6 条命，押注房可稳赢）。房间与排位共用。
 */
export function assertTeamUnique(pokemonIds: string[]): void {
  if (!Array.isArray(pokemonIds)) return;
  if (new Set(pokemonIds).size !== pokemonIds.length) {
    throw new AppException(
      'DUPLICATE_TEAM',
      'teamPokemonIds must not contain duplicates',
      HttpStatus.BAD_REQUEST,
    );
  }
}

const ROOM_TTL_SEC = 3600;
/** chain battle states that still allow (re)joining the live battle screen */
const LIVE_BATTLE_STATES = new Set(['CREATED', 'ACTIVE', 'RESULT_SUBMITTED']);
/** 服务端对账的 resultHash 前缀：链上没有 arbiterNote 通道，用它能识别非引擎结果 */
const ABANDON_NOTE = 'server-restart';

@Injectable()
export class BattlesService implements OnModuleInit {
  private readonly logger = new Logger(BattlesService.name);
  /** room-level notifications consumed by the Socket.IO gateway (battle:activated) */
  readonly events = new EventEmitter();
  /** 同一时刻只跑一次对账（启动对账与运行期后台对账复用） */
  private reconciling: Promise<number> | null = null;

  constructor(
    private readonly contract: ContractService,
    private readonly redis: RedisService,
    private readonly manager: BattleManagerService,
    private readonly users: UsersService,
    private readonly blocks: PlayerBlockService,
    /** 链下当前 HP：只用于**出战前的濒死校验**（PvP 满血出战、不写回，docs/backend-api.md §2） */
    private readonly hp: PokemonHpService,
    @InjectRepository(AuditLog) private readonly audits: Repository<AuditLog>,
    @InjectRepository(DisputeRecord) private readonly disputes: Repository<DisputeRecord>,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    // the engine can end a battle on its own (timeout / disconnect / knockout):
    // close the room so it never lingers in the lobby list
    this.manager.events.on('end', (battleId: string) => {
      void this.closeRoomFor(battleId);
      // 结算挂钩：排位 ELO / 羁绊（引擎结束的路径也要广播，见 notifySettled）
      void this.notifySettled(battleId);
    });
    // a restart drops every in-memory engine: reconcile the rooms left in Redis
    // against the chain right away so the lobby never shows a dead "在战斗中"
    // room. Failures are logged only — boot must not depend on the chain.
    void this.reconcileRooms('startup');
  }

  private get reconcileStaleMs(): number {
    return this.config.get<number>('battle.reconcileStaleMs') ?? 600_000;
  }

  private roomKey(id: string): string {
    return `battle:room:${id}`;
  }

  private async saveRoom(room: BattleRoom): Promise<void> {
    room.updatedAt = new Date().toISOString();
    await this.redis.setJson(this.roomKey(room.id), room, ROOM_TTL_SEC);
    await this.redis.sadd('battle:rooms', room.id);
    await this.redis.del('cache:battle:lobby');
  }

  async getRoom(id: string): Promise<BattleRoom> {
    const room = await this.redis.getJson<BattleRoom>(this.roomKey(id));
    if (!room) throw new AppException('ROOM_NOT_FOUND', `room ${id} does not exist`, HttpStatus.NOT_FOUND);
    return withNormalizedWagers(room);
  }

  async createRoom(as: ChainIdentity, dto: CreateRoomDto): Promise<BattleRoom> {
    await this.assertTeamOwnership(as.userId, dto.teamPokemonIds);
    const room: BattleRoom = {
      id: `r_${randomUUID()}`,
      mode: '1v1',
      name: sanitizeRoomText(dto.name),
      note: sanitizeRoomText(dto.note),
      playerA: as.userId,
      playerB: null,
      wagerA: await this.normalizeWager(as.userId, dto.wager),
      wagerB: null,
      teamA: dto.teamPokemonIds,
      teamB: null,
      joinMessage: null,
      confirmations: { A: false, B: false },
      status: 'WAITING',
      battleId: null,
      createdAt: new Date().toISOString(),
    };
    await this.saveRoom(room);
    return room;
  }

  /** 房主改房名 / 备注（仅房主、仅在激活前；空串表示清空该字段）。 */
  async updateRoom(as: ChainIdentity, roomId: string, dto: UpdateRoomDto): Promise<BattleRoom> {
    const room = await this.getRoom(roomId);
    if (room.playerA !== as.userId) {
      throw new AppException('NOT_HOST', `room ${roomId} belongs to ${room.playerA}`, HttpStatus.FORBIDDEN);
    }
    if (room.status !== 'WAITING' && room.status !== 'JOINED') {
      throw new AppException('ROOM_NOT_OPEN', `room ${roomId} is ${room.status}`, HttpStatus.CONFLICT);
    }
    if (dto.name === undefined && dto.note === undefined) {
      throw new AppException('INVALID_PARAM', 'provide name and/or note', HttpStatus.BAD_REQUEST);
    }
    if (dto.name !== undefined) room.name = sanitizeRoomText(dto.name);
    if (dto.note !== undefined) room.note = sanitizeRoomText(dto.note);
    await this.saveRoom(room);
    return room;
  }

  /**
   * 房间详情：房间本体 + 双方押注与**出战队伍**的富化明细（大厅"查看押注"/"查看队伍"弹窗用）。
   * 队伍富化对所有登录用户开放（含旁观者），不要求是房间当事人。
   */
  async roomDetail(roomId: string): Promise<BattleRoomDetail> {
    const room = await this.getRoom(roomId);
    const [wagerDetailA, wagerDetailB, teamDetailA, teamDetailB] = await Promise.all([
      enrichWager(this.contract, room.wagerA),
      room.wagerB ? enrichWager(this.contract, room.wagerB) : Promise.resolve(null),
      enrichTeam(this.contract, room.teamA),
      room.teamB ? enrichTeam(this.contract, room.teamB) : Promise.resolve(null),
    ]);
    return { ...room, wagerDetailA, wagerDetailB, teamDetailA, teamDetailB };
  }

  /**
   * 房主请离加入者（docs/backend-api.md §5）：仅在**双方都确认押注之前**可用
   * （押注一旦双确认，链上 CreateBattle 已锁定资产，只能走 forfeit）。
   * 房间退回 WAITING：清空 B 的押注/队伍/留言并重置双方确认状态，房主需重新确认。
   */
  async kick(as: ChainIdentity, roomId: string, playerId: string): Promise<BattleRoom> {
    const room = await this.getRoom(roomId);
    if (room.playerA !== as.userId) {
      throw new AppException('NOT_HOST', `room ${roomId} belongs to ${room.playerA}`, HttpStatus.FORBIDDEN);
    }
    if (room.status === 'ACTIVE' || room.status === 'FINISHED') {
      throw new AppException('ROOM_NOT_OPEN', `room ${roomId} is ${room.status}`, HttpStatus.CONFLICT);
    }
    if (!room.playerB || room.playerB !== playerId) {
      throw new AppException('PLAYER_NOT_IN_ROOM', `player ${playerId} is not in room ${roomId}`, HttpStatus.CONFLICT);
    }
    room.playerB = null;
    room.wagerB = null;
    room.teamB = null;
    room.joinMessage = null;
    room.confirmations = { A: false, B: false };
    room.status = 'WAITING';
    await this.saveRoom(room);
    const event: RoomKickedEvent = { roomId: room.id, hostId: room.playerA, playerId };
    this.events.emit('kicked', event);
    return room;
  }

  /**
   * 房主删除房间（docs/backend-api.md §5）：仅房主、仅 **WAITING**（还没人加入）时可删；
   * 有人加入（JOINED）要先请离（kick），否则 409 `ROOM_NOT_EMPTY`——避免把对手的报名直接抹掉。
   * 已激活/已结束的房间不可删（409 `ROOM_NOT_OPEN`，资产已链上锁定/结算，只能走对局流程）。
   */
  async deleteRoom(as: ChainIdentity, roomId: string): Promise<{ deleted: true; roomId: string }> {
    const room = await this.getRoom(roomId);
    if (room.playerA !== as.userId) {
      throw new AppException('NOT_HOST', `room ${roomId} belongs to ${room.playerA}`, HttpStatus.FORBIDDEN);
    }
    if (room.status === 'ACTIVE' || room.status === 'FINISHED') {
      throw new AppException('ROOM_NOT_OPEN', `room ${roomId} is ${room.status}`, HttpStatus.CONFLICT);
    }
    if (room.status !== 'WAITING' || room.playerB) {
      throw new AppException(
        'ROOM_NOT_EMPTY',
        `room ${roomId} has a challenger (${room.playerB}); kick them before deleting`,
        HttpStatus.CONFLICT,
      );
    }
    await this.redis.del(this.roomKey(room.id));
    await this.redis.srem('battle:rooms', room.id);
    await this.redis.del('cache:battle:lobby');
    return { deleted: true, roomId: room.id };
  }

  /** 屏蔽某玩家：其 join 该房主房间时 403 BLOCKED_BY_HOST（默认 30 分钟，见 PlayerBlockService）。 */
  blockPlayer(as: ChainIdentity, playerId: string) {
    return this.blocks.block(as.userId, playerId);
  }

  unblockPlayer(as: ChainIdentity, playerId: string) {
    return this.blocks.unblock(as.userId, playerId);
  }

  /** 自己的屏蔽名单（含剩余有效期），供大厅"屏蔽名单"小界面管理。 */
  listBlockedPlayers(as: ChainIdentity) {
    return this.blocks.list(as.userId);
  }

  /**
   * Lobby list. Terminal rooms (SETTLED/REFUNDED aftermath) are never listed:
   * the room is closed the moment its battle ends, and any room left behind by
   * a restart or the settle fallback is reconciled against the chain here.
   *
   * ACTIVE rooms without a live engine are the restart leftovers: once they are
   * older than the reconciliation threshold they are hidden from the list (not
   * offered as a broken "回到战斗") and a background reconciliation settles them.
   */
  async listRooms(): Promise<BattleRoom[]> {
    const cached = await this.redis.getJson<BattleRoom[]>('cache:battle:lobby').catch(() => null);
    if (cached) return cached;
    const ids = await this.redis.smembers('battle:rooms');
    const rooms: BattleRoom[] = [];
    for (const id of ids) {
      const room = await this.redis.getJson<BattleRoom>(this.roomKey(id));
      if (!room || room.status === 'FINISHED') {
        await this.redis.srem('battle:rooms', id).catch(() => undefined);
        continue;
      }
      if (room.status === 'ACTIVE' && !this.isLiveHere(room)) {
        if (await this.isBattleOver(room)) {
          room.status = 'FINISHED';
          await this.saveRoom(room);
          continue;
        }
        if (this.isAbandoned(room)) {
          this.logger.warn(`hiding stuck room ${room.id} (battle ${room.battleId} has no live engine)`);
          void this.reconcileRooms('runtime');
          continue;
        }
      }
      // WAITING / JOINED / ACTIVE stay visible so both parties can reach the live battle
      rooms.push(withNormalizedWagers(room));
    }
    rooms.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    await this.redis.setJson('cache:battle:lobby', rooms, 5).catch(() => undefined);
    return rooms;
  }

  /**
   * 房间对账（启动 / 运行期兜底）：遍历 Redis 里的房间，按链上 battle 状态收尾。
   * - SETTLED / REFUNDED / DISPUTED / 链上已查不到 → 关房出列；
   * - RESULT_SUBMITTED 但本地没引擎 → SettleBattle 兜底；
   * - ACTIVE（重启后必然没有引擎）→ 按"服务中断"以 DRAW 退款结算；
   * - CREATED 未激活 → ActivateBattle 后同样 DRAW 退款。
   * 单个房间失败只记日志，不抛出、不阻塞启动。返回处理过的房间数。
   */
  reconcileRooms(reason: 'startup' | 'runtime'): Promise<number> {
    if (!this.reconciling) {
      this.reconciling = this.runReconcile(reason).finally(() => {
        this.reconciling = null;
      });
    }
    return this.reconciling;
  }

  private async runReconcile(reason: 'startup' | 'runtime'): Promise<number> {
    let reconciled = 0;
    try {
      const ids = await this.redis.smembers('battle:rooms');
      for (const id of ids) {
        try {
          if (await this.reconcileRoom(id, reason)) reconciled += 1;
        } catch (err) {
          this.logger.warn(`room ${id} reconciliation failed (${reason}): ${(err as Error).message}`);
        }
      }
      if (reconciled > 0) {
        this.logger.log(`reconciled ${reconciled} room(s) (${reason})`);
      }
    } catch (err) {
      this.logger.warn(`room reconciliation failed (${reason}): ${(err as Error).message}`);
    }
    return reconciled;
  }

  /** 单房间对账：返回是否真的改动/关掉了这个房间。 */
  private async reconcileRoom(id: string, reason: 'startup' | 'runtime'): Promise<boolean> {
    const room = await this.redis.getJson<BattleRoom>(this.roomKey(id));
    if (!room) {
      await this.redis.srem('battle:rooms', id).catch(() => undefined);
      return false;
    }
    if (room.status === 'FINISHED') return false; // listRooms 负责出列
    if (!room.battleId) return false; // WAITING / JOINED：正常的大厅房间
    if (this.isLiveHere(room)) return false; // 本进程还有活引擎，交给引擎收尾

    const chain = await this.readBattle(room.battleId);
    if (chain.unavailable) {
      // 链读不到（网络/超时/链码失败）≠ 链上没有：保留房间，下次对账再试，绝不误关
      this.logger.warn(`room ${id}: chain unavailable for battle ${room.battleId} (${reason}) — keeping the room`);
      return false;
    }
    if (chain.status === 'SETTLED' || chain.status === 'REFUNDED' || chain.status === 'DISPUTED') {
      // 终态 / 仲裁中：无需（也无法）链上操作，只关房
    } else if (chain.status === null) {
      this.logger.warn(`closing room ${id}: battle ${room.battleId} does not exist on chain`);
    } else {
      const settled = await this.manager.settleAbandoned(room.battleId, ABANDON_NOTE);
      this.logger.log(
        `room ${id}: battle ${room.battleId} ${chain.status} -> ${settled?.status ?? 'UNKNOWN'} (${reason}, escrow refunded as DRAW)`,
      );
      await this.recordReconcile(room, chain.status, settled?.status ?? 'UNKNOWN', reason);
    }
    room.status = 'FINISHED';
    await this.saveRoom(room);
    return true;
  }

  /**
   * 对账用的链上读取：`{status}` = 正常读到；`{status: null, missing}` = 链上确认不存在；
   * `{status: null, unavailable}` = 链不可读（网络/超时等），此时不能当作"已消失"处理。
   */
  private async readBattle(battleId: string): Promise<{ status: string | null; missing?: boolean; unavailable?: boolean }> {
    try {
      const battle = await this.contract.getBattle(battleId);
      return { status: battle.status };
    } catch (err) {
      const e = err as Error & { code?: string };
      const code = e.code ?? errorCodeOf(e.message);
      if (code === 'BATTLE_NOT_FOUND' || code === 'NOT_FOUND') return { status: null, missing: true };
      return { status: null, unavailable: true };
    }
  }

  /** 对账留痕（链上 resultHash 前缀 + 链下审计），失败不影响关房。 */
  private async recordReconcile(room: BattleRoom, from: string, to: string, reason: string): Promise<void> {
    try {
      await this.audits.save(
        this.audits.create({
          actor: 'system',
          action: 'battle.reconcile',
          target: room.battleId ?? room.id,
          detail: { roomId: room.id, from, to, note: ABANDON_NOTE, trigger: reason },
        }),
      );
    } catch (err) {
      this.logger.warn(`reconcile audit write failed for room ${room.id}: ${(err as Error).message}`);
    }
  }

  /** 房间的 battle 是否还活着（本进程内存引擎存在）。 */
  private isLiveHere(room: BattleRoom): boolean {
    return !!room.battleId && !!this.manager.get(room.battleId);
  }

  /** 引擎缺失且房间超过阈值没被推进过 → 重启残留（updatedAt 为旧记录时回退 createdAt）。 */
  private isAbandoned(room: BattleRoom): boolean {
    const ts = Date.parse(room.updatedAt ?? room.createdAt);
    return Number.isFinite(ts) && Date.now() - ts > this.reconcileStaleMs;
  }

  /** 技能元数据（静态表，供战斗界面展示 威力/命中/属性/说明）。 */
  listMoves(): { moves: BattleMoveInfo[] } {
    return { moves: battleMoveCatalog() };
  }

  /** Chain status of a battle (null when it does not exist on chain). */
  async battleStatus(battleId: string): Promise<string | null> {
    try {
      return (await this.contract.getBattle(battleId)).status;
    } catch {
      return null;
    }
  }

  async joinRoom(as: ChainIdentity, roomId: string, dto: JoinRoomDto): Promise<BattleRoom> {
    const room = await this.getRoom(roomId);
    if (room.status !== 'WAITING') {
      throw new AppException('ROOM_NOT_OPEN', `room ${roomId} is ${room.status}`, HttpStatus.CONFLICT);
    }
    if (room.playerA === as.userId) {
      throw new AppException('SAME_PLAYER', 'cannot join your own room', HttpStatus.CONFLICT);
    }
    if (await this.blocks.isBlocked(room.playerA, as.userId)) {
      throw new AppException(
        'BLOCKED_BY_HOST',
        `host ${room.playerA} blocked you from joining (temporary)`,
        HttpStatus.FORBIDDEN,
      );
    }
    await this.assertTeamOwnership(as.userId, dto.teamPokemonIds);
    room.playerB = as.userId;
    room.wagerB = await this.normalizeWager(as.userId, dto.wager);
    room.teamB = dto.teamPokemonIds;
    room.joinMessage = sanitizeRoomText(dto.message) || null;
    room.confirmations = { A: false, B: false };
    room.status = 'JOINED';
    await this.saveRoom(room);
    return room;
  }

  /**
   * Wager double-confirmation; the second confirmation computes wagerHash and
   * runs CreateBattle (lock+escrow) -> ActivateBattle -> live engine, then
   * pushes `battle:activated` to both players (the first confirmer has no REST
   * response carrying the battleId, so the push is their only way in).
   */
  async confirmWager(as: ChainIdentity, roomId: string): Promise<BattleRoom> {
    const room = await this.getRoom(roomId);
    if (room.status !== 'JOINED' || !room.playerB || !room.wagerB || !room.teamB) {
      throw new AppException('ROOM_NOT_READY', `room ${roomId} is not ready for wager confirmation`, HttpStatus.CONFLICT);
    }
    if (as.userId === room.playerA) room.confirmations.A = true;
    else if (as.userId === room.playerB) room.confirmations.B = true;
    else throw new AppException('NOT_PARTY', 'you are not in this room', HttpStatus.FORBIDDEN);

    let activated: BattleActivatedEvent | null = null;
    if (room.confirmations.A && room.confirmations.B) {
      // 链上 CreateBattle 会锁定资产且不可回滚：锁资产前**重新**校验双方队伍
      // （队伍提交到押注双确认之间，宝可梦可能已在别的战斗中濒死 → FAINTED，见 docs/backend-api.md §2）
      await this.assertTeamOwnership(room.playerA, room.teamA);
      await this.assertTeamOwnership(room.playerB, room.teamB);
      const battleId = `b_${randomUUID()}`;
      const wagerHash = computeWagerHash(room.playerA, room.playerB, room.wagerA, room.wagerB);
      await this.contract.createBattle(SYSTEM_IDENTITY, {
        id: battleId,
        playerA: room.playerA,
        playerB: room.playerB,
        wagerA: room.wagerA,
        wagerB: room.wagerB,
        wagerHash,
      });
      await this.contract.activateBattle(SYSTEM_IDENTITY, battleId);
      const teamA = await this.loadTeam(room.teamA);
      const teamB = await this.loadTeam(room.teamB);
      await this.manager.startBattle(battleId, room.playerA, room.playerB, teamA, teamB);
      room.status = 'ACTIVE';
      room.battleId = battleId;
      activated = { roomId: room.id, battleId, playerIds: [room.playerA, room.playerB] };
    }
    await this.saveRoom(room);
    if (activated) this.events.emit('activated', activated);
    return room;
  }

  async forfeit(as: ChainIdentity, battleId: string): Promise<void> {
    const battle = await this.contract.getBattle(battleId);
    if (as.userId !== battle.playerA && as.userId !== battle.playerB) {
      throw new AppException('NOT_PARTY', 'you are not in this battle', HttpStatus.FORBIDDEN);
    }
    if (battle.status !== 'ACTIVE' && battle.status !== 'RESULT_SUBMITTED') {
      throw new AppException('INVALID_BATTLE_STATE', `battle is ${battle.status}`, HttpStatus.CONFLICT);
    }
    if (this.manager.get(battleId)) {
      await this.manager.forfeit(battleId, as.userId);
    } else {
      await this.contract.forfeitBattle(SYSTEM_IDENTITY, battleId, as.userId, 'forfeit');
    }
    await this.closeRoomFor(battleId);
    await this.notifySettled(battleId);
  }

  async confirmResult(as: ChainIdentity, battleId: string) {
    const settled = await this.contract.confirmBattleResult(as, battleId, as.userId);
    if (settled.status === 'SETTLED' || settled.status === 'REFUNDED') {
      await this.closeRoomFor(battleId);
      await this.notifySettled(battleId);
    }
    return settled;
  }

  async dispute(as: ChainIdentity, battleId: string, reason: string) {
    const battle = await this.contract.disputeBattle(as, battleId, as.userId, reason);
    // off-chain index for GET /battles?status=disputed (chaincode has no status query)
    await this.disputes.save(
      this.disputes.create({
        battleId,
        playerA: battle.playerA,
        playerB: battle.playerB,
        raisedBy: as.userId,
        reason,
        status: 'OPEN',
      }),
    );
    await this.closeRoomFor(battleId);
    return battle;
  }

  /** Dispute index for the admin/arbitrator console. status=disputed (default) lists open cases. */
  async listDisputes(status?: string) {
    const wanted = (status ?? 'disputed').toLowerCase();
    const records = await this.disputes.find({ order: { createdAt: 'DESC' }, take: 200 });
    return records
      .filter((r) =>
        wanted === 'all' ? true : wanted === 'resolved' || wanted === 'arbitrated' ? r.status === 'RESOLVED' : r.status === 'OPEN',
      )
      .map((r) => ({
        id: r.battleId,
        playerA: r.playerA,
        playerB: r.playerB,
        status: r.status === 'OPEN' ? 'DISPUTED' : 'ARBITRATED',
        disputeReason: r.reason,
        raisedBy: r.raisedBy,
        outcome: r.outcome,
        arbiterNote: r.arbiterNote,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt,
      }));
  }

  async arbitrate(as: ChainIdentity, battleId: string, outcome: string, note: string) {
    const user = await this.users.mustFindByUsername(as.userId);
    const arbiterIdentity: ChainIdentity = {
      mspId: user.fabricMspId || 'Org2MSP',
      role: 'arbitrator',
      userId: user.username,
    };
    const battle = await this.contract.arbitrateBattle(arbiterIdentity, battleId, outcome, note);
    await this.disputes.update(
      { battleId },
      { status: 'RESOLVED', outcome, arbiterNote: note, resolvedAt: new Date() },
    );
    await this.audits.save(
      this.audits.create({
        actor: as.userId,
        action: 'battle.arbitrate',
        target: battleId,
        detail: { outcome, note },
      }),
    );
    await this.closeRoomFor(battleId);
    await this.notifySettled(battleId);
    return battle;
  }

  async detail(battleId: string) {
    const chain = await this.contract.getBattle(battleId);
    const live = this.manager.get(battleId);
    // 房间可能已被对账清理（battleId 命中的房间没了）→ roomId 为 null，前端据此隐藏"查看押注"
    const room = await this.findRoomByBattle(battleId).catch(() => null);
    return {
      battle: chain,
      live: live ? live.engine.publicState() : null,
      roomId: room?.id ?? null,
    };
  }

  private async closeRoomFor(battleId: string): Promise<void> {
    const ids = await this.redis.smembers('battle:rooms');
    for (const id of ids) {
      const room = await this.redis.getJson<BattleRoom>(this.roomKey(id));
      if (room && room.battleId === battleId && room.status === 'ACTIVE') {
        room.status = 'FINISHED';
        await this.saveRoom(room);
      }
    }
  }

  /**
   * 结算广播：读取本局的房间（参战队伍）后向 `settled` 通道发事件，供排位 ELO / 羁绊挂钩消费。
   * 房间已被清理时回退到链上玩家字段（此时拿不到队伍，羁绊只能靠排位记录里的队伍兜底）。
   * 失败只记日志——奖励挂钩绝不能影响对战本身。
   */
  private async notifySettled(battleId: string): Promise<void> {
    try {
      const room = await this.findRoomByBattle(battleId);
      const battle = room ? null : await this.contract.getBattle(battleId).catch(() => null);
      const playerA = room?.playerA ?? battle?.playerA ?? '';
      const playerB = room?.playerB ?? battle?.playerB ?? '';
      if (!playerA || !playerB) return;
      const payload: BattleSettledEvent = {
        battleId,
        roomId: room?.id ?? null,
        playerA,
        playerB,
        teamA: room?.teamA ?? [],
        teamB: room?.teamB ?? [],
      };
      this.events.emit('settled', payload);
    } catch (err) {
      this.logger.warn(`settled fan-out failed for ${battleId}: ${(err as Error).message}`);
    }
  }

  /** 按 battleId 找房间（规模是演示级，直接遍历房间索引）。 */
  private async findRoomByBattle(battleId: string): Promise<BattleRoom | null> {
    const ids = await this.redis.smembers('battle:rooms');
    for (const id of ids) {
      const room = await this.redis.getJson<BattleRoom>(this.roomKey(id));
      if (room && room.battleId === battleId) return room;
    }
    return null;
  }

  /** True when the room's battle can no longer be re-entered (settled / refunded / gone). */
  private async isBattleOver(room: BattleRoom): Promise<boolean> {
    if (!room.battleId) return true;
    if (this.manager.get(room.battleId)) return false; // live on this server
    const status = await this.battleStatus(room.battleId);
    return !status || !LIVE_BATTLE_STATES.has(status);
  }

  private async assertTeamOwnership(playerId: string, pokemonIds: string[]): Promise<void> {
    assertTeamSize(pokemonIds);
    assertTeamUnique(pokemonIds);
    for (const id of pokemonIds) {
      const p = await this.contract.getPokemon(id).catch(() => null);
      if (!p || p.ownerId !== playerId) {
        throw new AppException('NOT_OWNER', `pokemon ${id} is not owned by ${playerId}`, HttpStatus.FORBIDDEN);
      }
      if (p.status !== 'IDLE') {
        throw new AppException('ASSET_LOCKED', `pokemon ${id} is ${p.status}`, HttpStatus.CONFLICT);
      }
      // 伤势持久化（docs/backend-api.md §2）：濒死（0 HP）的宝可梦不能进队伍提交
      if ((await this.hp.currentHp(p)) <= 0) {
        throw new AppException('FAINTED', `pokemon ${id} has fainted; heal it before battling`, HttpStatus.CONFLICT);
      }
    }
  }

  /**
   * 归一押注 DTO 为链上押注包并做基础预检（链码仍是权威校验，这里只给友好错误）：
   * 道具必须是本人的 IDLE 堆叠、qty ≤ 当前持有量；旧格式 `itemIds`/`qty=0` 的整堆语义
   * 解析为**显式数量=持有量**，房间列表/详情因此始终以 items 形态对外。
   */
  private async normalizeWager(playerId: string, input: WagerInput): Promise<WagerBundle> {
    const bundle = normalizeWagerBundle(input);
    for (const ref of bundle.items) {
      const item = await this.contract.getItem(ref.id).catch(() => null);
      if (!item) {
        throw new AppException('ITEM_NOT_FOUND', `item ${ref.id} does not exist`, HttpStatus.NOT_FOUND);
      }
      if (item.ownerId !== playerId) {
        throw new AppException('NOT_OWNER', `item ${ref.id} is not owned by ${playerId}`, HttpStatus.FORBIDDEN);
      }
      if (item.status !== 'IDLE') {
        throw new AppException('ASSET_LOCKED', `item ${ref.id} is ${item.status}`, HttpStatus.CONFLICT);
      }
      if (ref.qty === 0) ref.qty = item.quantity;
      if (ref.qty < 1 || ref.qty > item.quantity) {
        throw new AppException(
          'INSUFFICIENT_QUANTITY',
          `item ${ref.id} has ${item.quantity}, cannot wager ${ref.qty}`,
          HttpStatus.CONFLICT,
        );
      }
    }
    return bundle;
  }

  /**
   * 链上宝可梦 → 引擎入参：**满血满状态出战**（竞技只比养成与策略），
   * 不带链下 Redis 的持久伤势、结算后也不写回（docs/backend-api.md §2「伤势持久化」）。
   */
  private async loadTeam(pokemonIds: string[]): Promise<EngineMonInput[]> {
    const team: EngineMonInput[] = [];
    for (const id of pokemonIds) {
      const p = await this.contract.getPokemon(id);
      team.push({
        pokemonId: p.id,
        speciesId: p.speciesId,
        level: p.level,
        ivs: p.ivs,
        evs: p.evs,
        nature: p.nature,
        // 羁绊战斗加成：非 HP 五项 × (1 + bond/255 × 5%)（docs/backend-api.md §11）
        bond: p.bond ?? 0,
        moves: p.moves,
      });
    }
    return team;
  }
}

function withNormalizedWagers(room: BattleRoom): BattleRoom {
  return {
    ...room,
    // 房名/备注/留言是后加的字段：升级前创建的房间读出来补空值
    name: room.name ?? '',
    note: room.note ?? '',
    joinMessage: room.joinMessage ?? null,
    wagerA: normalizeRoomWager(room.wagerA) ?? EMPTY_WAGER(),
    wagerB: normalizeRoomWager(room.wagerB),
  };
}

/**
 * 房间押注读取归一：items 字段上线前创建的房间仍是旧 `{itemIds}` 形态，
 * 读取时按 normalizeWagerBundle 归一为 `items:[{id,qty:0}]`（qty=0 为整堆标记）。
 */
function normalizeRoomWager(wager: WagerBundle | null | undefined): WagerBundle | null {
  if (!wager) return null;
  return normalizeWagerBundle(wager as WagerInput);
}

function EMPTY_WAGER(): WagerBundle {
  return { pokemonIds: [], items: [], points: 0 };
}
