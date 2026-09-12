import { EVOLUTIONS, LEGENDARY_WILD_TABLE, SPECIES, WILD_TABLE } from '../src/game-data/species.data';
import { MOVES } from '../src/game-data/moves.data';

/** 第三世代全国图鉴 1–386，数据来自 PokeAPI（生成口径见 backend/README.md「图鉴数据」） */
const ALL_IDS = Array.from({ length: 386 }, (_, i) => i + 1);
const POKE_TYPES = [
  'normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground', 'flying',
  'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy',
];
const LEGENDARY_IDS = [144, 145, 146, 150, 151, 243, 244, 245, 249, 250, 251, 377, 378, 379, 380, 381, 382, 383, 384, 385, 386];
/** 手调的 4 个进化型（game-data/species.data.ts 原样保留） */
const EVOLUTION_ONLY_IDS = [26, 134, 135, 136];
const OUR_STONES = ['thunder-stone', 'water-stone', 'fire-stone'];

describe('图鉴 #1–386 静态数据完整性', () => {
  it('编号 1–386 连续、无缺号无重复', () => {
    const ids = Object.values(SPECIES).map((s) => s.id);
    expect(ids).toHaveLength(386);
    expect([...ids].sort((a, b) => a - b)).toEqual(ALL_IDS);
  });

  it('基础字段：中文/英文名与特性非空，属性在 18 属性全集内', () => {
    for (const species of Object.values(SPECIES)) {
      expect([species.id, species.name.length > 0]).toEqual([species.id, true]);
      expect([species.id, species.nameZh.length > 0]).toEqual([species.id, true]);
      expect([species.id, species.ability.length > 0]).toEqual([species.id, true]);
      expect([species.id, POKE_TYPES.includes(species.type)]).toEqual([species.id, true]);
      expect(species.spriteUri).toBe(`minio://assets/sprites/${species.id}.png`);
    }
  });

  it('种族值六项均为 1–255 的整数（能力值/伤害公式依赖）', () => {
    for (const species of Object.values(SPECIES)) {
      for (const key of ['hp', 'atk', 'def', 'spatk', 'spdef', 'speed'] as const) {
        const value = species.base[key];
        expect([species.id, key, Number.isInteger(value) && value >= 1 && value <= 255]).toEqual([species.id, key, true]);
      }
    }
  });

  it('捕获率均为官方 3–255 的整数', () => {
    for (const species of Object.values(SPECIES)) {
      expect([species.id, Number.isInteger(species.catchRate) && species.catchRate >= 3 && species.catchRate <= 255]).toEqual([species.id, true]);
    }
  });

  it('defaultMoves 恰好 4 个互不相同、且都在技能表里', () => {
    for (const species of Object.values(SPECIES)) {
      expect([species.id, species.defaultMoves.length]).toEqual([species.id, 4]);
      expect([species.id, new Set(species.defaultMoves).size]).toEqual([species.id, 4]);
      for (const moveId of species.defaultMoves) {
        expect([species.id, moveId, MOVES[moveId] !== undefined]).toEqual([species.id, moveId, true]);
      }
    }
  });

  it('进化规则：两端都在图鉴内、minLevel 合法、石头只能是本作三种', () => {
    for (const rule of EVOLUTIONS) {
      expect([rule.from, rule.to, SPECIES[rule.from] !== undefined && SPECIES[rule.to] !== undefined]).toEqual([rule.from, rule.to, true]);
      expect([rule.from, rule.to, Number.isInteger(rule.minLevel) && rule.minLevel >= 1 && rule.minLevel <= 100]).toEqual([rule.from, rule.to, true]);
      if (rule.stoneTypeId) expect([rule.from, rule.to, OUR_STONES.includes(rule.stoneTypeId)]).toEqual([rule.from, rule.to, true]);
    }
    expect(new Set(EVOLUTIONS.map((e) => `${e.from}-${e.to}`)).size).toBe(EVOLUTIONS.length);
  });

  it('手调的 4 条石头进化规则原样保留（25→26 / 133→134/135/136）', () => {
    expect(EVOLUTIONS).toEqual(
      expect.arrayContaining([
        { from: 25, to: 26, minLevel: 20, stoneTypeId: 'thunder-stone' },
        { from: 133, to: 134, minLevel: 15, stoneTypeId: 'water-stone' },
        { from: 133, to: 135, minLevel: 15, stoneTypeId: 'thunder-stone' },
        { from: 133, to: 136, minLevel: 15, stoneTypeId: 'fire-stone' },
      ]),
    );
  });

  it('普通野生池 = 非传说/幻之种族（手调 4 个进化型除外）；传说单独成表', () => {
    const wildIds = WILD_TABLE.map((s) => s.id).sort((a, b) => a - b);
    expect(wildIds).toEqual(ALL_IDS.filter((id) => !LEGENDARY_IDS.includes(id) && !EVOLUTION_ONLY_IDS.includes(id)));
    expect(WILD_TABLE.every((s) => s.inWild && !s.legendary)).toBe(true);
    // 传说表 = 第三世代里开放遭遇的 9 只（#377–384/386）；Kanto/城都传说与基拉祈仍未开放
    expect(LEGENDARY_WILD_TABLE.map((s) => s.id).sort((a, b) => a - b)).toEqual([377, 378, 379, 380, 381, 382, 383, 384, 386]);
    expect(LEGENDARY_WILD_TABLE.every((s) => s.inWild && s.legendary)).toBe(true);
    expect(Object.values(SPECIES).filter((s) => s.inWild)).toHaveLength(WILD_TABLE.length + LEGENDARY_WILD_TABLE.length);
  });

  it('第三世代（#252–386）全部在库；传说里只有 #377–384/386 开放野生遭遇', () => {
    const gen3 = ALL_IDS.slice(251);
    for (const id of gen3) expect([id, SPECIES[id] !== undefined]).toEqual([id, true]);
    for (const id of gen3) {
      const open = LEGENDARY_WILD_TABLE.some((s) => s.id === id);
      const legendary = LEGENDARY_IDS.includes(id);
      // 开放遭遇的传说（inWild=true）只可能是 #377–384/386（基拉祈 385 仍是 false）
      expect([id, SPECIES[id].inWild]).toEqual([id, !legendary || open]);
      expect([id, SPECIES[id].legendary]).toEqual([id, legendary]);
    }
    // 抽样：御三家与代表性物种
    expect(SPECIES[252]).toMatchObject({ name: 'treecko', nameZh: '木守宫', type: 'grass', catchRate: 45 });
    expect(SPECIES[386]).toMatchObject({ name: 'deoxys', nameZh: '代欧奇希斯', catchRate: 3, inWild: true, legendary: true });
    expect(SPECIES[385]).toMatchObject({ name: 'jirachi', inWild: false, legendary: true });
    // Kanto/城都传说仍是未开放（inWild=false）但标记为传说
    expect(SPECIES[150]).toMatchObject({ name: 'mewtwo', inWild: false, legendary: true });
    expect(SPECIES[251]).toMatchObject({ name: 'celebi', inWild: false, legendary: true });
  });
});
