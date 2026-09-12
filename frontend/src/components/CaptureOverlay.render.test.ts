import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createPinia } from 'pinia';
import { useZoneStore } from '@/stores/zone';
import CaptureOverlay from './CaptureOverlay.vue';

// 准备界面只看本地队伍缓存：SSR 下把两个拉取接口打桩为空，避免真发请求
vi.mock('@/api/pokemon', () => ({ getMyPokemon: async () => [], getPokedex: async () => [] }));
vi.mock('@/api/items', () => ({ getMyItems: async () => [] }));

/** 准备界面显示当前区域与等级带（docs/backend-api.md §2「区域等级带」） */
async function renderPrep(zoneId: 'south' | 'mid' | 'north') {
  const app = createSSRApp({ render: () => h(CaptureOverlay) });
  const pinia = createPinia();
  app.use(pinia);
  useZoneStore(pinia).enter(zoneId);
  return renderToString(app);
}

describe('CaptureOverlay 准备界面：区域与等级带', () => {
  it('南部：区域名 + Lv2-6 + 只出未进化型', async () => {
    const html = await renderPrep('south');
    expect(html).toContain('草丛中的动静');
    expect(html).toContain('101 号道路·南');
    expect(html).toContain('只出未进化型');
    expect(html).toContain('诱饵');
  });

  it('北部：区域名 + Lv17-28 + 可见二段进化型，且不再提"随队伍最高等级浮动"', async () => {
    const html = await renderPrep('north');
    expect(html).toContain('101 号道路·北');
    expect(html).toContain('可见二段进化型');
    expect(html).not.toContain('随队伍最高等级');
    expect(html).toContain('野怪等级与队伍等级无关');
  });

  it('中部：可出一段进化型', async () => {
    const html = await renderPrep('mid');
    expect(html).toContain('101 号道路·中');
    expect(html).toContain('可见一段进化型');
  });
});
