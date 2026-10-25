import { describe, expect, it } from 'vitest';
import { MAPS, T, type MapDef } from './index';
import { arrangeTrees } from './trees';

describe('完整树木布局', () => {
  it('每个树格恰好属于一棵完整树，绘制占地与碰撞一致', () => {
    for (const map of Object.values(MAPS)) {
      const owners = new Set<string>();
      for (const tree of map.trees ?? []) {
        const width = tree.size === 'large' ? 2 : 1;
        for (let y = tree.y; y < tree.y + 2; y++) for (let x = tree.x; x < tree.x + width; x++) {
          const key = `${x},${y}`;
          expect(owners.has(key), `${map.id}: 树木重叠 ${key}`).toBe(false);
          expect(map.grid[y]?.[x], `${map.id}: 树形不完整 ${key}`).toBe(T.tree);
          owners.add(key);
        }
      }
      map.grid.forEach((row, y) => row.forEach((tile, x) => {
        if (tile === T.tree) expect(owners.has(`${x},${y}`), `${map.id}: 零碎树格 ${x},${y}`).toBe(true);
      }));
    }
  });

  it('镇、草原和森林的边界使用完整大树，小树仅在内部点缀', () => {
    for (const map of [MAPS.town, MAPS['route-grass'], MAPS.forest]) {
      const edge = (map.trees ?? []).filter(t => t.x === 0 || t.y === 0 || t.x === map.width - 2 || t.y === map.height - 2);
      expect(edge.length).toBeGreaterThan(20);
      expect(edge.every(t => t.size === 'large')).toBe(true);
      const small = (map.trees ?? []).filter(t => t.size === 'small');
      expect(small.length).toBeGreaterThan(0);
      expect(small.length).toBeLessThan(10);
    }
  });

  it('整棵树放不下或压住交互位置时留空，不留下半棵树', () => {
    const map: MapDef = { ...MAPS.town, width: 4, height: 4,
      grid: [[T.tree,T.tree,T.path,T.path], [T.tree,T.tree,T.path,T.path],
        [T.grass,T.grass,T.grass,T.grass], [T.grass,T.grass,T.grass,T.grass]],
      objects: [], warps: [], spawn: { x: 0, y: 0 }, trees: [] };
    arrangeTrees(map);
    expect(map.grid[0]).toEqual([T.grass,T.grass,T.path,T.path]);
    expect(map.grid[1]).toEqual([T.grass,T.grass,T.path,T.path]);
    expect(map.trees).toEqual([{ x: 0, y: 2, size: 'large' }, { x: 2, y: 2, size: 'large' }]);
  });

  it('孤岛在祭坛两侧各放一棵完整小树，海水和沙滩不被树冠改成草地', () => {
    const map = MAPS['southern-island'];
    expect(map.trees).toEqual([{ x: 7, y: 7, size: 'small' }, { x: 12, y: 6, size: 'small' }]);
    expect(map.grid[5][5]).toBe(T.sand);
    expect(map.grid[4][7]).toBe(T.water);
  });
});
