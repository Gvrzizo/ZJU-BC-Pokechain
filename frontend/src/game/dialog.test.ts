import { describe, expect, it } from 'vitest';
import { DialogSession, sessionFrom } from './dialog';

/** 对话框状态机：逐句翻页 → 翻完最后一句返回 true（调用方据此执行待办动作） */
describe('DialogSession', () => {
  it('单页多句：每翻一次换一行，最后一句翻完结束', () => {
    const session = new DialogSession([{ speaker: '护士', lines: ['你好', '要治疗吗？'] }]);
    expect(session.isOpen).toBe(true);
    expect(session.speaker).toBe('护士');
    expect(session.line).toBe('你好');
    expect(session.isLastLine).toBe(false);

    expect(session.advance()).toBe(false);
    expect(session.line).toBe('要治疗吗？');
    expect(session.isLastLine).toBe(true);

    expect(session.advance()).toBe(true);
    expect(session.isOpen).toBe(false);
    expect(session.line).toBe('');
    expect(session.advance()).toBe(true); // 结束后再翻仍是结束
  });

  it('多页：翻完一页自动进下一页，并给出页码', () => {
    const session = new DialogSession([
      { speaker: '路牌', lines: ['101 号道路', '走进深草会遇到野生宝可梦。'] },
      { speaker: '捕虫少年', lines: ['这里的怪都很温顺。'] },
    ]);
    expect(session.progress).toEqual({ page: 1, total: 2 });
    expect(session.advance()).toBe(false); // 第一页第二句
    expect(session.progress).toEqual({ page: 1, total: 2 });
    expect(session.advance()).toBe(false); // 翻页
    expect(session.progress).toEqual({ page: 2, total: 2 });
    expect(session.speaker).toBe('捕虫少年');
    expect(session.advance()).toBe(true);
  });

  it('空对话直接结束；close() 立即结束', () => {
    const empty = new DialogSession([]);
    expect(empty.isOpen).toBe(false);
    expect(empty.advance()).toBe(true);

    const session = new DialogSession([{ speaker: '门', lines: ['需要 天空之钥 才能进入。'] }]);
    session.close();
    expect(session.isOpen).toBe(false);
  });

  it('sessionFrom 合并同一说话人的连续段落、丢掉空段', () => {
    const session = sessionFrom([
      { speaker: '老人', lines: ['第一句'] },
      { speaker: '老人', lines: ['第二句'] },
      { speaker: '孩子', lines: [] },
      { speaker: '孩子', lines: ['第三句'] },
    ]);
    expect(session.progress).toEqual({ page: 1, total: 2 });
    expect(session.advance()).toBe(false); // 老人第二句（同页合并成两句）
    expect(session.advance()).toBe(false); // 翻到孩子
    expect(session.speaker).toBe('孩子');
    expect(session.advance()).toBe(true);
  });
});
