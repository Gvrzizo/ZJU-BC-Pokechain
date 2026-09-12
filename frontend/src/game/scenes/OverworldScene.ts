import Phaser from 'phaser';
import { gameBus, BUS_EVENTS } from '../bus';
import { TILE, type Direction } from '../textures';

const MAP_W = 40;
const MAP_H = 30;
const ENCOUNTER_RATE = 0.12; // 踏入深草时的遇敌概率

/**
 * OverworldScene：40x30 程序化草地地图（Tiled JSON 同构的二维数组），
 * 方向键 / WASD 四向网格行走，深草随机遇敌（由 Vue 层调 /capture/encounter）。
 */
export class OverworldScene extends Phaser.Scene {
  private player!: Phaser.GameObjects.Sprite;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<string, Phaser.Input.Keyboard.Key>;
  private map!: Phaser.Tilemaps.Tilemap;
  private groundLayer!: Phaser.Tilemaps.TilemapLayer;
  private moving = false;
  private facing: Direction = 'down';
  private tilePos = { x: 5, y: 5 };
  private encText!: Phaser.GameObjects.Text;

  constructor() {
    super('OverworldScene');
  }

  create() {
    const data = this.generateMapData();
    this.map = this.make.tilemap({ data, tileWidth: TILE, tileHeight: TILE });
    const tiles = this.map.addTilesetImage('tiles', 'tiles', TILE, TILE, 0, 0);
    if (tiles) {
      this.groundLayer = this.map.createLayer(0, tiles, 0, 0)!;
      this.groundLayer.setCollision([2, 3]); // 树与水不可通行
    }

    this.player = this.add.sprite(
      this.tilePos.x * TILE + TILE / 2,
      this.tilePos.y * TILE + TILE / 2,
      'hero',
      0,
    );

    const cam = this.cameras.main;
    cam.startFollow(this.player, true, 1, 1);
    cam.setBounds(0, 0, MAP_W * TILE, MAP_H * TILE);

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = this.input.keyboard!.addKeys('W,A,S,D') as Record<
      string,
      Phaser.Input.Keyboard.Key
    >;

    this.encText = this.add
      .text(8, 8, '', {
        fontFamily: '"Press Start 2P", "Fusion Pixel 12px", monospace',
        fontSize: '12px',
        color: '#f8f0d8',
        backgroundColor: 'rgba(28,58,30,0.8)',
        padding: { x: 6, y: 4 },
      })
      .setScrollFactor(0)
      .setDepth(10);

    this.events.on(Phaser.Scenes.Events.RESUME, () => {
      this.moving = false;
      this.encText.setText('');
    });
  }

  /** 生成 40x30 地图：外圈树，内有几条小径、水池与深草斑块 */
  private generateMapData(): number[][] {
    const grid: number[][] = [];
    for (let y = 0; y < MAP_H; y++) {
      const row: number[] = [];
      for (let x = 0; x < MAP_W; x++) {
        if (x === 0 || y === 0 || x === MAP_W - 1 || y === MAP_H - 1) {
          row.push(2); // 边界树
          continue;
        }
        let v = 0; // 默认草地
        // 十字小径
        if (y === 15 || x === 20) v = 1;
        // 左下水池
        if (x >= 4 && x <= 9 && y >= 20 && y <= 25) v = 3;
        // 几块深草区
        if (
          (x >= 25 && x <= 33 && y >= 4 && y <= 10) ||
          (x >= 5 && x <= 12 && y >= 5 && y <= 9) ||
          (x >= 26 && x <= 34 && y >= 19 && y <= 25)
        ) {
          if (v === 0) v = 4;
        }
        // 随机树木点缀（确定性伪随机）
        const r = Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
        if (v === 0 && r < 0.04) v = 2;
        row.push(v);
      }
      grid.push(row);
    }
    return grid;
  }

  private tileAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return 2;
    return this.map.getTileAt(x, y)?.index ?? 2;
  }

  update() {
    if (this.scene.isPaused('OverworldScene')) return;
    if (this.moving) return;

    let dir: Direction | null = null;
    if (this.cursors.left.isDown || this.wasd['A'].isDown) dir = 'left';
    else if (this.cursors.right.isDown || this.wasd['D'].isDown) dir = 'right';
    else if (this.cursors.up.isDown || this.wasd['W'].isDown) dir = 'up';
    else if (this.cursors.down.isDown || this.wasd['S'].isDown) dir = 'down';

    if (!dir) {
      this.player.anims.stop();
      return;
    }

    this.facing = dir;
    const delta = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
    const nx = this.tilePos.x + delta[0];
    const ny = this.tilePos.y + delta[1];
    const target = this.tileAt(nx, ny);

    // 面向即转；撞墙原地踏步动画
    this.player.anims.play(`hero-walk-${dir}`, true);
    if (target === 2 || target === 3) {
      this.moving = true;
      this.time.delayedCall(120, () => {
        this.moving = false;
        this.player.anims.stop();
      });
      return;
    }

    this.moving = true;
    this.tilePos = { x: nx, y: ny };
    gameBus.emit(BUS_EVENTS.PLAYER_MOVED, { x: nx, y: ny });
    this.tweens.add({
      targets: this.player,
      x: nx * TILE + TILE / 2,
      y: ny * TILE + TILE / 2,
      duration: 160,
      onComplete: () => {
        this.moving = false;
        this.player.anims.stop();
        if (target === 4 && Math.random() < ENCOUNTER_RATE) {
          this.encText.setText('! 野生的宝可梦出现了 !');
          this.scene.pause();
          gameBus.emit(BUS_EVENTS.ENCOUNTER);
        }
      },
    });
  }

  resumeFromEncounter() {
    this.scene.resume();
  }
}
