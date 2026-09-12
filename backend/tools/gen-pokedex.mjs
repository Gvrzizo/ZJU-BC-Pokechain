/**
 * 一次性生成脚本：把 PokeAPI 原始数据（默认 /tmp/pokeapi-data.json、/tmp/pokeapi-moves.json，
 * 由 tools/fetch-pokedex.mjs 抓取）转成 PokeChain 的数据与代码片段（输出到 /tmp/out/）：
 *   1. species.data.ts        —— #1–386 全量 SPECIES + EVOLUTIONS（手调 12 条原样保留）
 *   2. {zh,en}-pokemon.txt    —— locales 的 pokemon 词条片段（#152–386）
 *   3. {zh,en}-moves.txt      —— locales 的 moves 词条片段（新增技能）
 *   4. moves-rows.txt         —— moves.data.ts 的 MoveRow 片段（新增技能）
 *   5. cry-ids.txt            —— 前端 CRY_SPECIES_IDS（inWild 种族）
 *
 * 设计口径（见 backend/README.md「图鉴数据」）：
 *   - type：PokeAPI 第一属性（slot 1）；双属性只保留主属性（本作战斗是单属性模型）
 *   - inWild：传说/幻之 = false；手调的 4 个进化型（26/134/135/136）保持 false；其余 true
 *   - defaultMoves：按「主属性+副属性」技能按威力升序取 4 个摊开，不足用一般属性补齐
 *   - EVOLUTIONS：进化链两端都在 #1–386 内即收录；minLevel 取 PokeAPI，非升级进化给保守默认值
 *
 * 用法：node tools/gen-pokedex.mjs（产物在 /tmp/out/，人工确认后复制进仓库）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const data = JSON.parse(readFileSync('/tmp/pokeapi-data.json', 'utf8'));
const moveMeta = JSON.parse(readFileSync('/tmp/pokeapi-moves.json', 'utf8'));
/** 仓库根（backend/tools/ 往上两级） */
const REPO = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync('/tmp/out', { recursive: true });

/* ---------------- 输入：现有词典里的 151 个中文名（保持官方译名不变） ---------------- */
const zhLocale = readFileSync(`${REPO}/frontend/src/locales/zh.ts`, 'utf8');
const zhNames151 = {};
{
  const block = zhLocale.slice(zhLocale.indexOf('pokemon: {'), zhLocale.indexOf('\n  },', zhLocale.indexOf('pokemon: {')));
  for (const m of block.matchAll(/(\d+):\s*'([^']+)'/g)) zhNames151[Number(m[1])] = m[2];
}
for (let id = 1; id <= 151; id++) if (!zhNames151[id]) throw new Error(`locale 缺 #${id} 中文名`);

/* ---------------- 技能表：现有 24 个 + 新增 16 个 ---------------- */
const EXISTING_MOVES = [
  ['tackle', 'normal', 40], ['quick-attack', 'normal', 40], ['body-slam', 'normal', 85], ['hyper-beam', 'normal', 150],
  ['thunder-shock', 'electric', 40], ['spark', 'electric', 65], ['thunderbolt', 'electric', 90], ['thunder', 'electric', 110],
  ['ember', 'fire', 40], ['fire-fang', 'fire', 65], ['blaze-kick', 'fire', 85], ['flamethrower', 'fire', 90], ['fire-blast', 'fire', 110],
  ['water-gun', 'water', 40], ['aqua-tail', 'water', 90], ['surf', 'water', 90], ['hydro-pump', 'water', 110],
  ['absorb', 'grass', 20], ['vine-whip', 'grass', 45], ['razor-leaf', 'grass', 55], ['giga-drain', 'grass', 75], ['leaf-blade', 'grass', 90], ['solar-beam', 'grass', 120],
  ['psybeam', 'psychic', 65], ['psychic', 'psychic', 90],
  ['bite', 'dark', 60], ['crunch', 'dark', 80], ['dark-pulse', 'dark', 80],
  ['dragon-breath', 'dragon', 60], ['dragon-claw', 'dragon', 80],
  ['poison-sting', 'poison', 15], ['sludge-bomb', 'poison', 90],
  ['wing-attack', 'flying', 60], ['fly', 'flying', 90],
  ['metal-claw', 'steel', 50], ['iron-tail', 'steel', 100],
  ['silver-wind', 'bug', 60],
  ['brick-break', 'fighting', 75],
  ['shadow-ball', 'ghost', 80],
  ['rock-slide', 'rock', 75],
  ['dig', 'ground', 80], ['earthquake', 'ground', 100],
  ['ice-beam', 'ice', 90],
].map(([id, type, power]) => ({ id, type, power }));
const MOVE_BY_ID = Object.fromEntries(EXISTING_MOVES.map((m) => [m.id, m]));

/** 手调 12 条的 defaultMoves 必须原样保留（不参与生成） */
const HAND_TUNED_IDS = new Set([25, 6, 9, 3, 133, 143, 94, 149, 26, 134, 135, 136]);

function movesFor(types) {
  const typed = EXISTING_MOVES.filter((m) => types.includes(m.type)).sort((a, b) => a.power - b.power);
  const picks = [];
  if (typed.length <= 4) {
    picks.push(...typed.map((m) => m.id));
  } else {
    const last = typed.length - 1;
    for (const i of new Set([0, Math.round(last / 3), Math.round((2 * last) / 3), last])) picks.push(typed[i].id);
  }
  for (const m of EXISTING_MOVES.filter((x) => x.type === 'normal').sort((a, b) => a.power - b.power)) {
    if (picks.length >= 4) break;
    if (!picks.includes(m.id)) picks.push(m.id);
  }
  if (picks.length < 4) throw new Error(`moveset 不足 4 个：${types.join('/')}`);
  return picks.slice(0, 4);
}

/* ---------------- 物种条目生成 ---------------- */
const STAT_KEYS = ['hp', 'attack', 'defense', 'special-attack', 'special-defense', 'speed'];
const EVO_ONLY = new Set([26, 134, 135, 136]);
/**
 * PokeAPI zh-hans 的两处偏差（已核对官方简体中文）：
 *  - #233 官方于 2020-03 把「多边兽Ⅱ」改名为「多边兽2型」
 *  - #312 PokeAPI 数据混入了繁体字「負」，应为「负电拍拍」
 */
const ZH_FIXES = { 233: '多边兽2型', 312: '负电拍拍' };
const entries = [];
const wildIds = [];
const legendaries = [];
for (let id = 1; id <= 386; id++) {
  const p = data.pokemon[id];
  const s = data.species[id];
  if (!p || !s) throw new Error(`缺 #${id} 数据`);
  const types = p.types;
  const type = types[0];
  const base = Object.fromEntries(STAT_KEYS.map((k) => [k, p.stats[k]]));
  const ability = (p.abilities.find((a) => !a.hidden) ?? p.abilities[0]).name;
  const legendary = s.isLegendary || s.isMythical;
  const inWild = !legendary && !EVO_ONLY.has(id);
  const nameZh = id <= 151 ? zhNames151[id] : (ZH_FIXES[id] ?? s.zhHans);
  if (!nameZh) throw new Error(`#${id} 缺中文名`);
  if (legendary) legendaries.push(id);
  else if (inWild) wildIds.push(id);
  entries.push({
    id,
    name: s.name,
    nameZh,
    type,
    base,
    ability,
    moves: HAND_TUNED_IDS.has(id) ? null : movesFor(types),
    catchRate: s.captureRate,
    inWild,
    types,
  });
}

const statLine = (b) => `{ hp: ${b.hp}, atk: ${b.attack}, def: ${b.defense}, spatk: ${b['special-attack']}, spdef: ${b['special-defense']}, speed: ${b.speed} }`;
const fmtMoves = (moves) => `[${moves.map((m) => `'${m}'`).join(', ')}]`;

const HAND_TUNED_BLOCK = `    S(25, 'pikachu', '皮卡丘', 'electric', { hp: 35, atk: 55, def: 40, spatk: 50, spdef: 50, speed: 90 }, 'static', ['thunder-shock', 'quick-attack', 'spark', 'thunderbolt'], 190),
    S(6, 'charizard', '喷火龙', 'fire', { hp: 78, atk: 84, def: 78, spatk: 109, spdef: 85, speed: 100 }, 'blaze', ['ember', 'fire-fang', 'flamethrower', 'fire-blast'], 45),
    S(9, 'blastoise', '水箭龟', 'water', { hp: 79, atk: 83, def: 100, spatk: 85, spdef: 105, speed: 78 }, 'torrent', ['water-gun', 'bite', 'aqua-tail', 'hydro-pump'], 45),
    S(3, 'venusaur', '妙蛙花', 'grass', { hp: 80, atk: 82, def: 83, spatk: 100, spdef: 100, speed: 80 }, 'overgrow', ['vine-whip', 'razor-leaf', 'tackle', 'solar-beam'], 45),
    S(133, 'eevee', '伊布', 'normal', { hp: 55, atk: 55, def: 50, spatk: 45, spdef: 65, speed: 55 }, 'adaptability', ['tackle', 'quick-attack', 'bite', 'body-slam'], 45),
    S(143, 'snorlax', '卡比兽', 'normal', { hp: 160, atk: 110, def: 65, spatk: 65, spdef: 110, speed: 30 }, 'thick-fat', ['tackle', 'body-slam', 'crunch', 'hyper-beam'], 25),
    S(94, 'gengar', '耿鬼', 'dark', { hp: 60, atk: 65, def: 60, spatk: 130, spdef: 75, speed: 110 }, 'levitate', ['dark-pulse', 'bite', 'psybeam', 'crunch'], 45),
    S(149, 'dragonite', '快龙', 'dragon', { hp: 91, atk: 134, def: 95, spatk: 100, spdef: 100, speed: 80 }, 'inner-focus', ['tackle', 'aqua-tail', 'crunch', 'hyper-beam'], 45),
    // evolution-only entries (never appear in the wild table)
    S(26, 'raichu', '雷丘', 'electric', { hp: 60, atk: 90, def: 55, spatk: 90, spdef: 80, speed: 110 }, 'static', ['thunder-shock', 'spark', 'thunderbolt', 'thunder'], 75, false),
    S(134, 'vaporeon', '水伊布', 'water', { hp: 130, atk: 65, def: 60, spatk: 110, spdef: 95, speed: 65 }, 'water-absorb', ['water-gun', 'surf', 'aqua-tail', 'hydro-pump'], 45, false),
    S(135, 'jolteon', '雷伊布', 'electric', { hp: 65, atk: 65, def: 60, spatk: 110, spdef: 95, speed: 130 }, 'volt-absorb', ['thunder-shock', 'spark', 'thunderbolt', 'thunder'], 45, false),
    S(136, 'flareon', '火伊布', 'fire', { hp: 65, atk: 130, def: 60, spatk: 95, spdef: 110, speed: 65 }, 'flash-fire', ['ember', 'fire-fang', 'flamethrower', 'fire-blast'], 45, false),`;

const generatedLines = entries
  .filter((e) => !HAND_TUNED_IDS.has(e.id))
  .map((e) => `    S(${e.id}, '${e.name}', '${e.nameZh}', '${e.type}', ${statLine(e.base)}, '${e.ability}', ${fmtMoves(e.moves)}, ${e.catchRate}${e.inWild ? '' : ', false'}),`);

/* ---------------- 进化规则 ---------------- */
const HAND_TUNED_EVOS = [
  { from: 25, to: 26, minLevel: 20, stoneTypeId: 'thunder-stone' },
  { from: 133, to: 134, minLevel: 15, stoneTypeId: 'water-stone' },
  { from: 133, to: 135, minLevel: 15, stoneTypeId: 'thunder-stone' },
  { from: 133, to: 136, minLevel: 15, stoneTypeId: 'fire-stone' },
];
const OUR_STONES = new Set(['thunder-stone', 'water-stone', 'fire-stone']);
const seenEdge = new Set(HAND_TUNED_EVOS.map((e) => `${e.from}-${e.to}`));
const evoRules = [...HAND_TUNED_EVOS];
const evoReport = { skipped: [], fallbackLevel: [] };
for (const [url, edges] of Object.entries(data.chains)) {
  for (const e of edges) {
    if (!e.fromId || !e.toId || e.fromId > 386 || e.toId > 386) continue;
    const key = `${e.fromId}-${e.toId}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    let minLevel = e.minLevel;
    if (!minLevel) {
      if (e.trigger === 'trade') minLevel = 30;
      else if (e.item) minLevel = 20; // 石头/道具进化（本作只有三种石头可用）
      else minLevel = 30; // 亲密度/时间等非等级进化：保守默认
      evoReport.fallbackLevel.push(`${e.fromId}->${e.toId}(${e.trigger}${e.item ? ':' + e.item : ''})=${minLevel}`);
    }
    const rule = { from: e.fromId, to: e.toId, minLevel };
    if (e.item && OUR_STONES.has(e.item)) rule.stoneTypeId = e.item;
    evoRules.push(rule);
  }
}
evoRules.sort((a, b) => (a.from - b.from) || (a.to - b.to) || (a.minLevel - b.minLevel));
const evoLines = evoRules.map((r) => `  { from: ${r.from}, to: ${r.to}, minLevel: ${r.minLevel}${r.stoneTypeId ? `, stoneTypeId: '${r.stoneTypeId}'` : ''} },`);

/* ---------------- 输出 species.data.ts ---------------- */
const out = `import { PokeType } from './type-chart';

export interface BaseStats {
  hp: number;
  atk: number;
  def: number;
  spatk: number;
  spdef: number;
  speed: number;
}

export interface SpeciesDef {
  id: number;
  name: string;
  nameZh: string;
  type: PokeType;
  base: BaseStats;
  ability: string;
  defaultMoves: string[];
  /**
   * 官方种族捕获率（第三世代起，3–255；越大越好抓），见 docs/backend-api.md §2 捕捉公式。
   * 捕捉概率 p = min(1, a/255)，a = ((3*maxHP - 2*curHP) * catchRate * ballBonus) / (3*maxHP)。
   */
  catchRate: number;
  spriteUri: string;
  /** false for legendary/mythical species and evolution-only entries (not in the wild table) */
  inWild: boolean;
}

const S = (
  id: number,
  name: string,
  nameZh: string,
  type: PokeType,
  base: BaseStats,
  ability: string,
  defaultMoves: string[],
  catchRate: number,
  inWild = true,
): SpeciesDef => ({
  id,
  name,
  nameZh,
  type,
  base,
  ability,
  defaultMoves,
  catchRate,
  spriteUri: \`minio://assets/sprites/\${id}.png\`,
  inWild,
});

/**
 * 全国图鉴 #1–386（第三世代全量）。前 12 条为手调条目（原样保留），其余由 PokeAPI
 * 生成：种族值/捕获率/特性取自 /pokemon 与 /pokemon-species，type 取第一属性，
 * defaultMoves 按属性匹配 4 个（生成口径见 backend/README.md「图鉴数据」）。
 */
export const SPECIES: Record<number, SpeciesDef> = Object.fromEntries(
  [
${HAND_TUNED_BLOCK}
${generatedLines.join('\n')}
  ].map((s) => [s.id, s]),
);

/** Wild encounter table: every non-legendary/mythical species (except the hand-tuned evolution-only entries). */
export const WILD_TABLE: SpeciesDef[] = Object.values(SPECIES).filter((s) => s.inWild);

export function getSpecies(id: number): SpeciesDef | undefined {
  return SPECIES[id];
}

/** Evolution rules: min level and (optionally) a required evolution stone item. */
export interface EvolutionRule {
  from: number;
  to: number;
  minLevel: number;
  stoneTypeId?: string;
}

export const EVOLUTIONS: EvolutionRule[] = [
${evoLines.join('\n')}
];
`;
writeFileSync('/tmp/out/species.data.ts', out);

/* ---------------- 输出 locales 片段 ---------------- */
const chunk = (arr, n) => arr.reduce((acc, x, i) => (i % n ? acc[acc.length - 1].push(x) : acc.push([x]), acc), []);
const gen = entries.filter((e) => e.id > 151);
const zhPoke = chunk(gen.map((e) => `${e.id}: '${e.nameZh}',`), 6).map((line) => `    ${line.join(' ')}`).join('\n');
const enPoke = chunk(gen.map((e) => `${e.id}: '${data.species[e.id].en.replace(/'/g, "\\'")}',`), 6).map((line) => `    ${line.join(' ')}`).join('\n');
writeFileSync('/tmp/out/zh-pokemon.txt', zhPoke);
writeFileSync('/tmp/out/en-pokemon.txt', enPoke);

const NEW_MOVES = ['absorb', 'giga-drain', 'leaf-blade', 'blaze-kick', 'dragon-claw', 'dragon-breath', 'fly', 'ice-beam', 'earthquake', 'shadow-ball', 'silver-wind', 'brick-break', 'iron-tail', 'sludge-bomb', 'poison-sting', 'rock-slide'];
const PURE = '纯伤害技能，没有追加效果。';
const MOVE_EFFECTS = {
  absorb: ['造成伤害，按伤害的 50% 回复自身 HP。', "{ kind: 'drain', ratio: 0.5 }"],
  'giga-drain': ['造成伤害，按伤害的 50% 回复自身 HP。', "{ kind: 'drain', ratio: 0.5 }"],
  'leaf-blade': ['纯伤害技能（简化引擎不模拟易击中要害）。', 'null'],
  'blaze-kick': ['造成伤害，10% 几率使目标灼伤。', "{ kind: 'status', status: 'brn', chance: 10 }"],
  'dragon-claw': [PURE, 'null'],
  'dragon-breath': ['造成伤害，30% 几率使目标麻痹。', "{ kind: 'status', status: 'par', chance: 30 }"],
  fly: ['高威力纯伤害技能（简化引擎不模拟蓄力飞行）。', 'null'],
  'ice-beam': ['纯伤害技能（简化引擎不模拟冰冻）。', 'null'],
  earthquake: ['高威力纯伤害技能。', 'null'],
  'shadow-ball': ['造成伤害，20% 几率使目标特防 -1。', "{ kind: 'stat', stat: 'spdef', stages: -1, target: 'foe', chance: 20 }"],
  'silver-wind': ['纯伤害技能（简化引擎不模拟全能力提升）。', 'null'],
  'brick-break': [PURE, 'null'],
  'iron-tail': ['造成伤害，30% 几率使目标防御 -1。', "{ kind: 'stat', stat: 'def', stages: -1, target: 'foe', chance: 30 }"],
  'sludge-bomb': ['造成伤害，30% 几率使目标中毒。', "{ kind: 'status', status: 'psn', chance: 30 }"],
  'poison-sting': ['造成伤害，30% 几率使目标中毒。', "{ kind: 'status', status: 'psn', chance: 30 }"],
  'rock-slide': ['纯伤害技能（简化引擎不模拟畏缩）。', 'null'],
};
const moveRows = NEW_MOVES.map((id) => {
  const m = moveMeta[id];
  const [effectText, effect] = MOVE_EFFECTS[id];
  return `      ['${id}', '${m.en}', '${m.type}', ${m.power}, ${m.accuracy}, '${m.damageClass === 'physical' ? 'physical' : 'special'}', '${effectText}', ${effect}],`;
});
writeFileSync('/tmp/out/moves-rows.txt', moveRows.join('\n'));
const zhMoves = NEW_MOVES.map((id) => `    '${id}': '${moveMeta[id].zhHans}',`).join('\n');
const enMoves = NEW_MOVES.map((id) => `    '${id}': '${moveMeta[id].en.replace(/'/g, "\\'")}',`).join('\n');
writeFileSync('/tmp/out/zh-moves.txt', zhMoves);
writeFileSync('/tmp/out/en-moves.txt', enMoves);
writeFileSync('/tmp/out/cry-ids.txt', JSON.stringify(wildIds));

/* ---------------- 报告 ---------------- */
const typeCount = {};
for (const e of entries) typeCount[e.type] = (typeCount[e.type] ?? 0) + 1;
console.log(`species: ${entries.length}，野生池: ${wildIds.length}，传说/幻之: ${legendaries.length}（${legendaries.join(',')}）`);
console.log('属性分布:', JSON.stringify(typeCount));
console.log(`进化规则: ${evoRules.length}（生成 ${evoRules.length - 4}）`);
console.log(`非等级进化默认 minLevel: ${evoReport.fallbackLevel.length} 条`);
console.log('默认 minLevel 明细:', evoReport.fallbackLevel.join(' '));
console.log('新技能:', NEW_MOVES.join(', '));
console.log('抽查中文名:', [152, 155, 158, 172, 196, 197, 212, 230, 241, 248, 249, 250, 251, 252, 255, 258, 282, 306, 350, 359, 380, 384, 386].map((id) => `${id}=${entries[id - 1].nameZh}`).join(' '));
