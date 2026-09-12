import { beforeEach, describe, expect, it } from 'vitest';
import { h } from 'vue';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import BondHearts from './BondHearts.vue';

function render(props: {
  bond: number;
  max?: number;
  hearts?: number;
  size?: 'sm' | 'md' | 'lg';
  showValue?: boolean;
  delta?: number;
}) {
  return renderToString(createSSRApp({ render: () => h(BondHearts, props) }));
}

function filledHearts(html: string): number {
  return html.split('bond-hearts__heart--on').length - 1;
}

describe('BondHearts 渲染（羁绊 0-255 → 5 颗心）', () => {
  it('5 颗心按比例点亮，0 为空、255 全亮', async () => {
    expect(await render({ bond: 0 })).toContain('title="羁绊 0/255"');
    expect(filledHearts(await render({ bond: 0 }))).toBe(0);
    expect(filledHearts(await render({ bond: 255 }))).toBe(5);
  });

  it('铸造默认 50 / 换手重置 30：都只点亮 1 颗心', async () => {
    expect(filledHearts(await render({ bond: 50 }))).toBe(1);
    expect(filledHearts(await render({ bond: 30 }))).toBe(1);
    expect(filledHearts(await render({ bond: 204 }))).toBe(4);
  });

  it('showValue 显示数值文本，delta 显示 +10 / -4', async () => {
    const html = await render({ bond: 60, showValue: true, delta: 10 });
    expect(html).toContain('羁绊 60/255');
    expect(html).toContain('bond-hearts__delta--up');
    expect(html).toContain('+10');
    const down = await render({ bond: 26, delta: -4 });
    expect(down).toContain('bond-hearts__delta--down');
    expect(down).toContain('-4');
  });

  it('超出 0-255 的输入被夹紧', async () => {
    expect(filledHearts(await render({ bond: 999 }))).toBe(5);
    expect(filledHearts(await render({ bond: -5 }))).toBe(0);
  });

  it('灵魂搭档徽章：羁绊 ≥200 才出现（前端标识，链上无字段）', async () => {
    expect(await render({ bond: 199 })).not.toContain('bond-hearts__soulmate');
    expect(await render({ bond: 199, showValue: true })).not.toContain('灵魂搭档');
    const soulmate = await render({ bond: 200, showValue: true });
    expect(soulmate).toContain('bond-hearts__soulmate');
    expect(soulmate).toContain('灵魂搭档');
    expect(await render({ bond: 255 })).toContain('bond-hearts__soulmate');
  });
});
