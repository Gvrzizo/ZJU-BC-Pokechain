import Phaser from 'phaser';

// Phaser 场景 ↔ Vue HUD 之间的事件总线
export const gameBus = new Phaser.Events.EventEmitter();

export const BUS_EVENTS = {
  /** OverworldScene → GameView：草丛触发随机遇敌 */
  ENCOUNTER: 'encounter',
  /** OverworldScene → GameView：玩家位置变化（调试显示用） */
  PLAYER_MOVED: 'player-moved',
} as const;
