import type Phaser from 'phaser';
import { T, type MapDef } from './maps';
import { BIOME_COLORS } from './world-textures';
import { TILE } from './textures';
import { worldTilesetKey } from './world-assets';

/** 16px 逻辑网格：地形按邻接关系描边，建筑按整个占地绘制，碰撞仍由语义地图负责。 */
export function makeMapArt(scene: Phaser.Scene, map: MapDef): string {
  const key = `world-map-art:${map.id}`;
  if (scene.textures.exists(key)) return key;
  const texture = scene.textures.createCanvas(key, map.width * TILE, map.height * TILE);
  if (!texture) return worldTilesetKey(map.biome);
  const ctx = texture.getContext();
  ctx.imageSmoothingEnabled = false;
  ctx.scale(2, 2);
  const c = BIOME_COLORS[map.biome];
  const source = scene.textures.get(worldTilesetKey(map.biome)).getSourceImage() as CanvasImageSource;
  const at = (x: number, y: number) => map.grid[y]?.[x] ?? -1;
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };
  const wet = (v: number) => v === T.water || v === T.deepWater;
  const green = (v: number) => [T.grass, T.flower, T.tallGrass, T.tree, T.sign].includes(v);
  const indoors = ['cave', 'tower', 'seafloor', 'magma', 'ruins', 'birth'].includes(map.biome);

  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const tile = at(x, y);
      const ox = x * 16;
      const oy = y * 16;
      const p = (a: number, b: number, w: number, h: number, color: string) => rect(ox + a, oy + b, w, h, color);
      const adjacent = [at(x, y - 1), at(x + 1, y), at(x, y + 1), at(x - 1, y)];
      const edge = (side: number, color: string, inset = 0) => {
        if (side === 0) p(inset, inset, 16 - inset * 2, 1, color);
        if (side === 1) p(15 - inset, inset, 1, 16 - inset * 2, color);
        if (side === 2) p(inset, 15 - inset, 16 - inset * 2, 1, color);
        if (side === 3) p(inset, inset, 1, 16 - inset * 2, color);
      };
      const seed = ((x * 7349) ^ (y * 1931)) >>> 0;
      const base = (color: string) => p(0, 0, 16, 16, color);
      ctx.drawImage(source, tile * TILE, 0, TILE, TILE, ox, oy, 16, 16);

      if (green(tile)) {
        base(c.grass);
        // 稀疏草尖代替满地噪点；每格确定性变化，不出现棋盘格重复。
        if (seed % 3 === 0) {
          const gx = 2 + seed % 10;
          const gy = 3 + (seed >>> 4) % 9;
          p(gx, gy, 1, 2, c.grassDark); p(gx + 2, gy + 1, 1, 1, c.grassDark);
          p(gx + 1, gy + 2, 1, 1, c.grassLight);
        }
        if (tile === T.tallGrass) {
          for (const [gx, gy] of [[1, 2], [9, 1], [5, 8], [12, 10], [0, 11]]) {
            p(gx, gy + 3, 4, 3, c.tallDark);
            p(gx, gy, 1, 4, c.tall); p(gx + 3, gy + 1, 1, 4, c.tall);
            p(gx + 1, gy + 2, 1, 3, c.tallLight); p(gx + 2, gy + 1, 1, 4, c.tall);
          }
        }
        if (tile === T.flower) {
          for (const [fx, fy] of [[3, 3], [10, 5], [6, 11]]) {
            p(fx, fy + 2, 1, 3, c.tall); p(fx - 1, fy, 3, 1, c.flower);
            p(fx, fy - 1, 1, 3, c.flower); p(fx, fy, 1, 1, '#f8d878');
          }
        }
        if (tile === T.tree) {
          // 三层树冠、枝叶缺口、树干及接地阴影。
          p(3, 13, 11, 2, c.grassDark); p(7, 10, 3, 5, c.trunk);
          p(8, 12, 1, 2, c.pathDark);
          p(5, 0, 6, 2, c.treeDark); p(2, 2, 12, 3, c.treeDark);
          p(1, 5, 14, 6, c.treeDark); p(3, 11, 11, 2, c.treeDark);
          p(4, 2, 8, 3, c.tree); p(2, 5, 12, 5, c.tree); p(4, 10, 8, 2, c.tree);
          p(5, 1, 5, 2, c.treeLight); p(3, 4, 5, 2, c.treeLight);
          p(2, 7, 4, 2, c.treeLight); p(8, 6, 4, 2, c.treeLight);
          p(6, 9, 2, 2, c.treeDark); p(11, 9, 3, 1, c.treeDark);
        }
        if (tile === T.sign) {
          p(3, 14, 11, 1, c.grassDark); p(7, 9, 2, 5, c.trunk);
          p(2, 3, 12, 8, '#59645b'); p(3, 4, 10, 6, '#f8efd0');
          p(4, 5, 8, 1, '#ffffff'); p(5, 7, 6, 1, '#778878'); p(5, 9, 4, 1, '#778878');
        }
      } else if ([T.path, T.sand, T.ash, T.gravel].includes(tile)) {
        const fill = tile === T.path ? c.path : tile === T.sand ? c.sand : tile === T.ash ? c.ash : c.gravel;
        const shade = tile === T.path ? c.pathDark : tile === T.sand ? c.sandDark : tile === T.ash ? c.ashDark : c.gravelDark;
        base(fill);
        p(3 + seed % 5, 3 + (seed >>> 3) % 9, 2, 1, shade);
        if (seed % 2 === 0) p(10, 12, 1, 1, shade);
        adjacent.forEach((v, side) => {
          if (green(v)) { edge(side, c.grassDark); edge(side, shade, 1); }
        });
      } else if (wet(tile) || tile === T.lava) {
        const lava = tile === T.lava;
        base(lava ? c.lava : tile === T.deepWater ? c.waterDeep : c.water);
        for (const [wx, wy] of [[2 + seed % 3, 5], [8 - seed % 3, 12]]) {
          p(wx, wy, 5, 1, lava ? c.lavaHot : c.waterLight);
          p(wx + 5, wy - 1, 2, 1, lava ? c.lavaHot : c.waterLight);
        }
        adjacent.forEach((v, side) => {
          if (v < 0 || v === T.plank || (lava ? v === T.lava : wet(v))) return;
          edge(side, lava ? c.rockDark : (v === T.sand ? c.sandDark : c.grassDark));
          edge(side, lava ? c.lavaDark : c.waterLight, 1);
        });
      } else if (tile === T.rock || tile === T.wall) {
        const shade = tile === T.wall ? c.wallDark : c.rockDark;
        const fill = tile === T.wall ? c.wall : c.rock;
        const light = tile === T.wall ? c.wallLight : c.rockLight;
        base(fill);
        const isolated = adjacent.every((v) => v !== tile);
        if (isolated && tile === T.rock) {
          base(indoors ? c.floor : c.grass);
          p(4, 3, 8, 1, shade); p(2, 5, 12, 8, shade); p(3, 4, 10, 8, fill);
          p(5, 4, 6, 2, light); p(3, 7, 2, 3, light); p(4, 13, 9, 1, shade);
        } else {
          if (adjacent[0] !== tile) { p(0, 0, 16, 2, shade); p(1, 2, 14, 2, light); }
          if (adjacent[2] !== tile) {
            p(0, 9, 16, 7, shade); p(1, 9, 4, 4, fill); p(8, 9, 5, 3, fill);
            p(2, 9, 2, 2, light); p(11, 10, 1, 3, light);
          }
          p(3 + seed % 7, 5, 4, 1, light);
          if (adjacent[3] !== tile) p(0, 0, 1, 16, shade);
          if (adjacent[1] !== tile) p(15, 0, 1, 16, shade);
        }
      } else if (tile === T.plank) {
        base(c.plankDark);
        for (let py = 0; py < 16; py += 4) {
          p(0, py, 16, 3, c.plank); p(0, py, 16, 1, c.pathLight);
        }
        if (adjacent[3] !== T.plank) { p(0, 0, 2, 16, c.plankDark); p(1, 1, 1, 2, c.pathLight); }
        if (adjacent[1] !== T.plank) { p(14, 0, 2, 16, c.plankDark); p(14, 1, 1, 2, c.pathLight); }
      } else if (tile === T.floor || tile === T.altar || tile === T.carpet) {
        const altar = tile === T.altar;
        const carpet = tile === T.carpet;
        base(altar ? c.altar : carpet ? c.carpet : c.floor);
        if (!altar && !carpet) {
          p(0, 15, 16, 1, c.floorDark);
          p((y % 2) * 8, 0, 1, 16, c.floorDark);
          p(1, 0, 15, 1, c.floorLight);
        } else {
          adjacent.forEach((v, side) => {
            if (v !== tile) { edge(side, altar ? c.altarDark : c.carpetDark); edge(side, c.altarGlow, 2); }
          });
          if (altar) { p(7, 6, 2, 4, c.altarDark); p(6, 7, 4, 2, c.altarDark); }
        }
      } else if (tile === T.door) {
        // 野外入口采用石拱；城镇门由整栋建筑覆盖。
        base(indoors ? c.floor : c.grass);
        p(3, 1, 10, 2, c.rockLight); p(1, 3, 14, 13, c.rockDark);
        p(3, 5, 10, 11, '#293c49'); p(5, 3, 6, 13, '#293c49');
        p(3, 14, 10, 2, c.pathDark); p(1, 5, 2, 8, c.rockLight);
      }
    }
  }

  // 屋顶有统一屋脊/檐口，窗、门、招牌以门对象为锚点，避免视觉入口与交互格错位。
  for (const door of map.objects) {
    if (door.kind !== 'door') continue;
    const row = door.y - 1;
    if (at(door.x, row) !== T.roof) continue;
    let left = door.x; let right = door.x; let top = row;
    while (at(left - 1, row) === T.roof) left--;
    while (at(right + 1, row) === T.roof) right++;
    while (at(door.x, top - 1) === T.roof) top--;
    const x = left * 16; const y = top * 16;
    const w = (right - left + 1) * 16; const h = (door.y - top) * 16;
    const roof = door.building === 'center' ? ['#d65b61', '#984557', '#f58b83']
      : door.building === 'shop' ? ['#518cba', '#3b5d89', '#8fc3dc'] : ['#b88858', '#80644e', '#dfb477'];
    rect(x, y, w, h + 16, c.grass);
    rect(x + 2, y + h - 1, w - 4, 17, '#788888');
    rect(x + 4, y + h, w - 8, 13, '#f0e8cf');
    rect(x + 4, y + h + 12, w - 8, 3, '#b8b89d');
    for (const wx of [x + 9, x + w - 21]) {
      rect(wx, y + h + 2, 12, 9, '#647e87'); rect(wx + 1, y + h + 3, 10, 6, '#8ec8d0');
      rect(wx + 2, y + h + 3, 3, 2, '#d9f3e7'); rect(wx + 5, y + h + 2, 1, 8, '#f8f3db');
      rect(wx - 1, y + h + 11, 14, 2, '#ffffff');
    }
    rect(x + 1, y + 4, w - 2, h - 3, roof[1]);
    rect(x + 3, y + 2, w - 6, h - 4, roof[0]);
    rect(x + 5, y, w - 10, 3, roof[1]); rect(x + 6, y + 1, w - 12, 1, roof[2]);
    for (let ry = 6; ry < h - 3; ry += 5) {
      rect(x + 3, y + ry, w - 6, 1, roof[1]); rect(x + 4, y + ry + 1, w - 8, 1, roof[2]);
      for (let rx = 7 + (ry % 2) * 3; rx < w - 4; rx += 8) rect(x + rx, y + ry - 3, 1, 3, roof[1]);
    }
    rect(x, y + h - 3, w, 3, roof[1]); rect(x + 2, y + h - 3, w - 4, 1, roof[2]);
    const dx = door.x * 16;
    rect(dx + 1, door.y * 16, 14, 16, '#70848b'); rect(dx + 3, door.y * 16 + 2, 10, 13, '#344e62');
    rect(dx + 4, door.y * 16 + 3, 8, 8, '#6fa6b6'); rect(dx + 8, door.y * 16 + 2, 1, 13, '#b9d8d2');
    rect(dx + 1, door.y * 16 + 15, 14, 1, '#fff4d5');
    if (door.building !== 'house') {
      rect(dx - 3, y + h - 13, 22, 9, '#526877'); rect(dx - 2, y + h - 12, 20, 7, '#fff6de');
      const mark = door.building === 'center' ? '#ce5960' : '#4e91bd';
      rect(dx + 5, y + h - 11, 6, 5, mark);
      if (door.building === 'center') rect(dx + 3, y + h - 10, 10, 3, mark);
      else { rect(dx + 4, y + h - 11, 8, 1, mark); rect(dx + 7, y + h - 10, 2, 4, '#fff6de'); }
    }
  }
  texture.refresh();
  return key;
}
