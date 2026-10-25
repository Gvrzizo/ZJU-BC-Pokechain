import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FairnessResponse } from '@/types';
import { canonicalize } from './canonical';
import { buildFairnessChecks } from './fairness-checks';

/** 回合日志 fixture：字段插入顺序与字典序不同（朴素 JSON.stringify 会得出不同哈希）。 */
const TURN_LOG = [
  {
    type: 'move',
    turn: 1,
    actor: { side: 'A', name: 'pikachu' },
    move: 'thunder-shock',
    damage: 17,
    critical: false,
  },
  {
    type: 'move',
    turn: 2,
    actor: { side: 'B', name: 'eevee' },
    move: 'tackle',
    damage: 9,
    critical: false,
  },
];

const pair = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
const PUBLIC_PEM = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const KEY_ID = createHash('sha256').update(PUBLIC_PEM).digest('hex').slice(0, 16);
const RESULT_HASH = createHash('sha256').update(canonicalize(TURN_LOG)).digest('hex');
const SERVER_SIG = cryptoSign('sha256', Buffer.from(RESULT_HASH, 'hex'), pair.privateKey).toString('hex');

function makeRecord(battle: FairnessResponse['battle'] = defaultBattle()): FairnessResponse {
  const serverSeed = 'ab'.repeat(32);
  const clientSeed = 'cd'.repeat(16);
  const eventId = 'ev_battle_b_1';
  const commitHash = createHash('sha256').update(serverSeed).digest('hex');
  const eventResultHash = createHash('sha256').update(`${serverSeed}|${clientSeed}|${eventId}`).digest('hex');
  return {
    event: {
      eventId,
      purpose: 'battle',
      playerId: 'system',
      commitHash,
      clientSeed,
      serverSeed,
      resultHash: eventResultHash,
      status: 'REVEALED',
    },
    revealed: true,
    derivation: {},
    serverPublicKey: PUBLIC_PEM,
    serverKeyId: KEY_ID,
    battle,
  };
}

function defaultBattle(): NonNullable<FairnessResponse['battle']> {
  return {
    battleId: 'b_1',
    winnerId: 'ash',
    resultHash: RESULT_HASH,
    serverSig: SERVER_SIG,
    serverKeyId: KEY_ID,
    turnLog: TURN_LOG,
  };
}

const canonicalCheck = (checks: Awaited<ReturnType<typeof buildFairnessChecks>>) =>
  checks.find((c) => c.label.startsWith('sha256(canonical(回合日志))'));
const signatureCheck = (checks: Awaited<ReturnType<typeof buildFairnessChecks>>) =>
  checks.find((c) => c.label.startsWith('serverSig 验签'));

describe('buildFairnessChecks（P2-3）', () => {
  it('合法战斗回放 + Node 签名：两处战斗检查都通过', async () => {
    const checks = await buildFairnessChecks(makeRecord());

    expect(canonicalCheck(checks)).toMatchObject({ pass: true });
    expect(signatureCheck(checks)).toMatchObject({ pass: true });
    // 捕捉侧原有检查也在（承诺/resultHash/派生流抽查）
    expect(checks.find((c) => c.label.startsWith('sha256(serverSeed) == commitHash'))?.pass).toBe(true);
    expect(checks.find((c) => c.label.includes('派生流抽查'))?.pass).toBe(true);
    expect(checks.every((c) => c.pass)).toBe(true);
  });

  it('fixture 的键序确实会让朴素 JSON.stringify 得到不同哈希（证明用的是 canonical）', () => {
    const naive = createHash('sha256').update(JSON.stringify(TURN_LOG)).digest('hex');
    expect(naive).not.toBe(RESULT_HASH);
  });

  it('篡改 serverSig：回放复算仍通过，验签失败', async () => {
    const tampered = `${SERVER_SIG.slice(0, -2)}${SERVER_SIG.endsWith('00') ? '01' : '00'}`;
    const checks = await buildFairnessChecks(
      makeRecord({ ...defaultBattle(), serverSig: tampered }),
    );
    expect(canonicalCheck(checks)?.pass).toBe(true);
    expect(signatureCheck(checks)?.pass).toBe(false);
  });

  it('篡改 resultHash：回放复算与验签都失败', async () => {
    const wrongHash = 'ff'.repeat(32);
    const checks = await buildFairnessChecks(makeRecord({ ...defaultBattle(), resultHash: wrongHash }));
    expect(canonicalCheck(checks)?.pass).toBe(false);
    expect(signatureCheck(checks)?.pass).toBe(false);
  });

  it('turnLog 缺失：显示"无回放日志，仅展示链上签名"且不标记通过', async () => {
    const checks = await buildFairnessChecks(makeRecord({ ...defaultBattle(), turnLog: null }));
    const missing = checks.find((c) => c.label.startsWith('无回放日志'));
    expect(missing).toMatchObject({ pass: false });
    expect(canonicalCheck(checks)).toBeUndefined();
    // 签名本身仍可验证（签名覆盖的是链上 resultHash），但不能据此声称复算通过
    expect(signatureCheck(checks)?.pass).toBe(true);
  });

  it('捕捉事件（无 battle）：只保留捕捉侧检查，不误报战斗失败', async () => {
    const record = makeRecord();
    delete record.battle;
    const checks = await buildFairnessChecks(record);
    expect(checks.some((c) => c.label.includes('回合日志') || c.label.includes('serverSig'))).toBe(false);
    expect(checks.every((c) => c.pass)).toBe(true);
  });

  it('COMMITTED 阶段（无 serverSeed）：不显示战斗复算通过的假象', async () => {
    const record = makeRecord();
    record.event.serverSeed = '';
    record.event.resultHash = '';
    record.revealed = false;
    const checks = await buildFairnessChecks(record);
    expect(checks[0].pass).toBe(true);
    expect(checks[0].label).toContain('结算后揭示');
    expect(canonicalCheck(checks)?.pass).toBe(true); // battle 字段已揭示时仍可复算
    expect(signatureCheck(checks)?.pass).toBe(true);
  });
});
