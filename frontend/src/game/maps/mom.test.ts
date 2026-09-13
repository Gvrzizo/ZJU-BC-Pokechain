import { describe, expect, it } from 'vitest';
import { MAPS, facingTarget, reachable } from './index';
import { NPC_SPRITE_NAMES } from './npcs';
import type { NpcDef } from './types';

/**
 * 起始镇的「妈妈」：民居门口，一次性赠送跑鞋（`event: 'running-shoes'`）。
 * 引擎在对话结束后调 `POST /users/me/running-shoes`（幂等），本用例只校验地图数据契约。
 */
describe('未白镇「妈妈」NPC（赠送跑鞋）', () => {
  const town = MAPS.town;
  const mom = town.objects.find((o): o is NpcDef => o.kind === 'npc' && o.name === '妈妈');

  it('在地图对象里，带 talk + running-shoes 事件与妈妈贴图', () => {
    expect(mom).toBeTruthy();
    expect(mom).toMatchObject({
      kind: 'npc',
      sprite: 'mom',
      action: 'talk',
      event: 'running-shoes',
      facing: 'up',
    });
    expect(NPC_SPRITE_NAMES).toContain('mom');
    expect(mom!.lines.length).toBeGreaterThan(0);
  });

  it('站在民居门口，玩家从镇里能走到她面前搭话', () => {
    expect(town.grid[mom!.y][mom!.x]).not.toBe(0); // 有瓦片（不是越界）
    const reach = reachable(town, town.spawn);
    const talkable = [
      { x: 0, y: -1 },
      { x: 0, y: 1 },
      { x: -1, y: 0 },
      { x: 1, y: 0 },
    ].some((d) => reach.has(`${mom!.x + d.x},${mom!.y + d.y}`));
    expect(talkable).toBe(true);

    // 面向妈妈的那一格可以搭话（引擎的 facingTarget 直接给出 NPC）
    const target = facingTarget(town, { x: mom!.x, y: mom!.y - 1 }, 'down');
    expect(target.kind).toBe('npc');
    expect((target as { npc: NpcDef }).npc.name).toBe('妈妈');
  });
});
