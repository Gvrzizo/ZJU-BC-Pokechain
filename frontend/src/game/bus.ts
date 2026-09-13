import Phaser from 'phaser';

// Phaser 场景 ↔ Vue HUD 之间的事件总线
export const gameBus = new Phaser.Events.EventEmitter();

export const BUS_EVENTS = {
  /** OverworldScene → GameView：踏上遇敌地形触发野怪遭遇（CaptureOverlay 读 zone store） */
  ENCOUNTER: 'encounter',
  /** OverworldScene → GameView：玩家位置变化（HUD 坐标显示；payload 带 running 标记） */
  PLAYER_MOVED: 'player-moved',
  /** OverworldScene → GameView：跨地图（HUD 横幅，payload: { mapId, name, tone }） */
  MAP_CHANGED: 'map-changed',
  /** OverworldScene → GameView：商店店员/道具店门口 → 跳转 /shop */
  OPEN_SHOP: 'open-shop',
  /** OverworldScene → GameView：妈妈赠送了跑鞋（payload: { speedMultiplier }，HUD 提示"按住 Shift 跑步"） */
  RUNNING_SHOES: 'running-shoes',
} as const;
