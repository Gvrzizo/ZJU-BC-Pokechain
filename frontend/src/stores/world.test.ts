import { describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MAPS } from '@/game/maps';
import { useWorldStore } from './world';

/** world store：HUD 自动避让判定 + 跑步状态（GameView/OverworldScene 写入，WorldHud 读取） */
describe('world store：HUD 自动避让', () => {
  it('大地图：左半 + 上三分之一避让，右侧或下侧不避让', () => {
    setActivePinia(createPinia());
    const world = useWorldStore();
    // 未白镇 32×24：阈值 x < 16 且 y < 8
    const town = MAPS.town;
    expect(world.size).toEqual({ width: town.width, height: town.height });

    world.enterMap({ mapId: 'town', x: 15, y: 7 });
    expect(world.hudAvoidsPlayer).toBe(true); // 15 < 16 且 7 < 8
    world.enterMap({ mapId: 'town', x: 4, y: 2 });
    expect(world.hudAvoidsPlayer).toBe(true);

    world.moveTo(16, 2);
    expect(world.hudAvoidsPlayer).toBe(false); // 右半：不避让
    world.moveTo(15, 8);
    expect(world.hudAvoidsPlayer).toBe(false); // 上三分之一之外：不避让
    world.moveTo(town.width - 1, town.height - 1);
    expect(world.hudAvoidsPlayer).toBe(false);
  });

  it('小图（相机居中）：同样按图内相对位置判定', () => {
    setActivePinia(createPinia());
    const world = useWorldStore();
    // 塔内/遗迹比画面小，相机居中显示：判定仍只看玩家在图里的格子
    const small = MAPS['sky-pillar-1f'];
    world.enterMap({ mapId: 'sky-pillar-1f', x: 1, y: 1 });
    expect(world.size).toEqual({ width: small.width, height: small.height });
    expect(world.hudAvoidsPlayer).toBe(true);

    world.moveTo(Math.floor(small.width / 2), 0);
    expect(world.hudAvoidsPlayer).toBe(false);
    world.moveTo(0, Math.ceil(small.height / 3));
    expect(world.hudAvoidsPlayer).toBe(false);
  });

  it('换图时尺寸同步更新（不会沿用上一张图的宽高）', () => {
    setActivePinia(createPinia());
    const world = useWorldStore();
    world.enterMap({ mapId: 'town', x: 2, y: 2 });
    expect(world.hudAvoidsPlayer).toBe(true);
    world.enterMap({ mapId: 'sky-pillar-1f', x: 2, y: 2 });
    expect(world.size).toEqual({ width: MAPS['sky-pillar-1f'].width, height: MAPS['sky-pillar-1f'].height });
    expect(world.hudAvoidsPlayer).toBe(true);
  });
});

describe('world store：跑步状态', () => {
  it('moveTo 带 running 标记；默认不跑步', () => {
    setActivePinia(createPinia());
    const world = useWorldStore();
    expect(world.isRunning).toBe(false);

    world.moveTo(13, 15, true);
    expect(world.position).toEqual({ x: 13, y: 15 });
    expect(world.isRunning).toBe(true);

    world.moveTo(13, 14, false);
    expect(world.isRunning).toBe(false);
  });
});
