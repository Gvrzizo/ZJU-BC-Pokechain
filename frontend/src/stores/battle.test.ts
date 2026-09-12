import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  BATTLE_ERROR_TEXT,
  battleErrorText,
  moveDetailText,
  moveStatsLine,
  useBattleStore,
} from './battle';
import type { BattleMoveInfo } from '@/types';

const flamethrower: BattleMoveInfo = {
  id: 'flamethrower',
  name: 'Flamethrower',
  type: 'fire',
  power: 90,
  accuracy: 100,
  category: 'special',
  effectText: '',
};

describe('battle error messages', () => {
  it('turns server codes into readable Chinese text', () => {
    expect(battleErrorText('UNKNOWN_MOVE')).toContain('技能');
    expect(battleErrorText('ITEM_NOT_SUPPORTED')).toContain('道具');
    expect(battleErrorText('BATTLE_ERROR')).toBe(BATTLE_ERROR_TEXT.BATTLE_ERROR);
  });

  it('keeps an unmapped code and the server detail visible instead of hiding them', () => {
    expect(battleErrorText('WEIRD_CODE')).toContain('WEIRD_CODE');
    expect(battleErrorText('WEIRD_CODE', 'boom')).toContain('boom');
  });
});

describe('battle move metadata', () => {
  it('formats 威力/命中/属性 for the skill buttons', () => {
    expect(moveStatsLine(flamethrower)).toBe('威力90 · 命中100 · fire');
    expect(moveStatsLine(null)).toBe(''); // 元数据未加载 -> 按钮只显示技能名
    expect(moveStatsLine(undefined)).toBe('');
  });

  it('describes a skill on hover, appending the effect text when present', () => {
    expect(moveDetailText('喷射火焰', flamethrower)).toContain('威力 90');
    expect(moveDetailText('喷射火焰', flamethrower)).toContain('Flamethrower');
    expect(moveDetailText('喷射火焰', { ...flamethrower, effectText: '10% 概率灼伤' })).toContain('10% 概率灼伤');
    // 效果系统落地前不显示空说明行
    expect(moveDetailText('喷射火焰', flamethrower).split('\n')).toHaveLength(2);
    expect(moveDetailText('flamethrower', null)).toBe('flamethrower');
  });
});

describe('battle store move catalog', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('indexes GET /battles/moves by id and clears it on reset', () => {
    const store = useBattleStore();
    store.setMoveCatalog([flamethrower]);
    expect(store.moveInfo('flamethrower')?.power).toBe(90);
    expect(store.moveInfo('tackle')).toBeNull();

    store.reset();
    expect(store.moveInfo('flamethrower')).toBeNull();
  });

  it('keeps the raw code + server message next to the friendly HUD text', () => {
    const store = useBattleStore();
    store.setError('ITEM_NOT_SUPPORTED', 'ITEM_NOT_SUPPORTED: items cannot be used during a PvP turn');
    expect(store.lastError).toBe('ITEM_NOT_SUPPORTED');
    expect(store.lastErrorMessage).toContain('items cannot be used');
    expect(battleErrorText(store.lastError, store.lastErrorMessage)).toContain('道具');

    store.setError('');
    expect(store.lastErrorMessage).toBe('');
  });
});
