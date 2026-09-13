import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createPinia } from 'pinia';
import type { MapId } from '@/game/maps';
import { usePokemonStore } from '@/stores/pokemon';
import { useWorldStore } from '@/stores/world';
import type { Pokemon } from '@/types';
import WorldHud from './WorldHud.vue';

/** 世界 HUD：区域名 + 等级带常驻，传说区特殊配色与提示，跨图横幅，靠左上时自动避让 */
async function render(
  payload: { mapId: MapId; x?: number; y?: number; announce?: boolean; running?: boolean },
  ownedSpeciesIds: number[] = [],
  items: Array<{ typeId: string; quantity: number; status?: string }> = [],
) {
  const app = createSSRApp({ render: () => h(WorldHud) });
  const pinia = createPinia();
  app.use(pinia);
  const world = useWorldStore(pinia);
  world.enterMap({
    mapId: payload.mapId,
    x: payload.x ?? 2,
    y: payload.y ?? 3,
    announce: payload.announce ?? false,
  });
  world.isRunning = payload.running ?? false;
  usePokemonStore(pinia).myPokemon = ownedSpeciesIds.map(
    (speciesId) => ({ id: `mon-${speciesId}`, speciesId }) as Pokemon,
  );
  usePokemonStore(pinia).items = items as never;
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

  it('自动避让：玩家在地图左上区域时卡片挂避让类（滑到右上角），离开即回', async () => {
    // 未白镇 32×24：避让阈值 x < 16 且 y < 8
    const topLeft = await render({ mapId: 'town', x: 4, y: 2 });
    expect(topLeft).toContain('hud-card--right');
    expect(topLeft).toContain('data-hud-side="right"');
    expect(topLeft).toContain('(4, 2)');

    const rightHalf = await render({ mapId: 'town', x: 20, y: 2 });
    expect(rightHalf).toContain('data-hud-side="left"');
    expect(rightHalf).not.toContain('hud-card--right');

    const lowerLeft = await render({ mapId: 'town', x: 4, y: 12 });
    expect(lowerLeft).toContain('data-hud-side="left"');
    expect(lowerLeft).not.toContain('hud-card--right');
  });

  it('小图（相机居中）同样避让', async () => {
    const small = await render({ mapId: 'sky-pillar-1f', x: 1, y: 1 });
    expect(small).toContain('hud-card--right');
    expect(small).toContain('data-hud-side="right"');
  });

  it('拿到跑鞋后提示"按住 Shift 跑步"，跑步中显示"跑步中"', async () => {
    const noShoes = await render({ mapId: 'town', x: 13, y: 16 });
    expect(noShoes).not.toContain('按住 Shift 跑步');
    expect(noShoes).not.toContain('跑步中');

    const shoes = await render({ mapId: 'town', x: 13, y: 16 }, [], [
      { typeId: 'running-shoes', quantity: 1, status: 'IDLE' },
    ]);
    expect(shoes).toContain('按住 Shift 跑步');
    expect(shoes).not.toContain('跑步中');

    const running = await render({ mapId: 'town', x: 13, y: 16, running: true }, [], [
      { typeId: 'running-shoes', quantity: 1, status: 'IDLE' },
    ]);
    expect(running).toContain('跑步中');
    expect(running).not.toContain('按住 Shift 跑步');
  });
});
