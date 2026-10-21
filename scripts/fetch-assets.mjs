#!/usr/bin/env node
/**
 * 素材一键补全（干净 clone 后运行）：宝可梦 sprite 正/背面 #1-386、全部叫声、道具图标。
 * 世界地图瓦片由 frontend/tools/build-world-assets.py 单独负责（需要 Python+Pillow）。
 * 全部素材仅用于课程演示，不提交 git（frontend/public/assets/vendor/ 已 gitignore）。
 *
 * 用法：node scripts/fetch-assets.mjs [--with-cries=false]
 * 幂等：已存在的文件跳过；失败清单最后汇总，可重跑补齐。
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const VENDOR = `${REPO}frontend/public/assets/vendor`;
const SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-iii/ruby-sapphire';
const CRY_BASE = 'https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/latest';
const ITEM_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items';
const DEX_MAX = 386;

// 道具 typeId → PokeAPI 图标名（无官方图的留空 = 保持程序化回退）
const ITEM_MAP = {
  'poke-ball': 'poke-ball', 'great-ball': 'great-ball', 'ultra-ball': 'ultra-ball', 'master-ball': 'master-ball',
  potion: 'potion', 'super-potion': 'super-potion',
  'thunder-stone': 'thunder-stone', 'water-stone': 'water-stone', 'fire-stone': 'fire-stone',
  'bottle-cap': 'bottle-cap', 'gold-bottle-cap': 'gold-bottle-cap', 'rare-candy': 'rare-candy',
  'tm-thunderbolt': 'tm-electric', 'tm-flamethrower': 'tm-fire', 'tm-surf': 'tm-water',
  'sky-key': 'jade-orb', 'ocean-key': 'blue-orb', 'magma-key': 'red-orb',
  'ruins-key': 'secret-key', 'island-key': 'soul-dew', 'birth-key': 'liberty-pass',
  // running-shoes 使用入库的 GPT Image 补充素材，见 frontend/art/prompts.json。
};

const withCries = !process.argv.includes('--with-cries=false');
const pad3 = (n) => String(n).padStart(3, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { ok: 0, skip: 0, fail: [] };

function checkPng(buf) {
  if (buf.length < 24) return false;
  return buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
}

async function download(url, dest, { validatePng = true } = {}) {
  if (existsSync(dest) && readFileSync(dest).length > 100) { report.skip++; return; }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (validatePng && !checkPng(buf)) throw new Error('not a PNG');
      if (buf.length < 100) throw new Error('empty');
      mkdirSync(new URL(`file://${dest}`).pathname.split('/').slice(0, -1).join('/'), { recursive: true });
      writeFileSync(dest, buf);
      report.ok++;
      return;
    } catch (e) {
      if (attempt === 2) { report.fail.push(`${url} (${e.message})`); return; }
      await sleep(800 * (attempt + 1));
    }
  }
}

async function pool(items, worker, concurrency = 6) {
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < items.length) await worker(items[i++]);
  }));
}

console.log('== 1/3 宝可梦 sprite（红/蓝宝石，正+背 #1-386）==');
const jobs = [];
for (let id = 1; id <= DEX_MAX; id++) {
  jobs.push([`${SPRITE_BASE}/${id}.png`, `${VENDOR}/pokemon/${pad3(id)}.png`]);
  jobs.push([`${SPRITE_BASE}/back/${id}.png`, `${VENDOR}/pokemon/back/${pad3(id)}.png`]);
}
await pool(jobs, ([u, d]) => download(u, d));

console.log('== 2/3 道具图标 ==');
await pool(Object.entries(ITEM_MAP).filter(([, up]) => up), ([typeId, up]) =>
  download(`${ITEM_BASE}/${up}.png`, `${VENDOR}/items/${typeId}.png`));

if (withCries) {
  console.log('== 3/3 叫声（ogg，#1-386）==');
  const cryJobs = [];
  for (let id = 1; id <= DEX_MAX; id++) cryJobs.push([`${CRY_BASE}/${id}.ogg`, `${VENDOR}/cries/${pad3(id)}.ogg`]);
  await pool(cryJobs, ([u, d]) => download(u, d, { validatePng: false }));
} else {
  console.log('== 3/3 叫声：已按参数跳过 ==');
}

console.log(`\n完成：新下载 ${report.ok}，已存在跳过 ${report.skip}，失败 ${report.fail.length}`);
if (report.fail.length) {
  console.log('失败清单（可重跑本脚本补齐）：');
  report.fail.forEach((f) => console.log('  -', f));
}
console.log('提示：世界地图瓦片请再跑 python3 frontend/tools/build-world-assets.py（需 pip install pillow）');
