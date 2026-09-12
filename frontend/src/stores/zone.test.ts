import { describe, expect, it } from 'vitest';
import { MAP_HEIGHT, ZONES, zoneAtY, zoneById, zoneLabel } from './zone';

/** 区域等级带（docs/backend-api.md §2）：前端表与后端 encounter.data.ts 一一对应 */
describe('区域表与地图 y 带', () => {
  it('三条带覆盖全图、互不重叠，南区在南（y 大）', () => {
    expect(ZONES.map((z) => z.id)).toEqual(['south', 'mid', 'north']);
    const covered = new Set<number>();
    for (const zone of ZONES) {
      expect(zone.minY).toBeLessThanOrEqual(zone.maxY);
      for (let y = zone.minY; y <= zone.maxY; y++) {
        expect(covered.has(y)).toBe(false);
        covered.add(y);
        expect(zoneAtY(y).id).toBe(zone.id);
      }
    }
    expect(covered.size).toBe(MAP_HEIGHT);
  });

  it('等级带与阶段门槛：南 Lv2-6 只出未进化型 / 中 Lv8-16 一段 / 北 Lv17-28 二段', () => {
    expect(zoneById('south')).toMatchObject({ minLevel: 2, maxLevel: 6, maxStage: 0, minY: 20 });
    expect(zoneById('mid')).toMatchObject({ minLevel: 8, maxLevel: 16, maxStage: 1 });
    expect(zoneById('north')).toMatchObject({ minLevel: 17, maxLevel: 28, maxStage: 2, maxY: 9 });
    // 等级带随区域单调抬升
    for (let i = 1; i < ZONES.length; i++) {
      expect(ZONES[i].minLevel).toBeGreaterThan(ZONES[i - 1].maxLevel);
    }
  });

  it('越界 y 夹到最近的带（相机边界外的调用不会抛错）', () => {
    expect(zoneAtY(-5).id).toBe('north');
    expect(zoneAtY(-0.5).id).toBe('north');
    expect(zoneAtY(999).id).toBe('south');
    expect(zoneAtY(19.9).id).toBe('mid');
    expect(zoneAtY(20).id).toBe('south');
  });

  it('zoneLabel 展示区域名与等级带', () => {
    expect(zoneLabel(zoneById('south'))).toBe('101 号道路·南 Lv2-6');
    expect(zoneLabel(zoneById('north'))).toBe('101 号道路·北 Lv17-28');
  });
});
