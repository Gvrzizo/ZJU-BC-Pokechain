import { cryUrl } from './mon-assets';

/**
 * Vue 覆盖层（捕捉流程等）的叫声播放：Phaser 场景之外的 DOM Audio 路径。
 * 与 BattleScene 播放的是同一份 `public/assets/vendor/cries/NNN.ogg`。
 * 素材缺失 / 浏览器拒绝自动播放（无用户交互）时静默跳过。
 */
const players = new Map<number, HTMLAudioElement>();

export function playCry(speciesId: number, volume = 0.5): void {
  try {
    let el = players.get(speciesId);
    if (!el) {
      el = new Audio(cryUrl(speciesId));
      el.preload = 'auto';
      players.set(speciesId, el);
    }
    el.currentTime = 0;
    el.volume = volume;
    void el.play().catch(() => {});
  } catch {
    // 忽略：素材缺失或播放被拒绝
  }
}
