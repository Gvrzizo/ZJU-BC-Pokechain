import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createPinia } from 'pinia';
import { useZoneStore } from '@/stores/zone';
import { seedZonesForTest } from '@/stores/zone.fixture';
import CaptureOverlay from './CaptureOverlay.vue';

// 准备界面显示的区域名/等级带来自后端 GET /capture/zones（前端不再镜像）；SSR 测试不联网，先灌入响应快照
seedZonesForTest();

// 准备界面只看本地队伍缓存：SSR 下把两个拉取接口打桩为空，避免真发请求
vi.mock('@/api/pokemon', () => ({ getMyPokemon: async () => [], getPokedex: async () => [] }));
vi.mock('@/api/items', () => ({ getMyItems: async () => [] }));

/** 准备界面显示当前区域与等级带（docs/backend-api.md §2「区域等级带」） */
async function renderPrep(zoneId: string) {
  const app = createSSRApp({ render: () => h(CaptureOverlay) });
  const pinia = createPinia();
  app.use(pinia);
  useZoneStore(pinia).enter(zoneId);
  return renderToString(app);
}

describe('CaptureOverlay 准备界面：区域与等级带', () => {
  it('草原：区域名 + Lv2-6 + 只出未进化型', async () => {
    const html = await renderPrep('route-grass');
    expect(html).toContain('草丛中的动静');
    expect(html).toContain('101 号道路');
    expect(html).toContain('只出未进化型');
    expect(html).toContain('诱饵');
  });

  it('高原：区域名 + Lv17-28 + 可见二段进化型，且不再提"随队伍最高等级浮动"', async () => {
    const html = await renderPrep('route-north');
    expect(html).toContain('冠军之路');
    expect(html).toContain('可见二段进化型');
    expect(html).not.toContain('随队伍最高等级');
    expect(html).toContain('野怪等级与队伍等级无关');
  });

  it('森林：区域名 + Lv4-10 + 只出未进化型（与后端 maxStage=0 对齐）', async () => {
    const html = await renderPrep('forest');
    expect(html).toContain('橙华森林');
    // 模板里用的是连接号（en dash）
    expect(html).toContain('Lv4–10');
    expect(html).toContain('只出未进化型');
    expect(html).not.toContain('可见二段进化型');
  });

  it('传说区：显示传说名与固定等级，且禁用诱饵（后端会拒）', async () => {
    const html = await renderPrep('sky-pillar');
    expect(html).toContain('天空之柱');
    expect(html).toContain('传说 Lv45–50');
    expect(html).toContain('烈空坐');
    expect(html).toContain('不允许投放诱饵');
    expect(html).not.toContain('高级诱饵');
    expect(html).not.toContain('Lvundefined');
  });
});
