import { beforeEach, describe, expect, it } from 'vitest';
import {
  itemName,
  locale,
  monName,
  moveName,
  natureEffect,
  natureName,
  setLocale,
  t,
  toggleLocale,
} from './useI18n';
import { MESSAGES } from '@/locales';

/** 后端在用清单：backend/src/game-data/{moves,items,natures}.data.ts（回归用，勿随意改） */
const MOVE_IDS = [
  'tackle', 'quick-attack', 'body-slam', 'hyper-beam', 'thunder-shock', 'spark', 'thunderbolt', 'thunder',
  'ember', 'fire-fang', 'flamethrower', 'fire-blast', 'water-gun', 'aqua-tail', 'surf', 'hydro-pump',
  'vine-whip', 'razor-leaf', 'solar-beam', 'psybeam', 'psychic', 'bite', 'crunch', 'dark-pulse',
  'absorb', 'giga-drain', 'leaf-blade', 'blaze-kick', 'dragon-claw', 'dragon-breath', 'fly', 'wing-attack', 'ice-beam',
  'earthquake', 'shadow-ball', 'silver-wind', 'brick-break', 'iron-tail', 'metal-claw', 'dig', 'sludge-bomb', 'poison-sting', 'rock-slide',
];
const ITEM_TYPE_IDS = [
  'poke-ball', 'great-ball', 'ultra-ball', 'master-ball', 'potion', 'super-potion',
  'thunder-stone', 'water-stone', 'fire-stone', 'tm-thunderbolt', 'tm-flamethrower', 'tm-surf',
  'bottle-cap', 'gold-bottle-cap', 'rare-candy',
  'sky-key', 'ocean-key', 'magma-key', 'ruins-key', 'island-key', 'birth-key',
  'running-shoes',
];
const NATURE_IDS = [
  'hardy', 'lonely', 'brave', 'adamant', 'naughty', 'bold', 'docile', 'relaxed', 'impish', 'lax',
  'timid', 'hasty', 'serious', 'jolly', 'naive', 'modest', 'mild', 'quiet', 'bashful', 'rash',
  'calm', 'gentle', 'sassy', 'careful', 'quirky',
];

beforeEach(() => setLocale('zh'));

describe('useI18n 语言切换', () => {
  it('默认中文（localStorage 不可用的 node 环境回退 zh）', () => {
    expect(locale.value).toBe('zh');
    expect(t('nav.bag')).toBe('背包');
    expect(monName(25)).toBe('皮卡丘');
  });

  it('切到 en 后姓名与 UI 文案一起跟随', () => {
    setLocale('en');
    expect(t('nav.bag')).toBe('Bag');
    expect(monName(25)).toBe('Pikachu');
    expect(moveName('thunder-shock')).toBe('Thunder Shock');
    expect(itemName('poke-ball')).toBe('Poké Ball');
    expect(natureName('adamant')).toBe('Adamant');
    expect(natureEffect('adamant')).toBe('+Attack -Sp. Atk');
  });

  it('toggleLocale 在中/英之间往返', () => {
    expect(toggleLocale()).toBe('en');
    expect(toggleLocale()).toBe('zh');
  });

  it('t() 支持 {占位符}，未知键原样回退', () => {
    expect(t('bag.used', { name: '精灵球' })).toBe('已使用 精灵球');
    expect(t('trade.assetsItems', { n: 3 })).toBe('道具×3');
    expect(t('nope.missing.key')).toBe('nope.missing.key');
  });
});

describe('名称查询与回退', () => {
  it('宝可梦：编号 / 数字串 / 英文名 / PokeAPI slug 都能命中', () => {
    expect(monName(25)).toBe('皮卡丘');
    expect(monName('25')).toBe('皮卡丘');
    expect(monName('pikachu')).toBe('皮卡丘');
    expect(monName('Mr. Mime')).toBe('魔墙人偶');
    expect(monName('nidoran-f')).toBe('尼多兰♀');
    expect(monName('farfetchd')).toBe('大葱鸭');
  });

  it('未收录的 id 回退英文原名 / fallback', () => {
    expect(monName(999)).toBe('#999');
    expect(monName(999, 'Missingno')).toBe('Missingno');
    expect(monName('missingmon')).toBe('missingmon');
    expect(moveName('unknown-move')).toBe('unknown-move');
    expect(itemName('unknown-item')).toBe('unknown-item');
    expect(natureName('unknown-nature')).toBe('unknown-nature');
  });

  it('昵称优先（改名 docs/backend-api.md §2）：fallback 是昵称时直接显示，是种族名时仍按当前语言显示', () => {
    // 未改名：链上 name 是铸造时的种族 slug / 英文名 / 中文名 → 一律显示当前语言的种族名
    expect(monName(25, 'pikachu')).toBe('皮卡丘');
    expect(monName(25, 'Pikachu')).toBe('皮卡丘');
    expect(monName(25, '皮卡丘')).toBe('皮卡丘');
    expect(monName(29, 'nidoran-f')).toBe('尼多兰♀');
    expect(monName(83, 'farfetchd')).toBe('大葱鸭');
    // 改过名：昵称优先，不会被种族名覆盖（含中文昵称与英文昵称）
    expect(monName(25, '闪电鼠')).toBe('闪电鼠');
    expect(monName(25, '小皮')).toBe('小皮');
    expect(monName(25, 'Charmander')).toBe('Charmander');
    // 战斗/捕捉界面把 nameZh 当 fallback（CaptureOverlay 的调用方式）：仍解析成当前语言的种族名
    setLocale('en');
    expect(monName(25, 'pikachu')).toBe('Pikachu');
    expect(monName(25, '皮卡丘')).toBe('Pikachu');
    expect(monName(25, '闪电鼠')).toBe('闪电鼠');
  });

  it('技能名容错：后端英文显示名（空格/大小写）也能查到', () => {
    expect(moveName('Thunder Shock')).toBe('电击');
    expect(moveName('Dark Pulse')).toBe('恶之波动');
  });

  it('性格带能力修正说明，无修正是中性文案', () => {
    expect(natureEffect('adamant')).toBe('+攻击 -特攻');
    expect(natureEffect('hardy')).toBe('无能力修正');
    expect(natureEffect('nope')).toBe('');
  });
});

describe('词典完整性', () => {
  it('后端在用的 12 个种族译名与 backend/src/game-data/species.data.ts 的 nameZh 一致', () => {
    const demoSpecies: Array<[number, string]> = [
      [3, '妙蛙花'], [6, '喷火龙'], [9, '水箭龟'], [25, '皮卡丘'], [26, '雷丘'], [94, '耿鬼'],
      [133, '伊布'], [134, '水伊布'], [135, '雷伊布'], [136, '火伊布'], [143, '卡比兽'], [149, '快龙'],
    ];
    for (const [id, name] of demoSpecies) expect(MESSAGES.zh.pokemon[id]).toBe(name);
  });

  it('图鉴 1–386（第三世代全量）中英双语全收录', () => {
    for (let id = 1; id <= 386; id += 1) {
      expect(MESSAGES.zh.pokemon[id], `zh #${id}`).toBeTruthy();
      expect(MESSAGES.en.pokemon[id], `en #${id}`).toBeTruthy();
    }
    expect(Object.keys(MESSAGES.zh.pokemon)).toHaveLength(386);
    expect(Object.keys(MESSAGES.en.pokemon)).toHaveLength(386);
  });

  it('第二 / 三世代译名抽查（官方简体中文）与 slug 查询', () => {
    expect(MESSAGES.zh.pokemon[233]).toBe('多边兽2型'); // 2020 官方改名，非「多边兽Ⅱ」
    expect(MESSAGES.zh.pokemon[312]).toBe('负电拍拍'); // PokeAPI 数据混入繁体「負」，已修正
    expect(MESSAGES.zh.pokemon[263]).toBe('蛇纹熊');
    expect(MESSAGES.zh.pokemon[386]).toBe('代欧奇希斯');
    expect(MESSAGES.en.pokemon[386]).toBe('Deoxys');
    expect(MESSAGES.en.pokemon[250]).toBe('Ho-Oh');
    expect(monName(252)).toBe('木守宫');
    expect(monName('treecko')).toBe('木守宫');
    expect(monName('Gardevoir')).toBe('沙奈朵');
    setLocale('en');
    expect(monName('treecko')).toBe('Treecko');
    expect(monName('Deoxys')).toBe('Deoxys');
  });

  it('技能 24 条 / 道具 22 条 / 性格 25 条，与后端清单一一对应', () => {
    expect(Object.keys(MESSAGES.zh.moves).sort()).toEqual([...MOVE_IDS].sort());
    expect(Object.keys(MESSAGES.zh.items).sort()).toEqual([...ITEM_TYPE_IDS].sort());
    expect(Object.keys(MESSAGES.zh.natures).sort()).toEqual([...NATURE_IDS].sort());
    for (const id of MOVE_IDS) {
      expect(MESSAGES.zh.moves[id], `zh move ${id}`).toBeTruthy();
      expect(MESSAGES.en.moves[id], `en move ${id}`).toBeTruthy();
    }
    for (const id of ITEM_TYPE_IDS) {
      expect(MESSAGES.zh.items[id], `zh item ${id}`).toBeTruthy();
      expect(MESSAGES.en.items[id], `en item ${id}`).toBeTruthy();
    }
    for (const id of NATURE_IDS) {
      expect(MESSAGES.zh.natures[id]?.name, `zh nature ${id}`).toBeTruthy();
      expect(MESSAGES.en.natures[id]?.name, `en nature ${id}`).toBeTruthy();
      expect(MESSAGES.zh.natures[id]?.effect, `zh nature effect ${id}`).toBeTruthy();
      expect(MESSAGES.en.natures[id]?.effect, `en nature effect ${id}`).toBeTruthy();
    }
  });

  it('中文与英文的 UI 键集完全一致（漏译会在这里暴露）', () => {
    expect(Object.keys(MESSAGES.zh.ui).sort()).toEqual(Object.keys(MESSAGES.en.ui).sort());
  });
});
