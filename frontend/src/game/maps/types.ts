import type { ZoneId } from '@/stores/zone';
import type { TileId } from './tiles';

/**
 * 多地图世界的数据定义（纯数据，不依赖 Phaser，可在 vitest 里直接校验）。
 * 每张地图 = 语义瓦片二维数组 + 尺寸 + 生物群系（决定配色/瓦片集）+ 遇敌 zoneId
 * + 传送点 + NPC/路牌/建筑门。引擎（`scenes/OverworldScene.ts`）按这份数据重建场景。
 */
export type MapId =
  | 'town'
  | 'route-grass'
  | 'forest'
  | 'route-mid'
  | 'cave'
  | 'coast'
  | 'route-north'
  | 'volcano'
  | 'sky-pillar-1f'
  | 'sky-pillar-2f'
  | 'seafloor'
  | 'magma'
  | 'ruins'
  | 'southern-island'
  | 'birth-island';

/** 生物群系：决定程序化瓦片集配色与 vendor 瓦片集 key（`world-tiles:<biome>`） */
export type BiomeId =
  | 'town'
  | 'grass'
  | 'forest'
  | 'mid'
  | 'cave'
  | 'coast'
  | 'north'
  | 'volcano'
  | 'tower'
  | 'seafloor'
  | 'magma'
  | 'ruins'
  | 'island'
  | 'birth';

export type Facing = 'down' | 'up' | 'left' | 'right';

/** 瓦片网格：`grid[y][x]` = 语义瓦片索引 */
export type Grid = number[][];

export interface TilePoint {
  x: number;
  y: number;
}

export type WarpKind = 'edge' | 'door' | 'stairs';

/** 传送点：踩到该格即传送（边缘行走 / 建筑门 / 楼梯） */
export interface WarpDef {
  /** 源图块坐标（该格必须是可行走瓦片） */
  x: number;
  y: number;
  to: { mapId: MapId; x: number; y: number };
  kind: WarpKind;
  /**
   * 需要持有的钥匙道具 typeId（**非消耗品**，商店有售）。
   * 未持有且本机没有记忆过通行时，弹对话拦住（"需要 天空之钥 才能进入"）。
   */
  requiresItem?: string;
}

/** NPC：占一格（阻挡通行），面向相邻格按空格对话；`action` 在最后一句后触发 */
export interface NpcDef {
  kind: 'npc';
  x: number;
  y: number;
  /** 程序化 sprite 名（`world-assets` 的 sprites，缺省用同名占位） */
  sprite: string;
  name: string;
  lines: string[];
  /**
   * 对话结束后的动作：`heal` 全队治疗 / `shop` 跳商店 / `talk` 纯剧情
   * （跑鞋这类"一次性事件"由地图对象的 `event` 字段指名，见下）。
   */
  action?: 'heal' | 'shop' | 'talk';
  /**
   * 一次性事件名（`action: 'talk'` 时生效）：引擎按它执行具体逻辑，
   * 目前支持 `'running-shoes'`（起始镇「妈妈」赠送跑鞋，见 `game/running.ts`）。
   */
  event?: 'running-shoes';
  facing?: Facing;
}

/** 路牌：阻挡通行，面向它按空格；`lines` 缺省时自动显示区域名与等级带 */
export interface SignDef {
  kind: 'sign';
  x: number;
  y: number;
  lines?: string[];
}

/** 建筑门（不传送的那种）：踩上去触发（宝可梦中心治疗 / 商店跳转 / 民居闲聊） */
export interface DoorDef {
  kind: 'door';
  x: number;
  y: number;
  building: 'center' | 'shop' | 'house';
  label: string;
  action: 'heal' | 'shop' | 'info';
  lines?: string[];
}

export type MapObject = NpcDef | SignDef | DoorDef;

/** 遇敌配置：哪些瓦片会遇敌 + 每次踏入的概率 */
export interface EncounterDef {
  tiles: TileId[];
  rate: number;
}

export interface MapDef {
  id: MapId;
  /** HUD 显示的地图名（可与区域名不同：如塔内 1F/2F） */
  name: string;
  biome: BiomeId;
  /** 遇敌区域（决定野怪等级带与野生池）；安全区用 `town` 且不配 `encounter` */
  zoneId: ZoneId;
  width: number;
  height: number;
  /** 语义瓦片索引二维数组（`grid[y][x]`，值 = `tiles.ts` 的索引） */
  grid: number[][];
  /** 室内/特殊区的环境压暗层（全图叠加，纯视觉） */
  ambient?: { color: number; alpha: number };
  encounter?: EncounterDef;
  warps: WarpDef[];
  objects: MapObject[];
  /** 地图默认出生点（从别处传送进来的缺省落点） */
  spawn: TilePoint;
  /** 进入地图时横幅的副标题（缺省用区域提示） */
  intro?: string;
}

export function isNpc(obj: MapObject): obj is NpcDef {
  return obj.kind === 'npc';
}

export function isSign(obj: MapObject): obj is SignDef {
  return obj.kind === 'sign';
}

export function isDoor(obj: MapObject): obj is DoorDef {
  return obj.kind === 'door';
}
