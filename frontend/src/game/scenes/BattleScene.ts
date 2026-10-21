import Phaser from 'phaser';
import { worldSpriteKey } from '../world-assets';
import { useBattleStore } from '@/stores/battle';
import {
  MON_BATTLE_FOE_SIZE,
  MON_BATTLE_MY_SIZE,
  cryKey,
  integerMonScale,
  pokemonBackTextureKey,
  pokemonTextureKey,
} from '../mon-assets';

/**
 * BattleScene：回合制战斗画面。数据完全由 battle store 驱动
 * （Socket.IO battle:state 服务端权威），本场景只负责渲染：
 * 双方 sprite 台座、HP 条动画、伤害飘字、属性克制提示。
 */
export class BattleScene extends Phaser.Scene {
  private store = useBattleStore();

  private mySprite?: Phaser.GameObjects.Image;
  private foeSprite?: Phaser.GameObjects.Image;
  private myHpBar!: Phaser.GameObjects.Graphics;
  private foeHpBar!: Phaser.GameObjects.Graphics;
  private myNameText!: Phaser.GameObjects.Text;
  private foeNameText!: Phaser.GameObjects.Text;
  private prevHp = { mine: -1, foe: -1 };
  private unsubscribe?: () => void;

  // 台座布局
  private static MY_POS = { x: 200, y: 352 };
  private static FOE_POS = { x: 720, y: 216 };

  constructor() {
    super('BattleScene');
  }

  create() {
    this.store = useBattleStore();

    const bg = this.add.graphics();
    bg.fillStyle(0xe6e2bd).fillRect(0, 0, 960, 640);
    const terrain = worldSpriteKey('battle-grass');
    if (this.textures.exists(terrain)) {
      this.add.image(0, 0, terrain).setOrigin(0).setScale(4);
    } else {
      bg.fillStyle(0xd9e7c7).fillRect(0, 0, 960, 448);
      bg.fillStyle(0xa8c78b).fillRect(48, 408, 320, 40).fillRect(592, 216, 256, 40);
    }
    // Panels sit above the battlefield image; the background retains original GBA pixels at exactly 4×.
    const panels = this.add.graphics();
    const statusPanel = (x: number, y: number, width: number) => {
      panels.fillStyle(0x7d9486).fillRect(x + 4, y + 4, width, 80);
      panels.fillStyle(0x354f5c).fillRect(x, y, width, 76);
      panels.fillStyle(0xfaf8e9).fillRect(x + 4, y + 4, width - 8, 68);
      panels.fillStyle(0xb9ccb3).fillRect(x + 8, y + 64, width - 16, 4);
    };
    statusPanel(544, 440, 352);
    statusPanel(64, 64, 352);

    this.myHpBar = this.add.graphics();
    this.foeHpBar = this.add.graphics();

    const textStyle = {
      fontFamily: '"Press Start 2P", "Fusion Pixel 12px", monospace',
      fontSize: '12px',
      color: '#354f5c',
    };
    this.myNameText = this.add.text(564, 456, '', textStyle);
    this.foeNameText = this.add.text(84, 80, '', textStyle);

    // 订阅 store：battle:state 到达时重绘
    this.unsubscribe = this.store.$subscribe(() => this.refreshFromState());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => {
      this.unsubscribe?.();
    });
    this.refreshFromState();
  }

  private refreshFromState() {
    const mine = this.store.mySide;
    const foe = this.store.foeSide;
    if (!mine || !foe) return;
    const myMon = mine.team[mine.active];
    const foeMon = foe.team[foe.active];
    if (!myMon || !foeMon) return;

    // sprite（切换宝可梦时重建）：我方用背面图，缺失时回退正面图并镜像
    const backKey = pokemonBackTextureKey(myMon.speciesId);
    const myKey = this.textures.exists(backKey) ? backKey : pokemonTextureKey(myMon.speciesId);
    if (!this.mySprite || this.mySprite.texture.key !== myKey) {
      const firstAppear = !this.mySprite;
      this.mySprite?.destroy();
      this.mySprite = this.add.image(BattleScene.MY_POS.x, BattleScene.MY_POS.y, myKey);
      this.mySprite.setScale(integerMonScale(MON_BATTLE_MY_SIZE, this.mySprite.width));
      this.mySprite.setFlipX(myKey !== backKey);
      this.playCry(myMon.speciesId, firstAppear ? 350 : 0);
    }
    const foeKey = pokemonTextureKey(foeMon.speciesId);
    if (!this.foeSprite || this.foeSprite.texture.key !== foeKey) {
      this.foeSprite?.destroy();
      this.foeSprite = this.add.image(BattleScene.FOE_POS.x, BattleScene.FOE_POS.y, foeKey);
      this.foeSprite.setScale(integerMonScale(MON_BATTLE_FOE_SIZE, this.foeSprite.width));
      this.playCry(foeMon.speciesId);
    }

    this.myNameText.setText(`${myMon.name} Lv${myMon.level}`);
    this.foeNameText.setText(`${foeMon.name} Lv${foeMon.level}`);
    this.drawHpBar(this.myHpBar, 564, 484, 280, myMon.hp, myMon.maxHp);
    this.drawHpBar(this.foeHpBar, 84, 108, 280, foeMon.hp, foeMon.maxHp);

    // HP 下降 → 伤害飘字 + 受击抖动（state 无日志流，按前后帧 HP 差推导）
    if (this.prevHp.mine >= 0 && myMon.hp < this.prevHp.mine && this.mySprite) {
      this.spawnDamageNumber(this.mySprite.x, this.mySprite.y - 80, this.prevHp.mine - myMon.hp);
      this.shakeSprite(this.mySprite);
    }
    if (this.prevHp.foe >= 0 && foeMon.hp < this.prevHp.foe && this.foeSprite) {
      this.spawnDamageNumber(this.foeSprite.x, this.foeSprite.y - 80, this.prevHp.foe - foeMon.hp);
      this.shakeSprite(this.foeSprite);
    }
    this.prevHp = { mine: myMon.hp, foe: foeMon.hp };
  }

  private drawHpBar(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    w: number,
    hp: number,
    maxHp: number,
  ) {
    const pct = maxHp > 0 ? Phaser.Math.Clamp(hp / maxHp, 0, 1) : 0;
    const color = pct <= 0.2 ? 0xd56363 : pct <= 0.5 ? 0xe5bc58 : 0x57b888;
    g.clear();
    g.fillStyle(0x354f5c, 1).fillRect(x - 2, y - 2, w + 4, 16);
    g.fillStyle(0xf8f0d8, 1).fillRect(x, y, w, 12);
    g.fillStyle(color, 1).fillRect(x, y, Math.floor(w * pct), 12);
    g.fillStyle(0xffffff, 0.35).fillRect(x, y, Math.floor(w * pct), 4);
  }

  private spawnDamageNumber(x: number, y: number, dmg: number) {
    const t = this.add
      .text(x, y, `-${dmg}`, {
        fontFamily: '"Press Start 2P", "Fusion Pixel 12px", monospace',
        fontSize: '24px',
        color: '#f8f0d8',
        stroke: '#282828',
        strokeThickness: 4,
      })
      .setOrigin(0.5);
    this.tweens.add({
      targets: t,
      y: y - 60,
      alpha: 0,
      duration: 900,
      ease: 'Cubic.easeOut',
      onComplete: () => t.destroy(),
    });
  }

  private shakeSprite(sprite: Phaser.GameObjects.Image) {
    this.tweens.add({
      targets: sprite,
      x: sprite.x + 10,
      duration: 50,
      yoyo: true,
      repeat: 3,
      onComplete: () => {
        sprite.x = sprite === this.mySprite ? BattleScene.MY_POS.x : BattleScene.FOE_POS.x;
      },
    });
  }

  /** 出场/换宠时播放叫声；素材缺失或解码失败时静默跳过 */
  private playCry(speciesId: number, delay = 0) {
    const key = cryKey(speciesId);
    if (!this.cache.audio.exists(key)) return;
    const play = () => {
      try {
        if (this.sound.locked) {
          // 浏览器自动播放策略：首次交互（点击/按键）解锁后再补播
          this.sound.once(Phaser.Sound.Events.UNLOCKED, () => this.sound.play(key, { volume: 0.6 }));
        } else {
          this.sound.play(key, { volume: 0.6 });
        }
      } catch (e) {
        console.warn('[assets] 叫声播放失败', e);
      }
    };
    if (delay > 0) this.time.delayedCall(delay, play);
    else play();
  }
}
