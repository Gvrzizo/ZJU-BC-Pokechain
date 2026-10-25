import { describe, expect, it } from 'vitest';
import { myTradeConfirmed } from './trade-confirm';

const trade = { fromId: 'ash', confirmations: { from: true, to: false } };

describe('交易确认状态（H14）', () => {
  it('发起方按 username 匹配 fromId：对方确认后我方状态正确', () => {
    expect(myTradeConfirmed(trade, 'ash')).toBe(true);
    // 对方视角：request 侧尚未确认
    expect(myTradeConfirmed(trade, 'gary')).toBe(false);
  });

  it('未登录/username 为空时安全返回 false（不再拿 UUID 比较）', () => {
    expect(myTradeConfirmed(trade, undefined)).toBe(false);
    expect(myTradeConfirmed(trade, '')).toBe(false);
  });
});
