import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { OverworldScene } from './scenes/OverworldScene';
import { BattleScene } from './scenes/BattleScene';

export type GameMode = 'overworld' | 'battle';

export function createGame(parent: string | HTMLElement, mode: GameMode): Phaser.Game {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: 960,
    height: 640,
    backgroundColor: '#1c3a1e',
    pixelArt: true,
    roundPixels: true,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: [],
  });
  // 手动注册并启动，确保 BootScene 能拿到 next 参数
  game.scene.add('BootScene', BootScene, false);
  game.scene.add('OverworldScene', OverworldScene, false);
  game.scene.add('BattleScene', BattleScene, false);
  game.scene.start('BootScene', {
    next: mode === 'battle' ? 'BattleScene' : 'OverworldScene',
  });
  return game;
}

export function destroyGame(game: Phaser.Game | null): void {
  if (game) game.destroy(true);
}
