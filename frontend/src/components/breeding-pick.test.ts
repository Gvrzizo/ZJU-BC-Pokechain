import { describe, expect, it } from 'vitest';
import { eligiblePartners, ivTotal, partnerBlockReason } from './breeding-pick';
import type { Pokemon } from '@/types';

// --- [FEAT:breeding] begin ---

const mon = (over: Partial<Pokemon> = {}): Pokemon =>
  ({
    id: 'p_x',
    speciesId: 25,
    name: 'pikachu',
    dnaHash: 'd'.repeat(64),
    ivs: { hp: 10, atk: 10, def: 10, spatk: 10, spdef: 10, speed: 10 },
    nature: 'hardy',
    ability: 'static',
    shiny: false,
    level: 20,
    exp: 0,
    moves: ['tackle'],
    ownerId: 'ash',
    status: 'IDLE',
    ...over,
  }) as Pokemon;

describe('培育屋选亲代（纯函数）', () => {
  it('排除同一只、非空闲、濒死与等级不足', () => {
    expect(partnerBlockReason(mon({ id: 'p_a' }), 'p_a', 20)).toBe('same');
    expect(partnerBlockReason(mon({ status: 'LOCKED_TRADE' }), 'p_a', 20)).toBe('locked');
    expect(partnerBlockReason(mon({ fainted: true }), 'p_a', 20)).toBe('fainted');
    expect(partnerBlockReason(mon({ level: 19 }), 'p_a', 20)).toBe('lowLevel');
    expect(partnerBlockReason(mon({ level: 20 }), 'p_a', 20)).toBeNull();
  });

  it('可选列表保持原顺序', () => {
    const list = [
      mon({ id: 'p_a' }),
      mon({ id: 'p_b', level: 21 }),
      mon({ id: 'p_c', level: 5 }),
      mon({ id: 'p_d' }),
    ];
    expect(eligiblePartners(list, 'p_a', 20).map((p) => p.id)).toEqual(['p_b', 'p_d']);
  });

  it('IV 合计用于列表展示', () => {
    expect(ivTotal(mon())).toBe(60);
  });
});

// --- [FEAT:breeding] end ---
