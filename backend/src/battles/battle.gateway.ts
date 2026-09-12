import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { ChainEventsService } from '../fabric/chain-events.service';
import { BattleManagerService } from './battle-manager.service';
import { BattlesService } from './battles.service';
import { ClientBattleAction, toEngineAction } from './battle-action';
import { errorCodeOf } from './battle-error';

interface AuthedSocket extends Socket {
  data: { username?: string; sub?: string; battles?: string[] };
}

/**
 * /battle namespace: JWT-authenticated, server-authoritative battle transport.
 * C->S: battle:join, battle:action. S->C: battle:state, battle:turn, battle:entry,
 * battle:end, battle:error, battle:activated (lobby push), plus asset:changed
 * pushes driven by chain events.
 */
@WebSocketGateway({ namespace: '/battle', cors: { origin: true, credentials: true } })
export class BattleGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(BattleGateway.name);

  @WebSocketServer()
  server: Namespace;

  constructor(
    private readonly jwt: JwtService,
    private readonly manager: BattleManagerService,
    private readonly chainEvents: ChainEventsService,
    private readonly battles: BattlesService,
  ) {}

  afterInit(): void {
    this.manager.events.on('state', (battleId: string, state: unknown) => {
      this.server.to(roomOf(battleId)).emit('battle:state', { battleId, state });
    });
    this.manager.events.on('turn', (battleId: string, payload: unknown) => {
      this.server.to(roomOf(battleId)).emit('battle:turn', { battleId, ...(payload as object) });
    });
    this.manager.events.on('entry', (battleId: string, payload: unknown) => {
      this.server.to(roomOf(battleId)).emit('battle:entry', { battleId, ...(payload as object) });
    });
    this.manager.events.on('end', (battleId: string, payload: unknown) => {
      this.server.to(roomOf(battleId)).emit('battle:end', { battleId, ...(payload as object) });
    });
    this.manager.events.on('presence', (battleId: string, payload: unknown) => {
      this.server.to(roomOf(battleId)).emit('battle:presence', { battleId, ...(payload as object) });
    });
    // wager double-confirm activated a battle -> both parties get pushed to /battle/:id
    this.battles.events.on('activated', (payload: { roomId: string; battleId: string; playerIds: string[] }) => {
      for (const playerId of payload.playerIds ?? []) {
        this.server.to(`user:${playerId}`).emit('battle:activated', {
          roomId: payload.roomId,
          battleId: payload.battleId,
        });
      }
    });
    // host kicked the joiner -> the kicked player is told right away (大厅另有轮询兜底)
    this.battles.events.on('kicked', (payload: { roomId: string; hostId: string; playerId: string }) => {
      this.server.to(`user:${payload.playerId}`).emit('battle:room-kicked', {
        roomId: payload.roomId,
        hostId: payload.hostId,
        playerId: payload.playerId,
      });
    });
    // chain events -> asset refresh push (docs/backend-api.md §8)
    this.chainEvents.stream$.subscribe(({ name, payload }) => {
      const playerIds = [payload.ownerId, payload.playerId, payload.toId, payload.playerA, payload.playerB]
        .filter((v): v is string => typeof v === 'string' && !!v);
      for (const pid of new Set(playerIds)) {
        this.server.to(`user:${pid}`).emit('asset:changed', { event: name, payload });
      }
    });
  }

  async handleConnection(client: AuthedSocket): Promise<void> {
    try {
      const token =
        (client.handshake.auth?.token as string) ??
        (client.handshake.headers.authorization ?? '').replace(/^Bearer /, '');
      const payload = await this.jwt.verifyAsync<{ sub: string; username: string }>(token);
      client.data.username = payload.username;
      client.data.sub = payload.sub;
      await client.join(`user:${payload.username}`);
    } catch {
      client.emit('battle:error', { code: 'UNAUTHORIZED' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: AuthedSocket): void {
    const username = client.data.username;
    if (!username) return;
    for (const battleId of client.data.battles ?? []) {
      this.manager.playerDisconnected(battleId, username);
    }
  }

  @SubscribeMessage('battle:join')
  async onJoin(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { battleId?: string },
  ): Promise<void> {
    const username = client.data.username;
    const battleId = body?.battleId;
    if (!username || !battleId) {
      client.emit('battle:error', { code: 'BAD_REQUEST' });
      return;
    }
    const battle = this.manager.get(battleId);
    if (!battle) {
      // finished / never started: tell the client why so it can leave the screen
      const status = await this.battles.battleStatus(battleId);
      client.emit('battle:error', {
        code: 'BATTLE_NOT_LIVE',
        message: status ? `battle is ${status}` : 'battle is not live on this server',
        status,
      });
      return;
    }
    if (battle.playerA !== username && battle.playerB !== username) {
      client.emit('battle:error', { code: 'NOT_PARTY' });
      return;
    }
    await client.join(roomOf(battleId));
    client.data.battles = [...new Set([...(client.data.battles ?? []), battleId])];
    this.manager.enterBattle(battleId, username);
    client.emit('battle:state', { battleId, state: battle.engine.publicState(), you: battle.playerA === username ? 'A' : 'B' });
  }

  @SubscribeMessage('battle:action')
  onAction(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { battleId?: string; seq?: number; action?: ClientBattleAction },
  ): void {
    const username = client.data.username;
    if (!username || !body?.battleId || !body.action) {
      client.emit('battle:error', { code: 'BAD_REQUEST', message: 'battle:action requires {battleId, action}', seq: body?.seq });
      return;
    }
    try {
      // the client speaks asset ids (moveId / targetPokemonId); the engine is slot-indexed
      const battle = this.manager.get(body.battleId);
      if (!battle) throw new Error('BATTLE_NOT_LIVE: battle is not live on this server');
      const side = this.manager.sideOf(battle, username);
      if (!side) throw new Error('NOT_PARTY: you are not in this battle');
      this.manager.submitAction(body.battleId, username, toEngineAction(battle.engine, side, body.action));
    } catch (err) {
      const msg = (err as Error).message;
      client.emit('battle:error', { code: errorCodeOf(msg), message: msg, seq: body.seq });
    }
  }
}

function roomOf(battleId: string): string {
  return `battle:${battleId}`;
}

declare module 'socket.io' {
  interface SocketData {
    username?: string;
    sub?: string;
    battles?: string[];
  }
}
