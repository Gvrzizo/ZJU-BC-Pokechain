import { describe, expect, it } from 'vitest';
import { ITEM_ICON_NATIVE, itemIconBox, itemIconUrl, itemKind } from './item-icon';

describe('itemIconUrl vendor 路径约定', () => {
  it('文件名即 typeId', () => {
    expect(itemIconUrl('poke-ball')).toBe('/assets/vendor/items/poke-ball.png');
    expect(itemIconUrl('tm-surf')).toBe('/assets/vendor/items/tm-surf.png');
  });
});

describe('itemIconBox 整数倍最近邻放大', () => {
  it('向上取整到原生边长的整数倍，至少 1×', () => {
    expect(itemIconBox(24, 30)).toBe(30);
    expect(itemIconBox(32, 30)).toBe(60);
    expect(itemIconBox(60, 30)).toBe(60);
    expect(itemIconBox(48, 24)).toBe(48);
    expect(itemIconBox(1, 30)).toBe(30);
    expect(itemIconBox(0, 30)).toBe(30);
  });

  it('原生尺寸未知/非法时退回仓库默认值', () => {
    expect(itemIconBox(ITEM_ICON_NATIVE, 0)).toBe(ITEM_ICON_NATIVE);
    expect(itemIconBox(ITEM_ICON_NATIVE, Number.NaN)).toBe(ITEM_ICON_NATIVE);
  });
});

describe('itemKind 占位图标分类', () => {
  it('球 / 药 / 石 / 技能机，其余归 other', () => {
    expect(itemKind('poke-ball')).toBe('ball');
    expect(itemKind('master-ball')).toBe('ball');
    expect(itemKind('super-potion')).toBe('potion');
    expect(itemKind('thunder-stone')).toBe('stone');
    expect(itemKind('tm-thunderbolt')).toBe('tm');
    expect(itemKind('tm')).toBe('tm');
    expect(itemKind('weird-thing')).toBe('other');
  });
});
