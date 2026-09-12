import { computed, ref } from 'vue';
import { confirmBattleResult, getBattle } from '@/api/battles';
import type { BattleDetail } from '@/types';

export type SettlementStatus = 'idle' | 'sending' | 'waiting' | 'settled' | 'error';

/**
 * 结算确认流程（收到 battle:end 后调用，双方客户端都自动执行）：
 * 1. POST /battles/:id/result/confirm 确认结果；
 * 2. 未结算时每 3s 轮询 GET /battles/:id，刷新"已确认 x/2"并等待对方；
 * 3. 第二次确认（或兜底 SettleBattle）后链上 SETTLED → settled 置位并回调 onSettled
 *    （视图据此提示"押注已交付"并刷新背包/积分）；
 * 4. 请求失败时进入 error（视图给出手动"确认结算"按钮），并先复核一次链上状态，
 *    避免兜底结算已完成时误报错误。
 */
export function createSettlement(
  battleId: string,
  hooks: { onSettled?: () => void; pollMs?: number } = {},
) {
  const status = ref<SettlementStatus>('idle');
  const confirmations = ref<{ A: boolean; B: boolean }>({ A: false, B: false });
  const error = ref('');
  const settled = ref(false);
  const confirmedCount = computed(
    () => (confirmations.value.A ? 1 : 0) + (confirmations.value.B ? 1 : 0),
  );
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function markSettled() {
    settled.value = true;
    status.value = 'settled';
    stop();
    hooks.onSettled?.();
  }

  /** 用一次链上 battle 快照刷新确认数 / 结算状态 */
  function applyBattle(battle: BattleDetail) {
    if (battle.result?.confirmations) confirmations.value = battle.result.confirmations;
    if (battle.status === 'SETTLED' || battle.status === 'REFUNDED') {
      markSettled();
      return;
    }
    if (!settled.value) {
      status.value = 'waiting';
      startPolling();
    }
  }

  function startPolling() {
    if (pollTimer || settled.value) return;
    pollTimer = setInterval(() => {
      void (async () => {
        try {
          const res = await getBattle(battleId);
          applyBattle(res.battle);
        } catch {
          /* 网络抖动：下一轮再试，不打断等待 */
        }
      })();
    }, hooks.pollMs ?? 3000);
  }

  /** 手动确认（自动确认失败后的"确认结算"按钮也走这里） */
  async function confirm(): Promise<void> {
    if (settled.value) return;
    status.value = 'sending';
    error.value = '';
    try {
      applyBattle(await confirmBattleResult(battleId));
    } catch (e: unknown) {
      // 已结算（兜底 SettleBattle / 对方确认后并发）时 POST 会报状态错误：
      // 先复核一次链上状态，确实失败才提示手动重试
      const res = await getBattle(battleId).catch(() => null);
      if (res) {
        applyBattle(res.battle);
        return;
      }
      const detail = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      error.value = detail ?? '确认结算失败，请重试';
      status.value = 'error';
    }
  }

  /** 开局自动确认（battle:end / 进入待确认的对局时调用） */
  function start(): Promise<void> {
    return confirm();
  }

  return { status, confirmations, confirmedCount, error, settled, start, confirm, stop };
}
