import Phaser from 'phaser';

const FONT = '"Press Start 2P", "Fusion Pixel 12px", monospace';
const DEPTH = 100;

/**
 * GBA 风格的对话面板（画面底部，固定不随相机滚动）：
 * 深色描边 + 米色面板 + 说话人标签 + 逐句文本 + ▼ 闪烁提示。
 * 只负责渲染；翻页顺序由 `dialog.ts` 的 `DialogSession` 决定。
 */
export class DialogBox {
  private readonly container: Phaser.GameObjects.Container;
  private readonly nameTag: Phaser.GameObjects.Text;
  private readonly body: Phaser.GameObjects.Text;
  private readonly cursor: Phaser.GameObjects.Text;
  private readonly hint: Phaser.GameObjects.Text;

  constructor(
    private readonly scene: Phaser.Scene,
    viewWidth = 960,
    viewHeight = 640,
  ) {
    const boxWidth = viewWidth - 96;
    const boxHeight = 152;
    const x = 48;
    const y = viewHeight - boxHeight - 24;

    const shadow = scene.add
      .rectangle(x + 4, y + 4, boxWidth, boxHeight, 0x1c3a1e, 0.45)
      .setOrigin(0, 0);
    const panel = scene.add
      .rectangle(x, y, boxWidth, boxHeight, 0xf8f0d8, 1)
      .setOrigin(0, 0)
      .setStrokeStyle(4, 0x282828);

    this.nameTag = scene.add.text(x + 14, y - 13, '', {
      fontFamily: FONT,
      fontSize: '12px',
      color: '#f8f0d8',
      backgroundColor: '#2f5d34',
      padding: { x: 8, y: 4 },
    });

    this.body = scene.add.text(x + 18, y + 18, '', {
      fontFamily: FONT,
      fontSize: '12px',
      color: '#282828',
      lineSpacing: 8,
      wordWrap: { width: boxWidth - 36, useAdvancedWrap: true },
    });

    this.cursor = scene.add.text(x + boxWidth - 30, y + boxHeight - 30, '▼', {
      fontFamily: FONT,
      fontSize: '12px',
      color: '#d84040',
    });
    this.hint = scene.add.text(x + 14, y + boxHeight - 26, '空格 / 点击 继续', {
      fontFamily: FONT,
      fontSize: '12px',
      color: '#6b4a2f',
    });

    this.container = scene.add
      .container(0, 0, [shadow, panel, this.nameTag, this.body, this.cursor, this.hint])
      .setScrollFactor(0)
      .setDepth(DEPTH)
      .setVisible(false);

    scene.tweens.add({
      targets: this.cursor,
      alpha: 0,
      duration: 420,
      yoyo: true,
      repeat: -1,
    });
  }

  get isVisible(): boolean {
    return this.container.visible;
  }

  show(speaker: string, line: string, isLast: boolean): void {
    this.nameTag.setText(speaker);
    this.nameTag.setVisible(speaker.length > 0);
    this.body.setText(line);
    this.cursor.setText(isLast ? '●' : '▼');
    this.container.setVisible(true);
  }

  hide(): void {
    this.container.setVisible(false);
  }

  destroy(): void {
    this.container.destroy(true);
  }
}
