import type { Facing } from './maps/types';
import type { NpcPalette } from './maps/npcs';

/** 自绘人物：16×20 逻辑像素，四方向共用骨架，服饰、头发和职业细节分别着色。 */
export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  look: NpcPalette,
  facing: Facing,
  step = 0,
  role = '',
): void {
  const shade = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${Math.floor(((n >> 16) & 255) * 0.72)},${Math.floor(((n >> 8) & 255) * 0.72)},${Math.floor((n & 255) * 0.72)})`;
  };
  const back = facing === 'up';
  const side = facing === 'left' || facing === 'right';
  const bob = step ? 1 : 0;
  const p = (x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(ox + (facing === 'right' ? 16 - x - w : x) * 2, oy + y * 2, w * 2, h * 2);
  };
  const ink = '#35434b';
  p(4, 19, 9, 1, '#456c624d');
  p(5, 2 + bob, 6, 1, ink); p(4, 3 + bob, 8, 6, ink);
  p(5, 3 + bob, 6, 5, look.skin); p(5, 7 + bob, 6, 1, shade(look.skin));
  p(5, 2 + bob, 6, 2, look.hair); p(4, 4 + bob, 2, 2, look.hair);
  p(10, 4 + bob, 2, 2, look.hair);
  if (back) p(5, 4 + bob, 6, 4, look.hair);
  else if (side) {
    p(8, 3 + bob, 3, 5, look.hair); p(4, 6 + bob, 1, 1, look.skin);
    p(5, 5 + bob, 1, 2, ink); p(6, 7 + bob, 2, 1, shade(look.skin));
  } else {
    p(6, 5 + bob, 1, 2, ink); p(9, 5 + bob, 1, 2, ink);
    p(7, 7 + bob, 2, 1, shade(look.skin));
  }
  if (look.cap) {
    p(5, 1 + bob, 6, 1, ink); p(4, 2 + bob, 8, 2, look.cap);
    p(side ? 2 : 3, 4 + bob, side ? 9 : 10, 1, shade(look.cap));
    p(5, 2 + bob, 4, 1, '#fff6dd');
    if (role === 'nurse' && !back) { p(7, 2 + bob, 2, 3, '#cc5564'); p(6, 3 + bob, 4, 1, '#cc5564'); }
  }
  p(4, 9 + bob, 8, 6, ink); p(5, 9 + bob, 6, 5, look.shirt);
  p(5, 9 + bob, 5, 1, look.accent ?? '#f5eccc');
  p(10, 10 + bob, 1, 4, shade(look.shirt)); p(5, 14 + bob, 6, 1, shade(look.shirt));
  for (const [x, lift] of [[3, step === 1 ? 1 : 0], [12, step === 2 ? 1 : 0]]) {
    p(x, 10 + bob + lift, 1, 3, look.shirt); p(x, 13 + bob + lift, 1, 1, look.skin);
  }
  if (role === 'mom' && !back) { p(6, 10 + bob, 4, 5, '#fff2d6'); p(5, 14 + bob, 6, 2, '#f0ddc1'); }
  if (role === 'scientist' && !back) {
    p(5, 5 + bob, 3, 2, '#536b7b'); p(9, 5 + bob, 2, 2, '#536b7b');
    p(7, 10 + bob, 2, 5, '#729cac');
  }
  if (role === 'hero' || role === 'hiker' || role === 'bug-catcher') {
    if (back) {
      p(5, 10 + bob, 6, 5, '#667354'); p(6, 10 + bob, 4, 4, '#e2bf73');
      p(6, 13 + bob, 4, 1, '#b58c56');
    } else p(side ? 10 : 5, 10 + bob, 1, 4, '#e2bf73');
  }
  const left = step === 1 ? 1 : 0; const right = step === 2 ? 1 : 0;
  p(5, 15, 2, 3 - left, look.pants); p(9, 15, 2, 3 - right, look.pants);
  p(4, 18 - left, 3, 1, ink); p(9, 18 - right, 3, 1, ink);
  p(5, 17 - left, 2, 1, '#e7e5cf'); p(9, 17 - right, 2, 1, '#e7e5cf');
}
