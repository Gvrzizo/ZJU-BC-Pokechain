/**
 * 静态 NPC 的外观表（纯数据，不依赖 Phaser）：地图里的 NPC 只写 `sprite: 'nurse'` 这类名字，
 * 程序化占位贴图（`world-textures.ts`）与 world 素材包（`world/manifest.json` 的 `sprites`）都按这个名字取图。
 */
export interface NpcPalette {
  hair: string;
  shirt: string;
  pants: string;
  skin: string;
  cap?: string;
  accent?: string;
}

export const NPC_SPRITES: Record<string, NpcPalette> = {
  /** 宝可梦中心护士（白帽 + 红十字） */
  nurse: { hair: '#f0a8c8', shirt: '#ffffff', pants: '#f0a8c8', skin: '#f8d0a0', cap: '#ffffff', accent: '#d84040' },
  /** 主角的妈妈（起始镇民居，赠送跑鞋；红发 + 米色围裙，贴近原作 mom 的配色） */
  mom: { hair: '#b8503c', shirt: '#e8b8a0', pants: '#8a5a40', skin: '#f8d0a0', accent: '#f0e8d8' },
  /** 道具店店员 */
  clerk: { hair: '#4a3420', shirt: '#4a74d0', pants: '#384858', skin: '#f8d0a0', accent: '#f8c848' },
  elder: { hair: '#e0e0e0', shirt: '#a8783c', pants: '#5c4a34', skin: '#e8c8a0', accent: '#6b4a2f' },
  kid: { hair: '#6b4a2f', shirt: '#58a860', pants: '#38506b', skin: '#f8d0a0', cap: '#f8c848' },
  scientist: { hair: '#2b2b2b', shirt: '#f4f4f4', pants: '#384858', skin: '#f8d0a0', accent: '#8898a8' },
  hiker: { hair: '#3a2a18', shirt: '#e08a3c', pants: '#5c4a34', skin: '#e8c8a0', cap: '#8a5a30' },
  sailor: { hair: '#2b2b2b', shirt: '#3a6ec8', pants: '#f4f4f4', skin: '#f8d0a0', cap: '#ffffff', accent: '#d84040' },
  'bug-catcher': { hair: '#4a3420', shirt: '#78c060', pants: '#5c4a34', skin: '#f8d0a0', cap: '#f0f0a0' },
};

export const NPC_SPRITE_NAMES: readonly string[] = Object.keys(NPC_SPRITES);

export function npcLook(name: string): NpcPalette {
  return NPC_SPRITES[name] ?? NPC_SPRITES.elder;
}
