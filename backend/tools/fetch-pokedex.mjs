/**
 * 一次性数据抓取脚本（PokeChain 图鉴扩充到第三世代 #1-386）。
 *
 * 用途：从 PokeAPI 抓取全国图鉴 #1-386 的
 *   - /pokemon/<id>         种族值六项、属性(按 slot 排序)、特性、英文 slug
 *   - /pokemon-species/<id> 捕获率、官方英文名、zh-hans 中文名、传说/幻之标记、进化链 URL
 *   - /evolution-chain/<n>  进化边（from/to/min_level/trigger/item）
 * 带并发限制与请求间隔，结果缓存到 /tmp/pokeapi-data.json（重跑直接复用，不重复打接口）。
 *
 * 用法：node tools/fetch-pokedex.mjs（只抓数据，不改仓库；生成见 tools/gen-pokedex.mjs）
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const BASE = 'https://pokeapi.co/api/v2';
const OUT = '/tmp/pokeapi-data.json';
const MAX_ID = 386;
const CONCURRENCY = 4;
const DELAY_MS = 80;

const cache = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { pokemon: {}, species: {}, chains: {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, label) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'pokechain-coursework/1.0' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 4) throw new Error(`${label}: ${err.message}`);
      await sleep(500 * attempt);
    }
  }
}

async function pool(items, worker) {
  let index = 0;
  const runners = Array.from({ length: CONCURRENCY }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
      await sleep(DELAY_MS);
    }
  });
  await Promise.all(runners);
}

/** 抓 pokemon + species（带缓存） */
async function fetchSpeciesData() {
  const todo = [];
  for (let id = 1; id <= MAX_ID; id++) {
    if (!cache.pokemon[id]) todo.push(['pokemon', id]);
    if (!cache.species[id]) todo.push(['species', id]);
  }
  console.log(`pokemon/species 待抓取 ${todo.length} 项（缓存命中 ${MAX_ID * 2 - todo.length}）`);
  await pool(todo, async ([kind, id]) => {
    const url = `${BASE}/${kind === 'pokemon' ? 'pokemon' : 'pokemon-species'}/${id}`;
    const json = await getJson(url, url);
    if (!json) {
      console.warn(`404: ${url}`);
      return;
    }
    if (kind === 'pokemon') {
      cache.pokemon[id] = {
        name: json.name,
        types: json.types.sort((a, b) => a.slot - b.slot).map((t) => t.type.name),
        stats: Object.fromEntries(json.stats.map((s) => [s.stat.name, s.base_stat])),
        abilities: json.abilities.sort((a, b) => a.slot - b.slot).map((a) => ({ name: a.ability.name, hidden: a.is_hidden })),
      };
    } else {
      const names = Object.fromEntries(json.names.map((n) => [n.language.name, n.name]));
      cache.species[id] = {
        name: json.name,
        zhHans: names['zh-hans'] ?? null,
        en: names['en'] ?? null,
        captureRate: json.capture_rate,
        isLegendary: json.is_legendary,
        isMythical: json.is_mythical,
        isBaby: json.is_baby,
        evolutionChainUrl: json.evolution_chain?.url ?? null,
      };
    }
  });
  writeFileSync(OUT, JSON.stringify(cache));
}

/** 抓进化链（按 URL 去重，只保留链上落在 #1-386 的种族） */
async function fetchChains() {
  const urls = new Set();
  for (const s of Object.values(cache.species)) if (s.evolutionChainUrl) urls.add(s.evolutionChainUrl);
  const missing = [...urls].filter((u) => !cache.chains[u]);
  console.log(`进化链待抓取 ${missing.length}（总 ${urls.size}）`);
  await pool(missing, async (url) => {
    const json = await getJson(url, url);
    if (!json) return;
    const edges = [];
    const walk = (node) => {
      const fromId = Number(node.species.url.split('/').filter(Boolean).pop());
      for (const next of node.evolves_to ?? []) {
        const toId = Number(next.species.url.split('/').filter(Boolean).pop());
        for (const d of next.evolution_details.length ? next.evolution_details : [{}]) {
          edges.push({
            fromId,
            toId,
            minLevel: d.min_level ?? null,
            trigger: d.trigger?.name ?? null,
            item: d.item?.name ?? null,
            heldItem: d.held_item?.name ?? null,
            timeOfDay: d.time_of_day || null,
          });
        }
        walk(next);
      }
    };
    walk(json.chain);
    cache.chains[url] = edges;
  });
  writeFileSync(OUT, JSON.stringify(cache));
}

await fetchSpeciesData();
await fetchChains();

const ids = Object.keys(cache.pokemon).length;
const zh = Object.values(cache.species).filter((s) => s.zhHans).length;
console.log(`完成：pokemon ${ids} 条，含 zh-hans 名称 ${zh} 条，进化链 ${Object.keys(cache.chains).length} 条`);
console.log(`输出：${OUT}`);
