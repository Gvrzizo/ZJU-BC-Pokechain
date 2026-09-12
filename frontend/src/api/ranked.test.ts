import { describe, expect, it } from 'vitest';
import { MESSAGES } from '@/locales';
import {
  ARENA_ENTRY_FEES,
  RANK_TIERS,
  arenaEntryFor,
  arenaSubsidyFor,
  nextTier,
  tierOf,
  tierProgress,
} from './ranked';

describe('段位分档（docs/backend-api.md §11）', () => {
  it('青铜 <1200 白银 <1400 黄金 <1600 白金 <1800 大师', () => {
    expect(tierOf(1000).key).toBe('bronze');
    expect(tierOf(1199).key).toBe('bronze');
    expect(tierOf(1200).key).toBe('silver');
    expect(tierOf(1399).key).toBe('silver');
    expect(tierOf(1400).key).toBe('gold');
    expect(tierOf(1599).key).toBe('gold');
    expect(tierOf(1600).key).toBe('platinum');
    expect(tierOf(1800).key).toBe('master');
    expect(tierOf(99999).key).toBe('master');
  });

  it('段位表覆盖 0-99999 且分段连续', () => {
    expect(RANK_TIERS[0].min).toBe(0);
    for (let i = 1; i < RANK_TIERS.length; i += 1) {
      expect(RANK_TIERS[i].min).toBe(RANK_TIERS[i - 1].max);
    }
    expect(RANK_TIERS[RANK_TIERS.length - 1].max).toBeGreaterThanOrEqual(99999);
  });

  it('下一段位与差值、大师没有下一档', () => {
    expect(nextTier(1000)).toMatchObject({ tier: { key: 'silver' }, points: 200 });
    expect(nextTier(1399)?.points).toBe(1);
    expect(nextTier(1800)).toBeNull();
  });

  it('段位内进度 0-100', () => {
    expect(tierProgress(0)).toBeCloseTo(0, 5);
    expect(tierProgress(600)).toBeCloseTo(50, 5);
    expect(tierProgress(1000)).toBeCloseTo(83.33, 1);
    expect(tierProgress(1800)).toBe(100);
  });
});

describe('积分场准入（docs/backend-api.md §10/§11）', () => {
  it('准入额按段位：青铜 20 / 白银 50 / 黄金 100 / 白金 200 / 大师 400', () => {
    expect(ARENA_ENTRY_FEES).toEqual({ bronze: 20, silver: 50, gold: 100, platinum: 200, master: 400 });
    expect(arenaEntryFor(0)).toBe(20);
    expect(arenaEntryFor(1199)).toBe(20);
    expect(arenaEntryFor(1200)).toBe(50);
    expect(arenaEntryFor(1400)).toBe(100);
    expect(arenaEntryFor(1699)).toBe(200);
    expect(arenaEntryFor(1800)).toBe(400);
    expect(arenaEntryFor(99999)).toBe(400);
    // 每个段位都有准入额（帮助面板按段位表逐行展示）
    for (const tier of RANK_TIERS) expect(ARENA_ENTRY_FEES[tier.key]).toBeGreaterThan(0);
  });

  it('系统补贴 = 准入额 ×50% 向下取整', () => {
    expect(arenaSubsidyFor(20)).toBe(10);
    expect(arenaSubsidyFor(50)).toBe(25);
    expect(arenaSubsidyFor(100)).toBe(50);
    expect(arenaSubsidyFor(200)).toBe(100);
    expect(arenaSubsidyFor(400)).toBe(200);
  });
});

describe('排位帮助文案键（RankedView 帮助面板）', () => {
  const HELP_KEYS = [
    'ranked.help',
    'ranked.help.title',
    'ranked.help.close',
    'ranked.help.tiers',
    'ranked.help.tierCol',
    'ranked.help.ratingCol',
    'ranked.help.entryCol',
    'ranked.help.eloTitle',
    'ranked.help.elo',
    'ranked.help.eloGap',
    'ranked.help.matchTitle',
    'ranked.help.window',
    'ranked.help.accept',
    'ranked.help.decline',
    'ranked.help.botTitle',
    'ranked.help.botOffer',
    'ranked.help.botHalved',
    'ranked.help.botLimit',
    'ranked.help.arenaTitle',
    'ranked.help.arenaEntry',
    'ranked.help.arenaReward',
    'ranked.help.arenaDraw',
    'ranked.help.arenaSubsidy',
    'ranked.help.arenaAntiAbuse',
  ];
  const QUEUE_KEYS = [
    'ranked.mode.casual',
    'ranked.mode.arena',
    'ranked.mode.casualHint',
    'ranked.mode.arenaFee',
    'ranked.pending.title',
    'ranked.pending.deadline',
    'ranked.pending.entry',
    'ranked.pending.accept',
    'ranked.pending.decline',
    'ranked.pending.accepted',
    'ranked.bot.title',
    'ranked.bot.rule',
    'ranked.bot.accept',
    'ranked.matchedBot',
  ];

  it('中英双语都收录帮助与排队/机器人/积分场文案', () => {
    for (const key of [...HELP_KEYS, ...QUEUE_KEYS]) {
      expect(MESSAGES.zh.ui[key], `zh ${key}`).toBeTruthy();
      expect(MESSAGES.en.ui[key], `en ${key}`).toBeTruthy();
    }
  });

  it('关键规则数字写进文案（扩圈 / 接受期 / 机器人减半与每日上限 / 补贴上限）', () => {
    expect(MESSAGES.zh.ui['ranked.help.window']).toContain('±200');
    expect(MESSAGES.zh.ui['ranked.help.window']).toContain('±1000');
    expect(MESSAGES.zh.ui['ranked.help.accept']).toContain('15');
    expect(MESSAGES.zh.ui['ranked.help.botHalved']).toContain('×0.5');
    expect(MESSAGES.zh.ui['ranked.help.botLimit']).toContain('5');
    expect(MESSAGES.zh.ui['ranked.help.arenaSubsidy']).toContain('3');
    expect(MESSAGES.zh.ui['ranked.help.arenaAntiAbuse']).toContain('400');
    expect(MESSAGES.zh.ui['ranked.help.elo']).toContain('K=32');
    // 排队文案要带当前窗口占位符
    expect(MESSAGES.zh.ui['ranked.queued']).toContain('{window}');
    expect(MESSAGES.en.ui['ranked.queued']).toContain('{window}');
  });
});
