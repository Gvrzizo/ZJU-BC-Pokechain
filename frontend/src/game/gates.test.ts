import { describe, expect, it } from 'vitest';
import {
  PASSAGE_STORAGE_PREFIX,
  forgetPassages,
  hasPassage,
  keyForMap,
  keyGateStatus,
  keyName,
  missingKeyLines,
  rememberPassage,
  type KeyValueStorage,
} from './gates';
import type { MapId } from './maps';

function memoryStorage(): KeyValueStorage & { dump: () => Record<string, string> } {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    dump: () => Object.fromEntries(data),
  };
}

/** 传说区门口钥匙校验：有钥匙 / 没钥匙 / 已记忆通行（钥匙非消耗品） */
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
    const storage = memoryStorage();
    expect(keyGateStatus('ruins', [], storage)).toBe('locked');
    expect(keyGateStatus('ruins', ['potion', 'ruins-key'], storage)).toBe('granted');
    expect(keyGateStatus('town' as MapId, [], storage)).toBe('pass');
    expect(keyGateStatus('cave' as MapId, [], storage)).toBe('pass');
  });

  it('进入过一次就记忆通行（之后不查背包也放行）', () => {
    const storage = memoryStorage();
    expect(hasPassage('sky-pillar-1f', storage)).toBe(false);
    rememberPassage('sky-pillar-1f', storage);
    expect(hasPassage('sky-pillar-1f', storage)).toBe(true);
    expect(storage.dump()[`${PASSAGE_STORAGE_PREFIX}sky-pillar-1f`]).toBe('1');
    expect(keyGateStatus('sky-pillar-1f', [], storage)).toBe('pass');
    // 只记住走过的那个区
    expect(keyGateStatus('magma', [], storage)).toBe('locked');
    forgetPassages(storage);
    expect(keyGateStatus('sky-pillar-1f', [], storage)).toBe('locked');
  });

  it('没有 localStorage（SSR / 隐私模式）时不会抛错，只是不记忆', () => {
    expect(hasPassage('ruins', null)).toBe(false);
    expect(() => rememberPassage('ruins', null)).not.toThrow();
    expect(keyGateStatus('ruins', [], null)).toBe('locked');
    expect(keyGateStatus('ruins', ['ruins-key'], null)).toBe('granted');
  });

  it('被拦住的对话写明钥匙名与购买地点', () => {
    const lines = missingKeyLines('天空之钥');
    expect(lines[0]).toBe('需要 天空之钥 才能进入。');
    expect(lines.join('')).toContain('道具店');
  });
});
