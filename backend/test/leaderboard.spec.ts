import { Subject } from 'rxjs';
import { LeaderboardController } from '../src/leaderboard/leaderboard.controller';
import { ChainEvent } from '../src/fabric/chain-events.service';
import { makeRedis } from './helpers';

/** 等事件回调里的 fire-and-forget refresh 执行完 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function makeController(points: Record<string, number>) {
  const redis = makeRedis();
  const subject = new Subject<ChainEvent>();
  const contract = {
    getPlayer: jest.fn(async (id: string) => ({ playerId: id, points: points[id] ?? 0 })),
  };
  const controller = new LeaderboardController(redis, contract as never, {
    stream$: subject.asObservable(),
  } as never);
  controller.onModuleInit();
  return { controller, subject, contract };
}

describe('积分排行榜缓存刷新（H4：真链事件 → Redis ZSET）', () => {
  it('BattleSettled 的 winnerId 也会触发刷新（事件不带 playerId 时不再漏分）', async () => {
    const { controller, subject } = makeController({ ash: 1050, gary: 950 });
    subject.next({
      name: 'BattleSettled',
      payload: { id: 'b_h4', winnerId: 'ash', playerA: 'ash', playerB: 'gary' },
    });
    await flush();
    expect(await controller.board()).toEqual([
      { rank: 1, playerId: 'ash', points: 1050 },
      { rank: 2, playerId: 'gary', points: 950 },
    ]);
  });

  it('交易 PointsChanged 的 fromId/toId 都会刷新', async () => {
    const { controller, subject } = makeController({ ash: 900, gary: 1100 });
    subject.next({
      name: 'PointsChanged',
      payload: { fromId: 'ash', toId: 'gary', amount: 200, reason: 'trade' },
    });
    await flush();
    const board = await controller.board();
    expect(board).toHaveLength(2);
    expect(board.find((e) => e.playerId === 'ash')?.points).toBe(900);
    expect(board.find((e) => e.playerId === 'gary')?.points).toBe(1100);
  });
});
