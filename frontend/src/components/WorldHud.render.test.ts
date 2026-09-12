import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createPinia } from 'pinia';
import type { MapId } from '@/game/maps';
import { usePokemonStore } from '@/stores/pokemon';
import { useWorldStore } from '@/stores/world';
import type { Pokemon } from '@/types';
import WorldHud from './WorldHud.vue';

/** 世界 HUD：区域名 + 等级带常驻，传说区特殊配色与提示，跨图横幅 */
async function render(
  payload: { mapId: MapId; x?: number; y?: number; announce?: boolean },
  ownedSpeciesIds: number[] = [],
) {
  const app = createSSRApp({ render: () => h(WorldHud) });
  const pinia = createPinia();
  app.use(pinia);
  useWorldStore(pinia).enterMap({
    mapId: payload.mapId,
    x: payload.x ?? 2,
    y: payload.y ?? 3,
    announce: payload.announce ?? false,
  });
  usePokemonStore(pinia).myPokemon = ownedSpeciesIds.map(
    (speciesId) => ({ id: `mon-${speciesId}`, speciesId }) as Pokemon,
  );
  return renderToString(app);
}

describe('WorldHud', () => {
  it('镇内：显示地名与安全区提示，坐标跟随 store', async () => {
    const html = await render({ mapId: 'town', x: 13, y: 16 });
    expect(html).toContain('未白镇');
    expect(html).toContain('没有野生宝可梦');
    expect(html).toContain('(13, 16)');
    expect(html).not.toContain('传说宝可梦的气息');
  });

  it('野外：显示区域名 + 等级带 + 阶段提示', async () => {
    const html = await render({ mapId: 'route-grass' });
    expect(html).toContain('101 号道路');
    expect(html).toContain('Lv2-6');
    expect(html).toContain('未进化型出没');
  });

  it('传说区（塔顶）：特殊提示 + 可捕捉传说', async () => {
    const html = await render({ mapId: 'sky-pillar-2f' });
    expect(html).toContain('天空之柱 · 塔顶');
    expect(html).toContain('传说宝可梦的气息');
    expect(html).toContain('可捕捉');
    expect(html).toContain('烈空坐');
    expect(html).toContain('hud-card--legendary');
    expect(html).not.toContain('你已经收服过它了');
  });

  it('传说区但本层没有祭坛（塔 1F）：提示继续往里走', async () => {
    const html = await render({ mapId: 'sky-pillar-1f' });
    expect(html).toContain('本层还没有它的踪迹');
    expect(html).not.toContain('可捕捉');
  });

  it('已收服过该传说：HUD 提前说明不会再出现', async () => {
    const html = await render({ mapId: 'sky-pillar-2f' }, [384]);
    expect(html).toContain('你已经收服过它了');
    const other = await render({ mapId: 'southern-island' }, [384]);
    expect(other).not.toContain('你已经收服过它了');
  });

  it('跨图横幅：普通区与传说区两套配色', async () => {
    const normal = await render({ mapId: 'forest', announce: true });
    expect(normal).toContain('hud-banner--normal');
    expect(normal).toContain('—— 橙华森林 ——');

    const legendary = await render({ mapId: 'southern-island', announce: true });
    expect(legendary).toContain('hud-banner--legendary');
    expect(legendary).toContain('传说宝可梦的气息…（可捕捉：拉帝亚斯/拉帝欧斯）');
  });
});
