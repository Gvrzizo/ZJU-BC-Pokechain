/**
 * 交易确认状态（H14）：`Trade.fromId/toId` 是链上 playerId = username，
 * 不是 `auth.user.id`（UUID）。用 UUID 比较会让发起方在对方先确认后仍显示"未确认"。
 */
export function myTradeConfirmed(
  trade: { fromId: string; confirmations: { from: boolean; to: boolean } },
  username?: string | null,
): boolean {
  if (!username) return false;
  return trade.fromId === username ? trade.confirmations.from : trade.confirmations.to;
}
