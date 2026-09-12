import { describe, expect, it } from 'vitest';
import { blockRemainingText, clampWagerToInventory, describeWager } from './wager-inventory';
import type { Item, Pokemon } from '@/types';

const mon = (id: string, status: Pokemon['status'] = 'IDLE'): Pick<Pokemon, 'id' | 'status'> => ({ id, status });
const faintedMon = (id: string): Pick<Pokemon, 'id' | 'status' | 'currentHp'> => ({
  id,
  status: 'IDLE',
  currentHp: 0,
});
const stack = (
  id: string,
  quantity: number,
  status: Item['status'] = 'IDLE',
): Pick<Item, 'id' | 'status' | 'quantity'> => ({ id, status, quantity });

describe('押注模板载入（clampWagerToInventory）', () => {
  const inventory = {
    pokemon: [mon('p_idle'), mon('p_locked', 'LOCKED_BATTLE')],
    items: [stack('i_5', 5), stack('i_locked', 3, 'LOCKED_TRADE'), stack('i_sold', 0)],
  };

  it('剔除不在背包 / 非 IDLE 的资产，qty 夹到当前持有量', () => {
    const { wager, dropped } = clampWagerToInventory(
      {
        pokemonIds: ['p_idle', 'p_locked', 'p_gone'],
        items: [
          { id: 'i_5', qty: 9 },
          { id: 'i_locked', qty: 1 },
          { id: 'i_ghost', qty: 2 },
        ],
        points: 30,
      },
      inventory.pokemon,
      inventory.items,
    );
    expect(wager).toEqual({ pokemonIds: ['p_idle'], items: [{ id: 'i_5', qty: 5 }], points: 30 });
    expect(dropped).toBe(4); // p_locked / p_gone / i_locked / i_ghost
  });

  it('旧格式 qty=0（整堆标记）按当前持有量押整堆；没有资产被剔除时 dropped=0', () => {
    const { wager, dropped } = clampWagerToInventory(
      { pokemonIds: ['p_idle'], items: [{ id: 'i_5', qty: 0 }], points: 0 },
      inventory.pokemon,
      inventory.items,
    );
    expect(wager.items).toEqual([{ id: 'i_5', qty: 5 }]);
    expect(dropped).toBe(0);
  });

  it('空清单 / 缺失字段安全降级', () => {
    expect(clampWagerToInventory(null, [], []).wager).toEqual({ pokemonIds: [], items: [], points: 0 });
  });

  it('伤势持久化：濒死（0 HP）的宝可梦按"不在背包"剔除（不能出战）', () => {
    const party = [mon('p_idle'), faintedMon('p_fainted')];
    const { wager, dropped } = clampWagerToInventory(
      { pokemonIds: ['p_idle', 'p_fainted'], items: [], points: 0 },
      party,
      [],
    );
    expect(wager.pokemonIds).toEqual(['p_idle']);
    expect(dropped).toBe(1);
    // 全部濒死时清单一空（前端据此禁用"确认押注"）
    expect(clampWagerToInventory({ pokemonIds: ['p_fainted'], items: [], points: 0 }, party, []).wager.pokemonIds).toEqual([]);
  });
});

describe('押注摘要与屏蔽剩余时长文案', () => {
  it('describeWager 汇总宝可梦 / 道具 / 积分，空清单显示"无押注"', () => {
    expect(describeWager({ pokemonIds: ['a', 'b'], items: [{ id: 'i', qty: 3 }], points: 10 })).toBe(
      '宝可梦×2 + 道具×3 + 10P',
    );
    expect(describeWager({ pokemonIds: [], items: [], points: 0 })).toBe('无押注');
  });

  it('blockRemainingText 不足 1 分钟按 1 分钟显示', () => {
    expect(blockRemainingText(30 * 60 * 1000)).toBe('还剩 30 分钟');
    expect(blockRemainingText(0)).toBe('还剩 1 分钟');
  });
});
