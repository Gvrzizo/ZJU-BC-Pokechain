import Phaser from 'phaser';
import { gameBus, BUS_EVENTS } from '../bus';
import { TILE, type Direction } from '../textures';
import { ZONES, type ZoneDef, zoneAtY, zoneLabel, useZoneStore } from '@/stores/zone';

const MAP_W = 40;
const MAP_H = 30;
const ENCOUNTER_RATE = 0.12; // 踏入深草时的遇敌概率
/** 出生点：南部入口（y 带下沿），新玩家从初始区开始（Lv2-6 只出未进化型） */
const SPAWN = { x: 10, y: 26 };

/** 区域色调（南→北依次加深，仅视觉区分，不改遇敌逻辑） */
const ZONE_TINT: Record<string, number> = {
  south: 0xf8e0a0,
  mid: 0xbcd8a0,
  north: 0x8ea8d0,
};

/**
 * OverworldScene：40x30 程序化草地地图（Tiled JSON 同构的二维数组），
 * 方向键 / WASD 四向网格行走，深草随机遇敌（由 Vue 层调 /capture/encounter）。
 *
 * 地图按 y 分三个**区域等级带**（docs/backend-api.md §2）：南部 Lv2-6（初始区，
 * 只出未进化型）/ 中部 Lv8-16（可出一段进化型）/ 北部 Lv17-28（可出二段进化型）。
 * 区域决定野怪等级与野生池，**与队伍等级无关**；遇敌时把 zoneId 交给后端。
 */
export class OverworldScene extends Phaser.Scene {
  private player!: Phaser.GameObjects.Sprite;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<string, Phaser.Input.Keyboard.Key>;
  private map!: Phaser.Tilemaps.Tilemap;
  private groundLayer!: Phaser.Tilemaps.TilemapLayer;
  private moving = false;
  private facing: Direction = 'down';
  private tilePos = { ...SPAWN };
  private encText!: Phaser.GameObjects.Text;
  private zoneText!: Phaser.GameObjects.Text;
  private bannerText!: Phaser.GameObjects.Text;
  private bannerTween?: Phaser.Tweens.Tween;
  private zoneId = 'south';

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
      this.groundLayer.setDepth(1);
    }
    this.addZoneBands();

    this.player = this.add.sprite(
      this.tilePos.x * TILE + TILE / 2,
      this.tilePos.y * TILE + TILE / 2,
      'hero',
      0,
    );
    this.player.setDepth(2);

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

    // 区域 HUD：常驻显示当前区域名与等级带；跨带时弹一条横幅
    this.zoneText = this.add
      .text(8, 32, '', {
        fontFamily: '"Press Start 2P", "Fusion Pixel 12px", monospace',
        fontSize: '12px',
        color: '#282828',
        backgroundColor: 'rgba(248,240,216,0.92)',
        padding: { x: 6, y: 4 },
      })
      .setScrollFactor(0)
      .setDepth(10);
    this.bannerText = this.add
      .text(480, 96, '', {
        fontFamily: '"Press Start 2P", "Fusion Pixel 12px", monospace',
        fontSize: '12px',
        color: '#f8f0d8',
        backgroundColor: 'rgba(28,58,30,0.88)',
        padding: { x: 10, y: 6 },
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(11)
      .setAlpha(0);
    this.syncZone(this.tilePos.y, false);

    this.events.on(Phaser.Scenes.Events.RESUME, () => {
      this.moving = false;
      this.encText.setText('');
      this.syncZone(this.tilePos.y, false);
    });
  }

  /** 区域色调：三条半透明横带叠在地面层之上（南浅北深），纯视觉区分 */
  private addZoneBands() {
    for (const zone of ZONES) {
      const top = zone.minY * TILE;
      const height = (zone.maxY - zone.minY + 1) * TILE;
      this.add
        .rectangle(0, top, MAP_W * TILE, height, ZONE_TINT[zone.id] ?? 0xffffff, 0.1)
        .setOrigin(0, 0)
        .setDepth(1.5);
    }
  }

  /** 区域信息同步：HUD 常驻 + 跨带时弹横幅；遇敌前由本函数把 zoneId 写进 store */
  private syncZone(y: number, announce: boolean) {
    const zone = zoneAtY(y);
    this.zoneText.setText(`${zoneLabel(zone)}　${this.zoneHint(zone)}`);
    if (announce && zone.id !== this.zoneId) {
      this.showBanner(zone);
    }
    this.zoneId = zone.id;
    try {
      useZoneStore().enter(zone.id);
    } catch {
      // Phaser 场景可能在 Pinia 之外被创建（单测/截图工具）：区域显示不受影响
    }
  }

  private zoneHint(zone: ZoneDef): string {
    if (zone.maxStage <= 0) return '未进化型出没';
    if (zone.maxStage === 1) return '可见进化型';
    return '进化型领地';
  }

  private showBanner(zone: ZoneDef) {
    this.bannerText.setText(`—— ${zoneLabel(zone)} ——`);
    this.bannerTween?.stop();
    this.bannerText.setAlpha(1);
    this.bannerTween = this.tweens.add({
      targets: this.bannerText,
      alpha: 0,
      delay: 1200,
      duration: 600,
    });
  }

  /** 生成 40x30 地图：外圈树，内有几条小径、水池与深草斑块；深草密度随区域升高（越北越密） */
  private generateMapData(): number[][] {
    const grid: number[][] = [];
    for (let y = 0; y < MAP_H; y++) {
      const row: number[] = [];
      // 越靠北深草越密：南部 0.055 / 中部 0.085 / 北部 0.12
      const grassDensity = y >= 20 ? 0.055 : y >= 10 ? 0.085 : 0.12;
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
          (x >= 26 && x <= 34 && y >= 19 && y <= 25) ||
          (x >= 12 && x <= 19 && y >= 20 && y <= 26) // 南部出生点旁的小草窝
        ) {
          if (v === 0) v = 4;
        }
        // 随机树木/深草点缀（确定性伪随机）
        const r = Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
        if (v === 0 && r < 0.04) v = 2;
        else if (v === 0 && r < 0.04 + grassDensity) v = 4;
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

    const crossedZone = zoneAtY(ny).id !== this.zoneId;
    this.moving = true;
    this.tilePos = { x: nx, y: ny };
    gameBus.emit(BUS_EVENTS.PLAYER_MOVED, { x: nx, y: ny });
    this.syncZone(ny, crossedZone);
    this.tweens.add({
      targets: this.player,
      x: nx * TILE + TILE / 2,
      y: ny * TILE + TILE / 2,
      duration: 160,
      onComplete: () => {
        this.moving = false;
        this.player.anims.stop();
        if (target === 4 && Math.random() < ENCOUNTER_RATE) {
          const zone = zoneAtY(ny);
          this.syncZone(ny, false); // 遇敌前把当前区域交给 CaptureOverlay（后端按它决定野生池与等级带）
          this.encText.setText(`! ${zone.name}：野生的宝可梦出现了 !`);
          this.scene.pause();
          gameBus.emit(BUS_EVENTS.ENCOUNTER, { zoneId: zone.id });
        }
      },
    });
  }

  resumeFromEncounter() {
    this.scene.resume();
  }
}
