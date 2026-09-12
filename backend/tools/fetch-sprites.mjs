/**
 * 一次性素材下载脚本：第三世代（红/蓝宝石）sprite + 叫声音频。
 *   - 正面  .../generation-iii/ruby-sapphire/<id>.png      → frontend/public/assets/vendor/pokemon/NNN.png（#152–386）
 *   - 背面  .../generation-iii/ruby-sapphire/back/<id>.png → frontend/public/assets/vendor/pokemon/back/NNN.png
 *   - 叫声  https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/latest/<id>.ogg
 *           → frontend/public/assets/vendor/cries/NNN.ogg（全部 inWild 种族，#1–386）
 * PNG 校验魔数 + IHDR 尺寸；0 字节/HTML 响应/失败重试后跳过并记录。
 *
 * 用法：node tools/fetch-sprites.mjs（先跑 tools/gen-pokedex.mjs 生成 /tmp/out/cry-ids.txt）
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 仓库根（backend/tools/ 往上两级） */
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-iii/ruby-sapphire';
const CRY_BASE = 'https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/latest';
const POKEMON_DIR = `${REPO}/frontend/public/assets/vendor/pokemon`;
const BACK_DIR = `${POKEMON_DIR}/back`;
const CRY_DIR = `${REPO}/frontend/public/assets/vendor/cries`;
mkdirSync(BACK_DIR, { recursive: true });
mkdirSync(CRY_DIR, { recursive: true });

const wildIds = JSON.parse(readFileSync('/tmp/out/cry-ids.txt', 'utf8'));
const pad3 = (n) => String(n).padStart(3, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = { front: { ok: 0, skip: 0, fail: [] }, back: { ok: 0, skip: 0, fail: [] }, cry: { ok: 0, skip: 0, fail: [] }, badPng: [], sizes: [] };

function checkPng(buf) {
  if (buf.length < 24) return null;
  const magic = buf.subarray(0, 8);
  if (magic.toString('hex') !== '89504e470d0a1a0a') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function download(url, dest, onOk, kind) {
  if (existsSync(dest) && readFileSync(dest).length > 100) {
    onOk.skip++;
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'pokechain-coursework/1.0' } });
      if (res.status === 404) throw new Error('404');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (kind !== 'cry') {
        const png = checkPng(buf);
        if (!png) throw new Error(`not a PNG (${buf.length} bytes)`);
        if (png.width !== 64 || png.height !== 64) report.badPng.push(`${dest.split('/').pop()} ${png.width}x${png.height}`);
      } else if (buf.length < 200) {
        throw new Error(`suspiciously small audio (${buf.length} bytes)`);
      }
      writeFileSync(dest, buf);
      report.sizes.push(buf.length);
      onOk.ok++;
      return;
    } catch (err) {
      if (attempt === 3) {
        onOk.fail.push(`${pad3(url.split('/').pop().replace('.png', '').replace('.ogg', ''))}: ${err.message}`);
        return;
      }
      await sleep(400 * attempt);
    }
  }
}

async function pool(items, worker, concurrency = 6) {
  let index = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (index < items.length) {
        const item = items[index++];
        await worker(item);
        await sleep(40);
      }
    }),
  );
}

// 正面 + 背面 #152–386
const spriteIds = Array.from({ length: 386 - 152 + 1 }, (_, i) => 152 + i);
await pool(spriteIds, async (id) => {
  await download(`${SPRITE_BASE}/${id}.png`, `${POKEMON_DIR}/${pad3(id)}.png`, report.front, 'sprite');
  await download(`${SPRITE_BASE}/back/${id}.png`, `${BACK_DIR}/${pad3(id)}.png`, report.back, 'sprite');
});
// 叫声：全部 inWild 种族（#1–151 里除手调 4 个进化型外也补齐）
await pool(wildIds, (id) => download(`${CRY_BASE}/${id}.ogg`, `${CRY_DIR}/${pad3(id)}.ogg`, report.cry, 'cry'));

const mb = (report.sizes.reduce((a, b) => a + b, 0) / 1024 / 1024).toFixed(1);
console.log(`正面 sprite: 新下载 ${report.front.ok}，已存在 ${report.front.skip}，失败 ${report.front.fail.length}`);
console.log(`背面 sprite: 新下载 ${report.back.ok}，已存在 ${report.back.skip}，失败 ${report.back.fail.length}`);
console.log(`叫声:        新下载 ${report.cry.ok}，已存在 ${report.cry.skip}，失败 ${report.cry.fail.length}`);
console.log(`本次下载合计 ${mb} MB，非 64×64 sprite: ${report.badPng.length ? report.badPng.join(', ') : '无'}`);
for (const f of [...report.front.fail, ...report.back.fail, ...report.cry.fail]) console.log('FAIL', f);
console.log('CHECK', JSON.stringify({ frontOk: report.front.ok, backOk: report.back.ok, cryOk: report.cry.ok }));
