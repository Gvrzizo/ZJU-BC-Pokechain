import { describe, expect, it } from 'vitest';
import {
  BIOMES,
  LEGENDARY_KEYS,
  LEGENDARY_MAP_IDS,
  MAPS,
  MAP_IDS,
  START_MAP_ID,
  T,
  TILE_COUNT,
  isBlockedIndex,
  isLegendaryMap,
  isWalkable,
  reachable,
  tileIdAt,
  walkableTiles,
  type MapId,
} from './index';
import { NPC_SPRITE_NAMES } from './npcs';
import { zoneById } from '@/stores/zone';
import { seedZonesForTest } from '@/stores/zone.fixture';

// 区域表由后端 GET /capture/zones 提供（前端不再镜像）；地图测试不联网，先灌入与后端一致的响应快照
seedZonesForTest();

const DIRS = [
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
];

const ALL = Object.values(MAPS);

/** 地图数据校验：尺寸/瓦片合法性/落点/传送点/NPC 可达性/区域映射（改地图后跑这套就够） */
describe('地图总表', () => {
  it('覆盖镇 + 七块野外 + 七个传说区内部图', () => {
    expect(MAP_IDS).toEqual([
      'town',
      'route-grass',
      'forest',
      'route-mid',
      'cave',
      'coast',
      'route-north',
      'volcano',
      'sky-pillar-1f',
      'sky-pillar-2f',
      'seafloor',
      'magma',
      'ruins',
      'southern-island',
      'birth-island',
    ]);
    expect(START_MAP_ID).toBe('town');
  });

  it('每张图：网格尺寸一致、瓦片索引合法、生物群系与区域有效', () => {
    const problems: string[] = [];
    for (const map of ALL) {
      if (map.grid.length !== map.height) problems.push(`${map.id}: 行数 ${map.grid.length} ≠ ${map.height}`);
      map.grid.forEach((row, y) => {
        if (row.length !== map.width) problems.push(`${map.id}: 第 ${y} 行宽度 ${row.length} ≠ ${map.width}`);
        row.forEach((tile, x) => {
          if (!Number.isInteger(tile) || tile < 0 || tile >= TILE_COUNT) {
            problems.push(`${map.id}: (${x},${y}) 瓦片索引非法 ${tile}`);
          }
        });
      });
      if (!BIOMES.includes(map.biome)) problems.push(`${map.id}: 生物群系 ${map.biome} 未定义`);
      if (zoneById(map.zoneId).id !== map.zoneId) problems.push(`${map.id}: 区域 ${map.zoneId} 未收录`);
    }
    expect(problems).toEqual([]);
  });

  it('地图名唯一、出生点可站立且不是传送点', () => {
    const problems: string[] = [];
    for (const map of ALL) {
      if (!isWalkable(map, map.spawn.x, map.spawn.y)) problems.push(`${map.id}: 出生点不可站立`);
      if (map.warps.some((w) => w.x === map.spawn.x && w.y === map.spawn.y)) {
        problems.push(`${map.id}: 出生点压在传送点上`);
      }
    }
    const names = ALL.map((m) => m.name);
    expect(problems).toEqual([]);
    expect(new Set(names).size).toBe(MAP_IDS.length);
  });

  it('安全区（未白镇）没有遇敌配置，其它遇敌图的配置都能真正生效', () => {
    expect(MAPS.town.encounter).toBeUndefined();
    expect(MAPS.town.zoneId).toBe('town');
    const problems: string[] = [];
    for (const map of ALL) {
      if (!map.encounter) continue;
      if (!(map.encounter.rate > 0 && map.encounter.rate <= 1)) {
        problems.push(`${map.id}: 遇敌概率 ${map.encounter.rate} 越界`);
      }
      const tiles = new Set(map.encounter.tiles.map((id) => T[id]));
      if (!map.grid.some((row) => row.some((tile) => tiles.has(tile)))) {
        problems.push(`${map.id}: 图上没有 ${map.encounter.tiles.join('/')} 地形`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('NPC / 路牌 / 建筑门都在合法格子上，且不会互相重叠', () => {
    const problems: string[] = [];
    for (const map of ALL) {
      const occupied = new Set<string>();
      for (const obj of map.objects) {
        const key = `${obj.x},${obj.y}`;
        if (occupied.has(key)) problems.push(`${map.id}: (${key}) 有两个交互对象`);
        occupied.add(key);
        const tile = tileIdAt(map, obj.x, obj.y);
        if (!tile) {
          problems.push(`${map.id}: (${key}) 越界`);
          continue;
        }
        if (obj.kind === 'npc') {
          if (!NPC_SPRITE_NAMES.includes(obj.sprite)) problems.push(`${map.id}: NPC 贴图 ${obj.sprite} 未定义`);
          if (obj.lines.length === 0) problems.push(`${map.id}: NPC ${obj.name} 没有台词`);
          if (isBlockedIndex(map.grid[obj.y][obj.x])) problems.push(`${map.id}: NPC ${obj.name} 站在阻挡瓦片上`);
        } else if (obj.kind === 'sign' && tile !== 'sign') {
          problems.push(`${map.id}: 路牌(${key}) 不在 sign 瓦片上（${tile}）`);
        } else if (obj.kind === 'door' && tile !== 'door') {
          problems.push(`${map.id}: 门(${key}) 不在 door 瓦片上（${tile}）`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('NPC 与路牌都能搭话（旁边至少有一个从出生点可达的格子）', () => {
    const problems: string[] = [];
    for (const map of ALL) {
      const reach = reachable(map, map.spawn);
      for (const obj of map.objects) {
        const talkable = DIRS.some((d) => reach.has(`${obj.x + d.x},${obj.y + d.y}`));
        if (!talkable) problems.push(`${map.id}: ${obj.kind}(${obj.x},${obj.y}) 旁边走不到`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('传送点', () => {
  it('传送格可通行，目标图存在、落点可站立、落点不是传送点（防死循环）', () => {
    const warpTiles = new Set(
      ALL.flatMap((map) => map.warps.map((w) => `${map.id}:${w.x},${w.y}`)),
    );
    const problems: string[] = [];
    for (const map of ALL) {
      for (const warp of map.warps) {
        const target = MAPS[warp.to.mapId];
        if (!target) {
          problems.push(`${map.id}: 传送目标 ${warp.to.mapId} 不存在`);
          continue;
        }
        if (!isWalkable(map, warp.x, warp.y)) problems.push(`${map.id}: 传送格(${warp.x},${warp.y}) 不可站立`);
        if (!isWalkable(target, warp.to.x, warp.to.y)) {
          problems.push(`${map.id} → ${target.id}: 落点(${warp.to.x},${warp.to.y}) 不可站立`);
        }
        if (warpTiles.has(`${target.id}:${warp.to.x},${warp.to.y}`)) {
          problems.push(`${map.id} → ${target.id}: 落点本身就是传送点（会来回弹）`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('传送都有回路：目标图里有回到本图的传送点', () => {
    const problems: string[] = [];
    for (const map of ALL) {
      for (const warp of map.warps) {
        if (!MAPS[warp.to.mapId].warps.some((w) => w.to.mapId === map.id)) {
          problems.push(`${map.id} → ${warp.to.mapId} 没有回程`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('从出生点可以走到本图每一个传送点，且图内够大（不会把自己封死）', () => {
    const problems: string[] = [];
    for (const map of ALL) {
      const reach = reachable(map, map.spawn);
      for (const warp of map.warps) {
        if (!reach.has(`${warp.x},${warp.y}`)) problems.push(`${map.id}: 传送点(${warp.x},${warp.y}) 走不到`);
      }
      if (walkableTiles(map).size <= 30) problems.push(`${map.id}: 可走格子太少`);
    }
    expect(problems).toEqual([]);
  });

  it('从镇出发（沿传送图走，忽略钥匙）可以到达全部地图', () => {
    const seen = new Set<MapId>([START_MAP_ID]);
    const queue: MapId[] = [START_MAP_ID];
    while (queue.length > 0) {
      const current = MAPS[queue.shift()!];
      for (const warp of current.warps) {
        if (seen.has(warp.to.mapId)) continue;
        seen.add(warp.to.mapId);
        queue.push(warp.to.mapId);
      }
    }
    expect(MAP_IDS.filter((id) => !seen.has(id))).toEqual([]);
  });
});

describe('传说区与钥匙', () => {
  it('传说区内部图都有对应钥匙道具（天空之柱 2F 走 1F 楼梯，不再单独验钥匙）', () => {
    const keyed = new Set(Object.values(LEGENDARY_KEYS).flatMap((def) => def.maps));
    const missing = LEGENDARY_MAP_IDS.filter((id) => id !== 'sky-pillar-2f' && !keyed.has(id));
    expect(missing).toEqual([]);
    expect(Object.keys(LEGENDARY_KEYS).sort()).toEqual(
      ['birth-key', 'island-key', 'magma-key', 'ocean-key', 'ruins-key', 'sky-key'].sort(),
    );
  });

  it('钥匙表与区域表（zone.legendary.keyTypeId）一致', () => {
    const problems: string[] = [];
    for (const [typeId, def] of Object.entries(LEGENDARY_KEYS)) {
      for (const mapId of def.maps) {
        const zone = zoneById(MAPS[mapId].zoneId);
        if (zone.legendary?.keyTypeId !== typeId) {
          problems.push(`${mapId}: 区域钥匙 ${zone.legendary?.keyTypeId ?? '（无）'} ≠ ${typeId}`);
        }
      }
    }
    // 反向：区域表里的传说区钥匙都在地图里有对应的门
    const gatedZones = ALL.filter((map) => zoneById(map.zoneId).legendary).map((map) => map.zoneId);
    for (const zoneId of new Set(gatedZones)) {
      if (zoneId === 'sky-pillar') continue; // 2F 与 1F 共用
      const key = zoneById(zoneId).legendary!.keyTypeId;
      if (!(key in LEGENDARY_KEYS)) problems.push(`${zoneId}: 区域钥匙 ${key} 不在钥匙表里`);
    }
    expect(problems).toEqual([]);
  });

  it('传说区地图的 zone 都是传说区，遇敌只发生在祭坛上（1F 无遇敌）', () => {
    const problems: string[] = [];
    for (const mapId of LEGENDARY_MAP_IDS) {
      const map = MAPS[mapId];
      if (!isLegendaryMap(map.id)) problems.push(`${mapId}: 不在传说区清单里`);
      if (!zoneById(map.zoneId).legendary) problems.push(`${mapId}: 区域没有传说定义`);
    }
    expect(problems).toEqual([]);
    expect(MAPS['sky-pillar-1f'].encounter).toBeUndefined();
    for (const mapId of [
      'sky-pillar-2f',
      'seafloor',
      'magma',
      'ruins',
      'southern-island',
      'birth-island',
    ] as MapId[]) {
      expect(MAPS[mapId].encounter?.tiles).toEqual(['altar']);
    }
  });

  it('带钥匙要求的传送点共 6 个，且都指向传说区', () => {
    const gates = ALL.flatMap((map) =>
      map.warps.filter((w) => w.requiresItem).map((w) => ({ from: map.id, warp: w })),
    );
    expect(gates.length).toBe(6);
    const problems = gates
      .filter(({ warp }) => !isLegendaryMap(warp.to.mapId) || !(warp.requiresItem! in LEGENDARY_KEYS))
      .map(({ from }) => `${from}: 钥匙门槛配置不对`);
    expect(problems).toEqual([]);
  });
});

describe('区域映射与阻挡瓦片', () => {
  it('每张图的 zoneId 与野外/传说区口径一致', () => {
    expect(MAPS.town.zoneId).toBe('town');
    expect(MAPS['route-grass'].zoneId).toBe('route-grass');
    expect(MAPS.forest.zoneId).toBe('forest');
    expect(MAPS['route-mid'].zoneId).toBe('route-mid');
    expect(MAPS.cave.zoneId).toBe('cave');
    expect(MAPS.coast.zoneId).toBe('coast');
    expect(MAPS['route-north'].zoneId).toBe('route-north');
    expect(MAPS.volcano.zoneId).toBe('volcano');
    expect(MAPS['sky-pillar-2f'].zoneId).toBe('sky-pillar');
    expect(MAPS.seafloor.zoneId).toBe('seafloor');
    expect(MAPS.magma.zoneId).toBe('magma');
    expect(MAPS.ruins.zoneId).toBe('ruins');
    expect(MAPS['southern-island'].zoneId).toBe('southern-island');
    expect(MAPS['birth-island'].zoneId).toBe('birth-island');
  });

  it('阻挡瓦片确实不可通行（水/岩/树/墙/屋顶…）', () => {
    const problems: string[] = [];
    for (const map of ALL) {
      for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
          if (isBlockedIndex(map.grid[y][x]) && isWalkable(map, x, y)) {
            problems.push(`${map.id}: (${x},${y}) 阻挡瓦片却可走`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
