import { describe, expect, it } from 'vitest';
import { keyForMap, keyGateStatus, keyName, missingKeyLines } from './gates';
import type { MapId } from './maps';

/** 传说区门口钥匙校验：有钥匙 / 没钥匙（钥匙是一次性消耗品，不做记忆通行） */
describe('钥匙与通行记忆', () => {
  it('每个传说区对应一把钥匙，非传说区没有', () => {
    expect(keyForMap('sky-pillar-1f')).toEqual({ typeId: 'sky-key', name: '天空之钥' });
    expect(keyForMap('seafloor')).toEqual({ typeId: 'ocean-key', name: '海洋之钥' });
    expect(keyForMap('magma')).toEqual({ typeId: 'magma-key', name: '熔岩之钥' });
    expect(keyForMap('ruins')).toEqual({ typeId: 'ruins-key', name: '遗迹之钥' });
    expect(keyForMap('southern-island')).toEqual({ typeId: 'island-key', name: '岛之钥' });
    expect(keyForMap('birth-island')).toEqual({ typeId: 'birth-key', name: '诞生岛船票' });
    expect(keyForMap('cave')).toBeUndefined();
    expect(keyName('sky-key')).toBe('天空之钥');
    expect(keyName('poke-ball')).toBeUndefined();
  });

  it('没有钥匙 → locked；背包持有 → granted；非传说区 → pass', () => {
    expect(keyGateStatus('ruins', [])).toBe('locked');
    expect(keyGateStatus('ruins', ['potion', 'ruins-key'])).toBe('granted');
    expect(keyGateStatus('town' as MapId, [])).toBe('pass');
    expect(keyGateStatus('cave' as MapId, [])).toBe('pass');
  });

  it('每次进入都重新查背包：钥匙用掉后立刻被拦（不再记忆通行）', () => {
    expect(keyGateStatus('sky-pillar-1f', ['sky-key'])).toBe('granted');
    expect(keyGateStatus('sky-pillar-1f', [])).toBe('locked');
    // 其他区不受影响
    expect(keyGateStatus('magma', ['sky-key'])).toBe('locked');
    expect(keyGateStatus('magma', ['magma-key'])).toBe('granted');
  });

  it('被拦住的对话写明钥匙名、购买地点与一次性语义', () => {
    const lines = missingKeyLines('天空之钥');
    expect(lines[0]).toBe('需要 天空之钥 才能进入。');
    expect(lines.join('')).toContain('道具店');
    expect(lines.join('')).toContain('一次性');
  });
});
