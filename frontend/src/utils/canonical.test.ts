import { describe, expect, it } from 'vitest';
import { canonicalize } from './canonical';

/** 战斗回合日志片段：字段插入顺序刻意与字典序不同，且含嵌套对象/数组/标量。 */
const TURN_LOG = [
  {
    type: 'move',
    turn: 1,
    actor: { side: 'A', name: 'pikachu' },
    move: 'thunder-shock',
    damage: 17,
    critical: false,
    note: null,
  },
  {
    type: 'status',
    turn: 2,
    actor: { side: 'B', name: 'eevee' },
    effect: 'paralysis',
    remaining: 3,
  },
];

describe('canonicalize（与后端 crypto.util 同口径）', () => {
  it('对象键递归排序，数组保持原顺序，标量按 JSON.stringify', () => {
    expect(canonicalize({ b: 1, a: { d: [2, { z: 'x', y: true }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"y":true,"z":"x"}]},"b":1}',
    );
  });

  it('回合日志 fixture：与朴素 JSON.stringify 结果不同，但语义等价', () => {
    const naive = JSON.stringify(TURN_LOG);
    const canonical = canonicalize(TURN_LOG);
    expect(canonical).not.toBe(naive);
    expect(canonical).toBe(
      '[{"actor":{"name":"pikachu","side":"A"},"critical":false,"damage":17,"move":"thunder-shock","note":null,"turn":1,"type":"move"},' +
        '{"actor":{"name":"eevee","side":"B"},"effect":"paralysis","remaining":3,"turn":2,"type":"status"}]',
    );
    // 再序列化回来语义一致（数组顺序保留）
    expect(JSON.parse(canonical)).toEqual(TURN_LOG);
  });

  it('顶层标量 / 数组 / undefined 对象字段的行为', () => {
    expect(canonicalize('abc')).toBe('"abc"');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize([3, 'a', false])).toBe('[3,"a",false]');
    // 对象里值为 undefined 的键：直接 JSON.stringify 会丢弃，canonicalize（与后端一致）输出 undefined
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1,"b":undefined}');
  });
});
