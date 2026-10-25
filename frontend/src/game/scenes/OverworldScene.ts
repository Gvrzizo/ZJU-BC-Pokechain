import Phaser from 'phaser';
import { getMyItems } from '@/api/items';
import { healTeam } from '@/api/pokemon';
import { claimRunningShoes } from '@/api/auth';
import { usePokemonStore } from '@/stores/pokemon';
import { useWorldStore, readStoredSpawn } from '@/stores/world';
import { zoneHint, zoneById, zoneLabel } from '@/stores/zone';
import { BUS_EVENTS, gameBus } from '../bus';
import { DialogSession } from '../dialog';
import { keyForMap, keyGateStatus, keyName, missingKeyLines } from '../gates';
import {
  hasRunningShoes,
  isRunning,
  setRunningShoes,
  stepDuration,
} from '../running';
import {
  START_MAP_ID,
  T,
  doorAt,
  facingTarget,
  frontOf,
  getMapDef,
  isEncounterTile,
  isWalkable,
  warpAt,
  type BiomeId,
  type DoorDef,
  type Facing,
  type MapDef,
  type MapId,
  type NpcDef,
  type TileId,
  type WarpDef,
} from '../maps';
import { TILE } from '../textures';
import { DialogBox } from '../ui/DialogBox';
import { npcTextureKey } from '../world-textures';
import { makeMapArt } from '../world-art';

/** 遇敌地形的中文名（路牌文案用） */
const TERRAIN_LABEL: Partial<Record<TileId, string>> = {
  tallGrass: '深草',
  sand: '沙地',
  ash: '火山灰',
  gravel: '碎石地',
  altar: '祭坛',
};

/** 每格行走耗时（毫秒）与撞墙动画时长；按住 Shift（有跑鞋）时按 `RUNNING_SPEED_MULTIPLIER` 折半 */
const STEP_MS = 150;
const BUMP_MS = 120;
/** 对话翻页的最小间隔，避免刚开口就被同一次按键翻过去 */
const DIALOG_COOLDOWN_MS = 170;

/** 相机边界外露出的底色（室内/岛屿/火山各有自己的基调） */
const BIOME_BG: Record<BiomeId, string> = {
  town: '#1c3a1e',
  grass: '#1c3a1e',
  forest: '#12240f',
  mid: '#4a4232',
  cave: '#0d1020',
  coast: '#2a86c0',
  north: '#2a4a52',
  volcano: '#2a0f08',
  tower: '#15122a',
  seafloor: '#08203a',
  magma: '#2a0c06',
  ruins: '#2a1c08',
  island: '#2a86c0',
  birth: '#180a2c',
};

/**
 * OverworldScene：把 `maps/*.ts` 的世界数据渲染成可玩的俯视角地图。
 *
 * - **多地图**：`scene.restart({ mapId, spawn })` 换图（维护成本最低的做法），
 *   换图带淡出/淡入；地图间靠边缘行走、门口与楼梯传送，`spawn` 落在目标格上。
 * - **行走**：方向键 / WASD 四向网格移动，阻挡瓦片与 NPC 都不可穿过；
 *   拿到跑鞋（起始镇「妈妈」赠送）后按住 **Shift** 跑步：每格耗时折半、行走动画帧率 ×2。
 * - **遇敌**：只有地图 `encounter.tiles` 列出的地形会触发（镇内没有配置），
 *   触发前把当前区域写进 world store（CaptureOverlay 据此请求后端决定野生池与等级）。
 * - **交互**：面向 NPC / 路牌按空格（或 Z / 回车）对话；踩到门口触发治疗、道具店跳转；
 *   传说区门口校验钥匙道具（`gates.ts`）：门口只查是否持有，钥匙在创建遇敌时消耗；没钥匙弹对话拦住；
 *   带 `event: 'running-shoes'` 的 NPC（妈妈）对话结束后走领取流程。
 * - **HUD**：区域名 / 等级带 / 传说提示 / 跨图横幅都交给 Vue（`WorldHud.vue` 读 world store），
 *   场景只负责写状态，样式与布局在 Vue 侧维护。
 */
export class OverworldScene extends Phaser.Scene {
  private mapDef!: MapDef;
  private player!: Phaser.GameObjects.Sprite;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<string, Phaser.Input.Keyboard.Key>;
  private actionKeys!: Phaser.Input.Keyboard.Key[];
  private shiftKey!: Phaser.Input.Keyboard.Key;
  private dialog!: DialogBox;
  private session: DialogSession | null = null;
  private pendingAction: (() => void) | null = null;
  private dialogOpenedAt = 0;

  private tilePos = { x: 0, y: 0 };
  private facing: Facing = 'down';
  private moving = false;
  /** 本次移动是否跑步（Shift + 跑鞋）：决定移动耗时与行走动画帧率 */
  private running = false;
  /** 传送 / 请求进行中：不接受移动输入 */
  private busy = false;

  constructor() {
    super('OverworldScene');
  }

  init(data: { mapId?: string; spawn?: { x: number; y: number } }) {
    const stored = readStoredSpawn();
    const requested = data?.mapId ?? stored?.mapId ?? START_MAP_ID;
    this.mapDef = getMapDef(requested);
    const spawn =
      data?.spawn ?? (stored && stored.mapId === this.mapDef.id ? { x: stored.x, y: stored.y } : undefined);
    const spot = spawn && isWalkable(this.mapDef, spawn.x, spawn.y) ? spawn : this.mapDef.spawn;
    this.tilePos = { x: spot.x, y: spot.y };
    this.facing = 'down';
    this.moving = false;
    this.running = false;
    this.busy = false;
    this.session = null;
    this.pendingAction = null;
  }

  create() {
    this.cameras.main.setBackgroundColor(BIOME_BG[this.mapDef.biome] ?? '#1c3a1e');
    this.buildTilemap();
    this.addAmbient();
    this.addEncounterHints();
    this.addNpcSprites();
    this.addPlayer();

    const cam = this.cameras.main;
    const mapW = this.mapDef.width * TILE;
    const mapH = this.mapDef.height * TILE;
    const boundsW = Math.max(mapW, this.scale.width);
    const boundsH = Math.max(mapH, this.scale.height);
    // 小图（塔内/遗迹）居中显示，而不是贴左上角露出大片底色
    cam.setBounds(-Math.max(0, (boundsW - mapW) / 2), -Math.max(0, (boundsH - mapH) / 2), boundsW, boundsH);
    cam.setRoundPixels(true);
    cam.startFollow(this.player, true, 1, 1);
    cam.fadeIn(180, 0, 0, 0);

    const keyboard = this.input.keyboard!;
    this.cursors = keyboard.createCursorKeys();
    this.wasd = keyboard.addKeys('W,A,S,D') as Record<string, Phaser.Input.Keyboard.Key>;
    const space = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    const enter = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER);
    const zKey = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.Z);
    this.actionKeys = [space, enter, zKey];
    this.shiftKey = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);

    this.dialog = new DialogBox(this, this.scale.width, this.scale.height);
    this.input.on(Phaser.Input.Events.POINTER_DOWN, () => this.advanceDialog());

    this.events.on(Phaser.Scenes.Events.RESUME, () => {
      this.moving = false;
      this.running = false;
      this.busy = false;
      this.syncHud(false);
    });

    this.syncHud(true);
  }

  // ─────────────────────────────────────────── 渲染

  private buildTilemap() {
    this.add.image(0, 0, makeMapArt(this, this.mapDef)).setOrigin(0).setDepth(1);
  }

  private addAmbient() {
    const ambient = this.mapDef.ambient;
    if (!ambient) return;
    this.add
      .rectangle(0, 0, this.mapDef.width * TILE, this.mapDef.height * TILE, ambient.color, ambient.alpha)
      .setOrigin(0, 0)
      .setDepth(4);
  }

  /** 仅祭坛保留低强度提示；草丛用草叶轮廓识别，不再整片闪白。 */
  private addEncounterHints() {
    if (!this.mapDef.encounter?.tiles.includes('altar')) return;
    const graphics = this.add.graphics().setDepth(1.5);
    graphics.fillStyle(0xfff4cf, 0.45);
    for (let y = 0; y < this.mapDef.height; y++) {
      for (let x = 0; x < this.mapDef.width; x++) {
        if (this.mapDef.grid[y][x] === T.altar && (x + y) % 3 === 0) {
          graphics.fillRect(x * TILE + 14, y * TILE + 12, 4, 4);
        }
      }
    }
  }

  private addNpcSprites() {
    for (const obj of this.mapDef.objects) {
      if (obj.kind !== 'npc') continue;
      const directionalKey = `${npcTextureKey(obj.sprite)}:${obj.facing ?? 'down'}`;
      const key = this.textures.exists(directionalKey) ? directionalKey : npcTextureKey(obj.sprite);
      const texture = this.textures.exists(key) ? key : npcTextureKey('elder');
      this.add.image(obj.x * TILE + TILE / 2, obj.y * TILE + TILE, texture).setOrigin(0.5, 1).setDepth(2 + obj.y / 1000);
    }
  }

  private addPlayer() {
    const anim = `hero-walk-${this.facing}`;
    this.player = this.add.sprite(
      this.tilePos.x * TILE + TILE / 2,
      this.tilePos.y * TILE + TILE,
      'hero',
      0,
    );
    this.player.setOrigin(0.5, 1).setDepth(2 + this.tilePos.y / 1000);
    if (this.anims.exists(anim)) this.player.anims.play(anim, true);
    this.player.anims.stop();
  }

  // ─────────────────────────────────────────── 主循环

  update() {
    if (!this.player) return;
    if (this.session) {
      this.handleDialogKeys();
      return;
    }
    if (this.busy || this.moving) return;

    let dir: Facing | null = null;
    if (this.cursors.left.isDown || this.wasd['A'].isDown) dir = 'left';
    else if (this.cursors.right.isDown || this.wasd['D'].isDown) dir = 'right';
    else if (this.cursors.up.isDown || this.wasd['W'].isDown) dir = 'up';
    else if (this.cursors.down.isDown || this.wasd['S'].isDown) dir = 'down';

    if (dir) {
      this.tryMove(dir);
      return;
    }

    if (this.actionKeys.some((key) => Phaser.Input.Keyboard.JustDown(key))) this.interact();
    else this.player.anims.stop();
  }

  /** 按住 Shift 且已拿到跑鞋 → 跑步（移动耗时减半、行走动画 ×2） */
  private isRunningNow(): boolean {
    return isRunning(this.shiftKey?.isDown ?? false, hasRunningShoes());
  }

  private playWalkAnim(dir: Facing, running: boolean) {
    this.player.anims.play(`hero-walk-${dir}${running ? '-run' : ''}`, true);
  }

  private tryMove(dir: Facing) {
    this.facing = dir;
    const running = this.isRunningNow();
    this.running = running;
    this.playWalkAnim(dir, running);
    const next = frontOf(this.tilePos, dir);
    if (!isWalkable(this.mapDef, next.x, next.y)) {
      // 撞墙 / 撞人：原地踏步一下
      this.moving = true;
      this.time.delayedCall(stepDuration(BUMP_MS, running), () => {
        this.moving = false;
        this.player.anims.stop();
      });
      return;
    }

    this.moving = true;
    this.tilePos = next;
    this.player.setDepth(2 + next.y / 1000);
    gameBus.emit(BUS_EVENTS.PLAYER_MOVED, { ...next, mapId: this.mapDef.id, running });
    this.tweens.add({
      targets: this.player,
      x: next.x * TILE + TILE / 2,
      y: next.y * TILE + TILE,
      duration: stepDuration(STEP_MS, running),
      onComplete: () => {
        this.moving = false;
        this.player.anims.stop();
        this.onArrive(next);
      },
    });
  }

  /** 落到新格子：先看传送点，再看门口，最后才是遇敌 */
  private onArrive(pos: { x: number; y: number }) {
    const warp = warpAt(this.mapDef, pos.x, pos.y);
    if (warp) {
      this.handleWarp(warp);
      return;
    }
    const door = doorAt(this.mapDef, pos.x, pos.y);
    if (door) {
      this.handleDoor(door);
      return;
    }
    this.syncHud(false);
    this.maybeEncounter(pos);
  }

  // ─────────────────────────────────────────── 传送与钥匙

  private travel(mapId: MapId, x: number, y: number) {
    this.busy = true;
    this.cameras.main.fadeOut(180, 0, 0, 0);
    // 用 Clock 定时而不是相机事件：换图不依赖相机特效（特效被跳过时也能照常走）
    this.time.delayedCall(220, () => this.scene.restart({ mapId, spawn: { x, y } }));
  }

  private handleWarp(warp: WarpDef) {
    const keyType = warp.requiresItem ?? keyForMap(warp.to.mapId)?.typeId;
    if (!keyType) {
      this.travel(warp.to.mapId, warp.to.x, warp.to.y);
      return;
    }
    this.busy = true;
    void this.gateCheck(warp, keyType);
  }

  /**
   * 门口钥匙校验：只查**当前持有**（不做“记忆通行”）。
   * 钥匙是一次性的（H11）：真正扣除发生在创建传说区遇敌时，所以门口看到钥匙就放行；
   * 用掉后重进会被拦下，需要回未白镇道具店再买。
   */
  private async gateCheck(warp: WarpDef, keyTypeId: string) {
    const name = keyName(keyTypeId) ?? '钥匙';
    const status = keyGateStatus(warp.to.mapId, await this.fetchOwnedItemTypeIds());
    if (status === 'locked') {
      this.busy = false;
      this.openDialog('门', missingKeyLines(name));
      return;
    }
    // 取物期间玩家可能已经走开：只有还站在传送格上才传
    if (this.tilePos.x !== warp.x || this.tilePos.y !== warp.y) {
      this.busy = false;
      return;
    }
    this.travel(warp.to.mapId, warp.to.x, warp.to.y);
  }

  /** 背包里的道具 typeId（口径：数量 > 0 且未锁定）；接口失败时退回本地缓存 */
  private async fetchOwnedItemTypeIds(): Promise<string[]> {
    const usable = (items: { typeId: string; quantity: number; status?: string }[]) =>
      items
        .filter((i) => i.quantity > 0 && (!i.status || i.status === 'IDLE'))
        .map((i) => i.typeId);
    try {
      const items = await getMyItems();
      try {
        // 顺便刷新背包缓存（道具店买了钥匙之后不必重进页面）
        usePokemonStore().items = items;
      } catch {
        /* Pinia 不在（场景被单测直接创建）时忽略 */
      }
      return usable(items);
    } catch {
      try {
        return usable(usePokemonStore().items);
      } catch {
        return [];
      }
    }
  }

  // ─────────────────────────────────────────── 门口与对话

  private handleDoor(door: DoorDef) {
    const lines = door.lines ?? [`${door.label}的门开着。`];
    if (door.action === 'heal') {
      this.openDialog(door.label, lines, () => void this.healParty(door.label));
      return;
    }
    if (door.action === 'shop') {
      this.openDialog(door.label, lines, () => gameBus.emit(BUS_EVENTS.OPEN_SHOP));
      return;
    }
    this.openDialog(door.label, lines);
  }

  private interact() {
    const target = facingTarget(this.mapDef, this.tilePos, this.facing);
    if (target.kind === 'npc') {
      const npc = target.npc;
      const action =
        npc.action === 'heal'
          ? () => void this.healParty(npc.name)
          : npc.action === 'shop'
            ? () => gameBus.emit(BUS_EVENTS.OPEN_SHOP)
            : npc.action === 'talk' && npc.event === 'running-shoes'
              ? () => void this.takeRunningShoes(npc)
              : undefined;
      this.openDialog(npc.name, npc.lines, action);
      return;
    }
    if (target.kind === 'sign') {
      this.openDialog('路牌', target.sign.lines ?? this.areaSignLines());
    }
  }

  /**
   * 妈妈赠送跑鞋（起始镇）：对话结束才调 `POST /users/me/running-shoes`（幂等，重复领取返回已有的）。
   * 已经拿到过跑鞋时只说关心的话；领取成功后把状态同步给背包缓存与跑步逻辑（HUD 于是显示提示）。
   */
  private async takeRunningShoes(npc: NpcDef) {
    const store = this.pokemonStore();
    if (store?.hasRunningShoes) {
      this.openDialog(npc.name, ['跑鞋合不合脚？按住 Shift 跑起来，别摔着了。']);
      return;
    }
    this.busy = true;
    try {
      const res = await claimRunningShoes();
      setRunningShoes(true);
      gameBus.emit(BUS_EVENTS.RUNNING_SHOES, { speedMultiplier: res.speedMultiplier });
      try {
        await usePokemonStore().refreshItems();
      } catch {
        /* Pinia 不在时忽略（背包缓存下次进页面会刷新） */
      }
      this.openDialog(npc.name, [
        '这是你的跑鞋——穿上它，按住 Shift（或右 Shift）就能跑起来！',
        '速度是走路的两倍，赶路的时候记得按。',
      ]);
    } catch (error: any) {
      const message = error?.response?.data?.message ?? '连接不上服务器，稍后再来拿吧。';
      this.openDialog(npc.name, [`拿跑鞋失败了：${message}`]);
    } finally {
      this.busy = false;
    }
  }

  /** 背包 store（Pinia 不在时返回 null），场景被单测直接创建时也能跑 */
  private pokemonStore(): { hasRunningShoes: boolean } | null {
    try {
      return usePokemonStore();
    } catch {
      return null;
    }
  }

  /** 区域自动路牌：地图名 + 区域等级带 + 阶段门槛 + 遇敌地形 */
  private areaSignLines(): string[] {
    const map = this.mapDef;
    const zone = zoneById(map.zoneId);
    const lines = [`「${map.name}」 ${zone.safe ? '没有野生宝可梦' : zoneLabel(zone)}`];
    const hint = zoneHint(zone);
    if (hint && !zone.legendary) lines.push(hint);
    if (zone.legendary) {
      lines.push(`传说：${zone.legendary.name}（固定等级，池里只有它）`);
    }
    if (map.encounter) {
      const terrain = map.encounter.tiles.map((t) => TERRAIN_LABEL[t] ?? t).join('/');
      lines.push(`走进${terrain}会遇到野生宝可梦（遇到的概率约 ${Math.round(map.encounter.rate * 100)}%）。`);
    }
    return lines;
  }

  private openDialog(speaker: string, lines: string[], action?: () => void) {
    const session = new DialogSession([{ speaker, lines }]);
    if (!session.isOpen) {
      action?.();
      return;
    }
    this.session = session;
    this.pendingAction = action ?? null;
    this.dialogOpenedAt = this.time.now;
    this.dialog.show(session.speaker, session.line, session.isLastLine);
  }

  private handleDialogKeys() {
    if (this.time.now - this.dialogOpenedAt < DIALOG_COOLDOWN_MS) return;
    if (this.actionKeys.some((key) => Phaser.Input.Keyboard.JustDown(key))) this.advanceDialog();
  }

  private advanceDialog() {
    const session = this.session;
    if (!session) return;
    if (this.time.now - this.dialogOpenedAt < DIALOG_COOLDOWN_MS) return;
    const finished = session.advance();
    if (!finished) {
      this.dialog.show(session.speaker, session.line, session.isLastLine);
      return;
    }
    const action = this.pendingAction;
    this.session = null;
    this.pendingAction = null;
    this.dialog.hide();
    action?.();
  }

  /** 宝可梦中心：全队回满，每次 10P（全员满血不收费，见 docs/backend-api.md §10） */
  private async healParty(speaker: string) {
    this.busy = true;
    try {
      const result = await healTeam();
      const lines = result.charged
        ? [
            `你的宝可梦恢复了活力！（花费 ${result.cost} 积分，余额 ${result.points}P）`,
            result.healed.length > 1
              ? `共 ${result.healed.length} 只宝可梦回到满血。`
              : '状态很好，继续加油吧！',
          ]
        : ['全员都是满血状态，这次就不收费啦。'];
      this.openDialog(speaker, lines);
      try {
        await usePokemonStore().refreshPokemon();
      } catch {
        /* HUD 不在时忽略 */
      }
    } catch (error: any) {
      const message = error?.response?.data?.message ?? '连接不上宝可梦中心，请稍后再试。';
      this.openDialog(speaker, [`治疗失败：${message}`]);
    } finally {
      this.busy = false;
    }
  }

  // ─────────────────────────────────────────── 遇敌与 HUD

  private maybeEncounter(pos: { x: number; y: number }) {
    const config = this.mapDef.encounter;
    if (!config) return;
    if (!isEncounterTile(this.mapDef, pos.x, pos.y)) return;
    if (Math.random() >= config.rate) return;
    this.syncHud(false); // 遇敌前把区域交给 CaptureOverlay（后端按 zoneId 决定野生池与等级）
    this.busy = true;
    gameBus.emit(BUS_EVENTS.ENCOUNTER, { zoneId: this.mapDef.zoneId });
    this.scene.pause();
  }

  /** 把地图 / 坐标 / 区域写进 world store（Vue 侧 HUD 与遇敌流程都读它） */
  private syncHud(announce: boolean, running = this.running) {
    try {
      const store = useWorldStore();
      store.enterMap({ mapId: this.mapDef.id, x: this.tilePos.x, y: this.tilePos.y, announce });
      store.isRunning = running;
      if (announce) gameBus.emit(BUS_EVENTS.MAP_CHANGED, { mapId: this.mapDef.id, name: this.mapDef.name });
    } catch {
      // Phaser 场景可能在 Pinia 之外被创建（单测/截图工具）：地图照常可玩，只是没有 HUD
    }
  }

  /** 捕捉流程结束：恢复行走 */
  resumeFromEncounter() {
    this.busy = false;
    this.moving = false;
    this.scene.resume();
  }
}
