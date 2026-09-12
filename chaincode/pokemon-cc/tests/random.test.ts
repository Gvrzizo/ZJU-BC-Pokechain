import { createHash, createHmac } from 'node:crypto';
import { deriveRandom, sha256hex } from '../src/common/crypto';
import { CLIENT_SEED, expectCode, SERVER_SEED, T1, T2, World } from './helpers/harness';

describe('RandomContract（承诺-揭示）', () => {
  let w: World;
  beforeEach(() => {
    w = new World();
  });

  test('Commit：写入 COMMITTED，发 RandomCommitted 事件', async () => {
    const res = JSON.parse(
      await w.run(() =>
        w.random.Commit(w.systemCtx(), 'ev_1', 'capture', 'u_ash', sha256hex(SERVER_SEED), CLIENT_SEED, T1, 'idem-c1'),
      ),
    );
    expect(res).toMatchObject({ docType: 'rand', eventId: 'ev_1', purpose: 'capture', status: 'COMMITTED', serverSeed: '', resultHash: '' });
    expect(w.eventNames()).toContain('RandomCommitted');
  });

  test('Commit：eventId 重复抛 RAND_EXISTS；commitHash 非 64 hex 抛 INVALID_HASH；purpose 非法抛 INVALID_PARAM', async () => {
    await w.run(() => w.random.Commit(w.systemCtx(), 'ev_1', 'capture', 'u_ash', sha256hex(SERVER_SEED), CLIENT_SEED, T1, 'idem-c2'));
    await expectCode(
      w.run(() => w.random.Commit(w.systemCtx(), 'ev_1', 'capture', 'u_ash', sha256hex(SERVER_SEED), CLIENT_SEED, T1, 'idem-c3')),
      'RAND_EXISTS',
    );
    await expectCode(
      w.run(() => w.random.Commit(w.systemCtx(), 'ev_2', 'capture', 'u_ash', 'nothex', CLIENT_SEED, T1, 'idem-c4')),
      'INVALID_HASH',
    );
    await expectCode(
      w.run(() => w.random.Commit(w.systemCtx(), 'ev_3', 'lottery', 'u_ash', sha256hex(SERVER_SEED), CLIENT_SEED, T1, 'idem-c5')),
      'INVALID_PARAM',
    );
  });

  test('Commit：可选 meta 上链留痕（≤256 字节），GetRandom 原样返回；缺省为空串', async () => {
    const meta = JSON.stringify({ difficulty: 1.25, paidDecoy: true, note: '诱饵付费' });
    const res = JSON.parse(
      await w.run(() =>
        w.random.Commit(w.systemCtx(), 'ev_meta', 'battle', 'u_ash', sha256hex(SERVER_SEED), CLIENT_SEED, T1, 'idem-c-meta', meta),
      ),
    );
    expect(res.meta).toBe(meta);
    expect((await w.getRand('ev_meta')).meta).toBe(meta);
    // 带 meta 的事件载荷同样透传
    const ev = w.stub.committedEvents.filter((e) => e.name === 'RandomCommitted');
    expect(JSON.parse(ev[0].payload).meta).toBe(meta);
    // 不传 meta（旧调用方式）→ 空串
    await w.run(() => w.random.Commit(w.systemCtx(), 'ev_nometa', 'capture', 'u_ash', sha256hex(SERVER_SEED), CLIENT_SEED, T1, 'idem-c-nometa'));
    expect((await w.getRand('ev_nometa')).meta).toBe('');
    // 超过 256 字节（UTF-8）拒绝
    await expectCode(
      w.run(() =>
        w.random.Commit(w.systemCtx(), 'ev_toolong', 'capture', 'u_ash', sha256hex(SERVER_SEED), CLIENT_SEED, T1, 'idem-c-long', 'x'.repeat(257)),
      ),
      'INVALID_PARAM',
    );
    await expectCode(
      w.run(() =>
        w.random.Commit(w.systemCtx(), 'ev_toolong2', 'capture', 'u_ash', sha256hex(SERVER_SEED), CLIENT_SEED, T1, 'idem-c-long2', '界'.repeat(86)),
      ),
      'INVALID_PARAM',
    );
  });

  test('RevealAndVerify：seed 不匹配抛 SEED_MISMATCH 且状态保持 COMMITTED', async () => {
    await w.run(() => w.random.Commit(w.systemCtx(), 'ev_1', 'capture', 'u_ash', sha256hex(SERVER_SEED), CLIENT_SEED, T1, 'idem-c6'));
    await expectCode(
      w.run(() => w.random.RevealAndVerify(w.systemCtx(), 'ev_1', 'deadbeef'.repeat(8), T2, 'idem-r1')),
      'SEED_MISMATCH',
    );
    expect((await w.getRand('ev_1')).status).toBe('COMMITTED');
  });

  test('RevealAndVerify：成功写入 serverSeed 与 resultHash=sha256(seed|clientSeed|eventId)，→REVEALED', async () => {
    await w.run(() => w.random.Commit(w.systemCtx(), 'ev_1', 'capture', 'u_ash', sha256hex(SERVER_SEED), CLIENT_SEED, T1, 'idem-c7'));
    const res = JSON.parse(await w.run(() => w.random.RevealAndVerify(w.systemCtx(), 'ev_1', SERVER_SEED, T2, 'idem-r2')));
    const expected = createHash('sha256').update(`${SERVER_SEED}|${CLIENT_SEED}|ev_1`, 'utf8').digest('hex');
    expect(res.status).toBe('REVEALED');
    expect(res.serverSeed).toBe(SERVER_SEED);
    expect(res.resultHash).toBe(expected);
    expect(w.eventNames()).toContain('RandomRevealed');
  });

  test('RevealAndVerify：非 COMMITTED 状态抛 BAD_STATE', async () => {
    await w.commitReveal('ev_1', 'capture', 'u_ash');
    await expectCode(w.run(() => w.random.RevealAndVerify(w.systemCtx(), 'ev_1', SERVER_SEED, T2, 'idem-r3')), 'BAD_STATE');
  });

  test('派生规则：HMAC-SHA256(key=serverSeed, msg=clientSeed|eventId|n) 前 8 字节大端 / 2^64 ∈ [0,1)', () => {
    for (const n of [0, 1, 7, 42]) {
      const digest = createHmac('sha256', SERVER_SEED).update(`${CLIENT_SEED}|ev_x|${n}`, 'utf8').digest();
      const expected = Number(digest.readBigUInt64BE(0)) / 2 ** 64;
      const got = deriveRandom(SERVER_SEED, CLIENT_SEED, 'ev_x', n);
      expect(got).toBe(expected);
      expect(got).toBeGreaterThanOrEqual(0);
      expect(got).toBeLessThan(1);
    }
  });
});
