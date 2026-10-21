import { beforeEach, describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import ItemIcon from './ItemIcon.vue';
import { setLocale } from '@/composables/useI18n';

function render(typeId: string, size?: number) {
  return renderToString(createSSRApp({ render: () => h(ItemIcon, { typeId, size }) }));
}

beforeEach(() => setLocale('zh'));

describe('ItemIcon 渲染', () => {
  it('按 typeId 指向 vendor 图标，尺寸取原生 30 的整数倍 + 边框', async () => {
    const html = await render('poke-ball', 24);
    expect(html).toContain('src="/assets/vendor/items/poke-ball.png"');
    // 24 → 1×30 + 2×2 边框
    expect(html).toContain('width:34px');
    expect(html).toContain('height:34px');
  });

  it('alt / title 用当前语言的道具名，切英文跟着变', async () => {
    expect(await render('tm-surf', 24)).toContain('alt="冲浪技能机"');
    setLocale('en');
    const html = await render('tm-surf', 24);
    expect(html).toContain('alt="TM Surf"');
    expect(html).toContain('title="TM Surf"');
  });
});


it('跑鞋直接使用入库的 GPT Image 像素素材，不请求不存在的 vendor 图片', async () => {
  const html = await render('running-shoes', 32);
  expect(html).toContain('src="/assets/generated/items/running-shoes.png"');
  expect(html).not.toContain('/assets/vendor/items/running-shoes.png');
  expect(html).not.toContain('<svg');
});
