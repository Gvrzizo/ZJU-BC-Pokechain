import { generateKeyPairSync } from 'crypto';
import { BattleLog } from '../src/battles/entities/battle-log.entity';
import { SigningService } from '../src/battles/signing.service';
import { buildBattleFairness, parseBattleEventId } from '../src/fairness/fairness.battle';
import { FairnessController } from '../src/fairness/fairness.controller';
import { BattleState } from '../src/fabric/chain.types';
import { makeConfig, mockRepo } from './helpers';

const RESULT_HASH = 'ab'.repeat(32);

function logRow(overrides: Partial<BattleLog> = {}): BattleLog {
  return {
    id: 'log-1',
    battleId: 'b_1',
    turnsJson: [
      { t: 1, type: 'move', side: 'A', move: 'tackle' },
      { t: 2, type: 'move', side: 'B', move: 'growl' },
    ],
    resultHash: RESULT_HASH,
    serverSig: '30'.repeat(70),
    serverKeyId: 'key-from-log',
    createdAt: new Date('2026-10-25T00:00:00Z'),
    ...overrides,
  };
}

function chainResult(overrides: Partial<BattleState['result']> = {}): BattleState {
  return {
    result: {
      winnerId: 'ash',
      resultHash: 'cd'.repeat(32),
      serverSig: 'ef'.repeat(70),
      serverSubmitted: true,
      confirmations: { A: true, B: true },
      ...overrides,
    },
  } as unknown as BattleState;
}

/** 纯 builder：仓库/合约都是内存 stub，不碰 DB 与网络。 */
describe('战斗公平性 payload（P2-3）', () => {
  it('只把 ev_battle_<battleId> 识别为战斗事件', () => {
    expect(parseBattleEventId('ev_battle_b_abc')).toBe('b_abc');
    expect(parseBattleEventId('ev_battle_')).toBeUndefined();
    expect(parseBattleEventId('ev_capture_b_abc')).toBeUndefined();
    expect(parseBattleEventId('ev_battle')).toBeUndefined();
    expect(parseBattleEventId('xx_ev_battle_b_1')).toBeUndefined();
  });

  it('有回放日志：resultHash/serverSig/turnLog 取自 battle_logs，winnerId 取链上', async () => {
    const battleLogs = mockRepo<BattleLog>();
    await battleLogs.save(logRow());

    const payload = await buildBattleFairness('b_1', {
      battleLogs,
      contract: { getBattle: async () => chainResult() },
      fallbackKeyId: 'current-key',
    });

    expect(payload).toMatchObject({
      battleId: 'b_1',
      winnerId: 'ash',
      resultHash: RESULT_HASH,
      serverKeyId: 'key-from-log',
    });
    expect(payload.turnLog).toHaveLength(2);
    expect(payload.serverSig).toBe('30'.repeat(70));
  });

  it('日志缺失：turnLog 为 null，hash/sig 回退链上结果且不崩溃', async () => {
    const payload = await buildBattleFairness('b_1', {
      battleLogs: mockRepo<BattleLog>(),
      contract: { getBattle: async () => chainResult({ winnerId: 'DRAW' }) },
      fallbackKeyId: 'current-key',
    });

    expect(payload.turnLog).toBeNull();
    expect(payload.resultHash).toBe('cd'.repeat(32));
    expect(payload.serverSig).toBe('ef'.repeat(70));
    expect(payload.winnerId).toBe('DRAW');
    // 没有 battle_logs 行就不知道是哪把钥匙签的，不能冒充当前 keyId
    expect(payload.serverKeyId).toBe('');
  });

  it('仓库与链上查询都失败：返回空字段而不是让公平性接口 500', async () => {
    const payload = await buildBattleFairness('b_missing', {
      contract: {
        getBattle: async () => {
          throw new Error('chain down');
        },
      },
      battleLogs: {
        findOne: async () => {
          throw new Error('db down');
        },
      },
      fallbackKeyId: 'current-key',
    });

    expect(payload).toMatchObject({
      battleId: 'b_missing',
      winnerId: '',
      resultHash: '',
      serverSig: '',
      serverKeyId: '',
      turnLog: null,
    });
  });

  it('turnsJson 非数组（旧/异常行）按缺失回放处理', async () => {
    const battleLogs = mockRepo<BattleLog>();
    await battleLogs.save(logRow({ turnsJson: null as unknown as unknown[] }));

    const payload = await buildBattleFairness('b_1', {
      battleLogs,
      contract: { getBattle: async () => chainResult() },
    });
    expect(payload.turnLog).toBeNull();
    expect(payload.resultHash).toBe(RESULT_HASH);
  });
});

describe('FairnessController 战斗披露（P2-3）', () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const signing = new SigningService(
    makeConfig({
      serverSigningKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }),
  );

  function randomFor(eventId: string, purpose: 'capture' | 'battle') {
    return {
      docType: 'rand' as const,
      eventId,
      purpose,
      playerId: 'system',
      commitHash: '11'.repeat(32),
      clientSeed: 'client',
      serverSeed: 'server',
      resultHash: RESULT_HASH,
      status: 'REVEALED' as const,
      createdAt: '2026-10-25T00:00:00Z',
      meta: '',
    };
  }

  it('ev_battle_<id> 返回 battle，签名可用服务端公钥复核', async () => {
    const battleLogs = mockRepo<BattleLog>();
    const resultHash = RESULT_HASH;
    const serverSig = signing.signResultHash(resultHash);
    await battleLogs.save(logRow({ resultHash, serverSig, serverKeyId: signing.keyId }));

    const contract = {
      getRandom: async (eventId: string) => randomFor(eventId, 'battle'),
      getBattle: async () => chainResult({ resultHash, serverSig }),
    };
    const controller = new FairnessController(contract as never, signing, battleLogs as never);
    const res = await controller.fairness('ev_battle_b_1');

    expect(res.revealed).toBe(true);
    expect(res.serverKeyId).toBe(signing.keyId);
    expect(res.battle).toMatchObject({
      battleId: 'b_1',
      winnerId: 'ash',
      resultHash,
      serverSig,
      serverKeyId: signing.keyId,
    });
    expect(res.battle?.turnLog).toHaveLength(2);
    expect(signing.verifyResultHash(res.battle!.resultHash, res.battle!.serverSig)).toBe(true);
  });

  it('捕捉事件保持原响应（不含 battle 字段）', async () => {
    const contract = {
      getRandom: async (eventId: string) => randomFor(eventId, 'capture'),
      getBattle: async () => {
        throw new Error('must not be called for capture events');
      },
    };
    const controller = new FairnessController(contract as never, signing);
    const res = await controller.fairness('ev_capture_1');

    expect('battle' in res).toBe(false);
    expect(res.event.serverSeed).toBe('server');
  });
});
