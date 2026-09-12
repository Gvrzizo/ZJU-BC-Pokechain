/**
 * 生成 src/game-data/learnsets.data.ts（升级学习表，#1–386 全量）。
 *
 * 用法：node tools/gen-learnsets.mjs
 * 输入全部来自仓库内的静态数据（不改文件、不联网）：
 *   - src/game-data/species.data.ts 的 S(...) 行（id / type / defaultMoves）
 *   - src/game-data/species.data.ts 的 EVOLUTIONS（进化边，用于算进化阶段与"最终形态"）
 *   - src/game-data/moves.data.ts 的 MoveRow 行（id / type / power）
 * 因此脚本是**确定性纯函数**：同一份输入永远生成同一份输出（不需要时间戳，重跑无 diff）。
 *
 * 设计口径（docs/backend-api.md §2「升级学习表」）：
 *   1. 进化阶段 stage：沿 EVOLUTIONS 的 from→to 边回溯，无入边 = 0；一段进化 = 1；两段 = 2。
 *      stage 只影响等级偏移（见 4），保证"同一条技能在进化型身上更晚出现"。
 *   2. 技能池按优先级拼装（去重，保序）：
 *        本系 STAB（type === 主属性，按 威力/命中/id 升序，最多 6 条）
 *      → 副属性池（**仅最终形态**：stage ≥ 1 且没有出边；主属性映射一个代表性副属性，
 *        如 火→飞行 让喷火龙在 Lv36 学 wing-attack、草→毒 让妙蛙花补 sludge-bomb；
 *        本作是单属性模型，这一层是"进化后解锁招牌副属性招"的简化口径）
 *      → 该种族 defaultMoves 里剩下的招牌技能（species.data 现有 4 招，可能跨属性，
 *        如卡比兽的 crunch、拉普拉斯的 ice-beam——保证"从该种族技能池扩充"）
 *      → 一般属性技能（低威力在前，兜底补齐）
 *   3. 条数 K = clamp(上述前三层的去重条数, 4, 8)。
 *   4. 等级 = 威力梯度 + 进化阶段偏移：
 *        威力 ≤ 40 → Lv1（最弱的起手招）
 *        levelOfPower(power) = 1 + floor((power − 40) × 39 / 70)   // 威力 110 → Lv40、120 → Lv45、150 → Lv62
 *        最终等级 = clamp(1, 100, levelOfPower(power) + 12 × stage)
 *      —— 例：小火龙 ember(Lv1) → fire-fang(Lv14) → flamethrower(Lv28) → fire-blast(Lv40)；
 *         火恐龙整体 +12；喷火龙整体 +24 且多出 wing-attack(Lv36) / fly(Lv53)。
 *   5. 同一学习表内等级严格递增：按（等级、本系优先、威力、id）排序后逐条 max(level, 上一条+1)，
 *      避免"同一级学两招"的展示歧义（学习逻辑本身对同级多招也安全）。
 *
 * 升级时如何用这张表：见 backend/src/pokemon/learnset.ts（跨阈值学习 + 满 4 招替换最早学的）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SRC = `${REPO}backend/src/game-data`;
const OUT = `${SRC}/learnsets.data.ts`;

const MIN_ENTRIES = 4;
const MAX_ENTRIES = 8;
const MAX_STAB = 6;
const STAGE_OFFSET = 12;
const POWER_BASE = 40;
const POWER_SPAN = 70;
const POWER_TOP_LEVEL = 40;

/** 最终形态解锁的副属性池（单属性模型下的简化映射，见文件头 2.） */
const SECONDARY_TYPE = {
  normal: 'flying',
  fire: 'flying',
  water: 'ice',
  electric: 'steel',
  grass: 'poison',
  ice: 'water',
  fighting: 'rock',
  poison: 'bug',
  ground: 'rock',
  flying: 'normal',
  psychic: 'ghost',
  bug: 'flying',
  rock: 'ground',
  ghost: 'dark',
  dragon: 'flying',
  dark: 'ghost',
  steel: 'ground',
};

/* ---------------- 解析仓库内的静态数据 ---------------- */

const speciesSrc = readFileSync(`${SRC}/species.data.ts`, 'utf8');
const movesSrc = readFileSync(`${SRC}/moves.data.ts`, 'utf8');

const SPECIES = [];
for (const m of speciesSrc.matchAll(
  /^\s*S\((\d+),\s*'([^']+)',\s*'([^']+)',\s*'(\w+)',\s*\{[^}]*\},\s*'[^']*',\s*\[([^\]]*)\]/gm,
)) {
  SPECIES.push({
    id: Number(m[1]),
    name: m[2],
    type: m[4],
    defaultMoves: m[5].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean),
  });
}
if (SPECIES.length !== 386) throw new Error(`species 解析失败：期望 386 条，得到 ${SPECIES.length}`);

const MOVES = [];
for (const m of movesSrc.matchAll(
  /\[\s*'([a-z0-9-]+)',\s*'[^']*',\s*'(\w+)',\s*(\d+),\s*(\d+),\s*'(?:physical|special)'/g,
)) {
  MOVES.push({ id: m[1], type: m[2], power: Number(m[3]), accuracy: Number(m[4]), idx: MOVES.length });
}
if (MOVES.length !== 43) throw new Error(`moves 解析失败：期望 43 条，得到 ${MOVES.length}`);
const MOVE_BY_ID = Object.fromEntries(MOVES.map((m) => [m.id, m]));

const EVOLUTIONS = [];
for (const m of speciesSrc.matchAll(
  /\{\s*from:\s*(\d+),\s*to:\s*(\d+),\s*minLevel:\s*(\d+)(?:,\s*stoneTypeId:\s*'([\w-]+)')?\s*\}/g,
)) {
  EVOLUTIONS.push({ from: Number(m[1]), to: Number(m[2]), minLevel: Number(m[3]), stoneTypeId: m[4] });
}
if (EVOLUTIONS.length === 0) throw new Error('EVOLUTIONS 解析失败');

/* ---------------- 生成 ---------------- */

const incoming = new Map();
for (const e of EVOLUTIONS) {
  if (!incoming.has(e.to)) incoming.set(e.to, e.from);
}
const hasOutgoing = new Set(EVOLUTIONS.map((e) => e.from));

/** 进化阶段：0 = 基础形态，1 = 一段进化，2 = 二段进化 */
function stageOf(id) {
  let stage = 0;
  let cur = id;
  while (incoming.has(cur) && stage < 3) {
    cur = incoming.get(cur);
    stage += 1;
  }
  return stage;
}

/** 同级技能按威力、命中、声明顺序排序（tackle 先于 quick-attack：moves.data 的声明顺序即官方手感） */
const byPower = (a, b) => a.power - b.power || a.accuracy - b.accuracy || a.idx - b.idx;
const movesOfType = (type) => MOVES.filter((m) => m.type === type).sort(byPower);

/** 威力 → 基础等级（威力 40 及以下 Lv1，110 → Lv40） */
function levelOfPower(power) {
  return Math.max(1, 1 + Math.floor(((power - POWER_BASE) * (POWER_TOP_LEVEL - 1)) / POWER_SPAN));
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function learnsetFor(species) {
  const stage = stageOf(species.id);
  const isFinalForm = stage >= 1 && !hasOutgoing.has(species.id);
  const stab = movesOfType(species.type).slice(0, MAX_STAB);
  const secondary = isFinalForm ? movesOfType(SECONDARY_TYPE[species.type]).slice(0, 2) : [];
  const signature = species.defaultMoves.map((id) => MOVE_BY_ID[id]).filter(Boolean);
  const normal = movesOfType('normal');

  const target = clamp(
    new Set([...stab, ...secondary, ...signature].map((m) => m.id)).size,
    MIN_ENTRIES,
    MAX_ENTRIES,
  );
  const pool = [];
  const seen = new Set();
  for (const move of [...stab, ...secondary, ...signature, ...normal]) {
    if (seen.has(move.id) || pool.length >= target) continue;
    seen.add(move.id);
    pool.push({ ...move, stab: move.type === species.type });
  }
  if (pool.length < MIN_ENTRIES) throw new Error(`#${species.id} 技能池不足 ${MIN_ENTRIES} 条`);

  const sorted = pool
    .map((m) => ({ ...m, level: clamp(1, 100, levelOfPower(m.power) + STAGE_OFFSET * stage) }))
    .sort((a, b) => a.level - b.level || Number(b.stab) - Number(a.stab) || a.power - b.power || a.idx - b.idx);

  const entries = [];
  for (const move of sorted) {
    const level = Math.min(100, Math.max(move.level, entries.length ? entries[entries.length - 1].level + 1 : 1));
    entries.push({ level, moveId: move.id });
  }
  return entries;
}

const byId = [...SPECIES].sort((a, b) => a.id - b.id);
const lines = byId.map((species) => {
  const entries = learnsetFor(species);
  const body = entries.map((e) => `{ level: ${e.level}, moveId: '${e.moveId}' }`).join(', ');
  return `  ${species.id}: [${body}],`;
});

const header = `/**
 * 升级学习表：#1–386 全量（自动生成，勿手改）。
 *
 * 重新生成：\`node tools/gen-learnsets.mjs\`（确定性：输入是仓库内静态数据，重跑无 diff）。
 * 算法与口径（STAB 优先、威力梯度、进化阶段偏移、最终形态副属性池）见脚本头注释与
 * docs/backend-api.md §2「升级学习表」；升级/进化时的学习与替换规则见 src/pokemon/learnset.ts。
 */

export interface LearnsetEntry {
  /** 学习等级（1-100，同一学习表内严格递增） */
  level: number;
  moveId: string;
}

/** speciesId → 按等级升序的学习记录（每个种族 4-8 条） */
export const LEARNSETS: Record<number, LearnsetEntry[]> = {
`;

const footer = `};

/** 该种族的学习表（未收录返回空数组，调用方按"无表可学"处理）。 */
export function getLearnset(speciesId: number): LearnsetEntry[] {
  return LEARNSETS[speciesId] ?? [];
}
`;

writeFileSync(OUT, `${header}${lines.join('\n')}\n${footer}`);
const counts = lines.map((l, i) => learnsetFor(byId[i]).length);
console.log(
  `[gen-learnsets] ${lines.length} 个种族 → ${OUT}（每条 ${Math.min(...counts)}-${Math.max(...counts)} 条学习记录）`,
);
