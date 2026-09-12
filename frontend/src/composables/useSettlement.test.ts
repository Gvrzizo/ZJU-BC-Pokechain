import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettlement } from './useSettlement';
import type { BattleDetail } from '@/types';

vi.mock('@/api/battles', () => ({
  confirmBattleResult: vi.fn(),
  getBattle: vi.fn(),
}));
import { confirmBattleResult, getBattle } from '@/api/battles';

function battle(overrides: Partial<BattleDetail> = {}): BattleDetail {
  return {
    id: 'b_1',
    playerA: 'ash',
    playerB: 'gary',
    wagerA: { pokemonIds: [], items: [], points: 20 },
    wagerB: { pokemonIds: [], items: [], points: 20 },
    wagerHash: 'h'.repeat(64),
    status: 'RESULT_SUBMITTED',
    result: {
      winnerId: 'ash',
      resultHash: 'r'.repeat(64),
      serverSig: 'sig',
      serverSubmitted: true,
      confirmations: { A: false, B: false },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(confirmBattleResult).mockReset();
  vi.mocked(getBattle).mockReset();
});

describe('createSettlement: 结算确认流程', () => {
  it('自动 confirm 后进入等待：显示已确认 1/2，对方确认（轮询发现 SETTLED）后置位 settled 并回调', async () => {
    vi.useFakeTimers();
    try {
      const onSettled = vi.fn();
      const flow = createSettlement('b_1', { onSettled });
      vi.mocked(confirmBattleResult).mockResolvedValue(
        battle({ result: { ...battle().result!, confirmations: { A: true, B: false } } }),
      );

      await flow.start();
      expect(confirmBattleResult).toHaveBeenCalledWith('b_1');
      expect(flow.status.value).toBe('waiting');
      expect(flow.confirmedCount.value).toBe(1);
      expect(onSettled).not.toHaveBeenCalled();

      // 对方确认 → 链上 SETTLED，轮询拿到
      vi.mocked(getBattle).mockResolvedValue({
        battle: battle({
          status: 'SETTLED',
          result: { ...battle().result!, confirmations: { A: true, B: true } },
        }),
        live: null,
      });
      await vi.advanceTimersByTimeAsync(3000);

      expect(flow.settled.value).toBe(true);
      expect(flow.status.value).toBe('settled');
      expect(flow.confirmedCount.value).toBe(2);
      expect(onSettled).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('本客户端第二次确认（直接 SETTLED）：立即置位，无需轮询', async () => {
    const onSettled = vi.fn();
    const flow = createSettlement('b_1', { onSettled });
    vi.mocked(getBattle).mockResolvedValue({ battle: battle({ status: 'SETTLED' }), live: null });
    vi.mocked(confirmBattleResult).mockResolvedValue(
      battle({
        status: 'SETTLED',
        result: { ...battle().result!, confirmations: { A: true, B: true } },
      }),
    );

    await flow.start();

    expect(flow.settled.value).toBe(true);
    expect(flow.confirmedCount.value).toBe(2);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('confirm 报错但链上已结算（兜底/并发）：判定为已交付，不提示手动重试', async () => {
    const flow = createSettlement('b_1');
    vi.mocked(confirmBattleResult).mockRejectedValue(new Error('INVALID_BATTLE_STATE'));
    vi.mocked(getBattle).mockResolvedValue({ battle: battle({ status: 'SETTLED' }), live: null });

    await flow.start();

    expect(flow.settled.value).toBe(true);
    expect(flow.status.value).toBe('settled');
    expect(flow.error.value).toBe('');
  });

  it('confirm 与复核都失败：进入 error 并保留手动"确认结算"重试', async () => {
    const flow = createSettlement('b_1');
    vi.mocked(confirmBattleResult).mockRejectedValueOnce({
      response: { data: { message: 'BATTLE_NOT_FOUND: battle b_1 does not exist' } },
    });
    vi.mocked(getBattle).mockRejectedValueOnce(new Error('network'));
    vi.mocked(confirmBattleResult).mockResolvedValueOnce(
      battle({ status: 'SETTLED', result: { ...battle().result!, confirmations: { A: true, B: true } } }),
    );

    await flow.start();
    expect(flow.status.value).toBe('error');
    expect(flow.error.value).toContain('BATTLE_NOT_FOUND');

    await flow.confirm(); // 手动重试按钮
    expect(flow.settled.value).toBe(true);
    expect(flow.error.value).toBe('');
  });

  it('stop() 后停止轮询（不再请求链上状态）', async () => {
    vi.useFakeTimers();
    try {
      const flow = createSettlement('b_1');
      vi.mocked(confirmBattleResult).mockResolvedValue(battle());
      vi.mocked(getBattle).mockResolvedValue({ battle: battle(), live: null });

      await flow.start();
      await vi.advanceTimersByTimeAsync(3000);
      const calls = vi.mocked(getBattle).mock.calls.length;
      expect(calls).toBeGreaterThan(0);

      flow.stop();
      await vi.advanceTimersByTimeAsync(9000);
      expect(vi.mocked(getBattle).mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
