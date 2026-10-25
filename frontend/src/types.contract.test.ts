import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 类型漂移检查（P2-2 4a）：直接读链上状态定义，确保前端展示类型没有漏字段。
 *
 * 纯本地文件解析，不需要网络/后端进程；链码或后端给 `PlayerState`/`PokemonState`/`ItemState`
 * 新增字段而前端 `User`/`Pokemon`/`Item` 没跟上时失败，并列出缺失字段名。
 * 链上内部字段（`docType`/`mspId` 等）不是 API 契约，显式登记在 `allowlist` 里。
 */
const CHAIN_TYPES_PATH = new URL('../../backend/src/fabric/chain.types.ts', import.meta.url);
const FRONTEND_TYPES_PATH = new URL('./types.ts', import.meta.url);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
}

/** `openIndex` 指向 `{`，返回配对 `}` 之间的正文 */
function balancedBody(text: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  throw new Error(`大括号不配对（offset ${openIndex}）`);
}

/** 顶层（忽略对象/泛型/括号内）的第一个冒号位置；用于把 `字段名?: 类型` 拆开 */
function topLevelColon(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{' || ch === '[' || ch === '(' || ch === '<') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')' || ch === '>') depth = Math.max(0, depth - 1);
    else if (ch === "'" || ch === '"') {
      for (i += 1; i < text.length && text[i] !== ch; i += 1) {
        /* 跳过字符串字面量类型（联合里的 'IDLE' 等） */
      }
    } else if (ch === ':' && depth === 0) return i;
  }
  return -1;
}

/** 接口正文 → 字段名（跳过方法/索引签名，容忍多行类型与嵌套大括号） */
function memberNames(body: string): string[] {
  const members: string[] = [];
  let current = '';
  let depth = 0;
  const flush = () => {
    if (current.trim()) members.push(current.trim());
    current = '';
  };
  for (const ch of body) {
    if (ch === '{' || ch === '[' || ch === '(' || ch === '<') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')' || ch === '>') depth = Math.max(0, depth - 1);
    if ((ch === ';' || ch === '\n') && depth === 0) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();

  const names: string[] = [];
  for (const raw of members) {
    const member = raw.replace(/^readonly\s+/, '');
    if (!member || member.startsWith('[') || member.startsWith('(')) continue;
    const colon = topLevelColon(member);
    if (colon < 0) continue;
    const name = member
      .slice(0, colon)
      .trim()
      .replace(/\?$/, '')
      .replace(/^['"]|['"]$/g, '')
      .trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
  }
  return names;
}

/** 从源码里抽出所有 `export interface Name { ... }` 的字段名 */
function extractInterfaces(source: string): Map<string, string[]> {
  const text = stripComments(source);
  const found = new Map<string, string[]>();
  const header = /export\s+interface\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+[^{]+)?\s*\{/g;
  for (let match = header.exec(text); match; match = header.exec(text)) {
    const open = match.index + match[0].length - 1;
    found.set(match[1], memberNames(balancedBody(text, open)));
  }
  return found;
}

const chainInterfaces = extractInterfaces(readFileSync(CHAIN_TYPES_PATH, 'utf8'));
const frontendInterfaces = extractInterfaces(readFileSync(FRONTEND_TYPES_PATH, 'utf8'));

interface DriftCase {
  /** 链上/后端状态接口（backend/src/fabric/chain.types.ts） */
  chain: string;
  /** 前端展示接口（frontend/src/types.ts） */
  frontend: string;
  /** 有意不暴露给前端的链上内部字段（新增时在这里显式登记并写原因） */
  allowlist: string[];
  /** 链上字段 → 前端字段的改名映射 */
  aliases?: Record<string, string>;
}

/** 字段漂移：链上字段在前端缺失，以及已经补进前端、应从 allowlist 删除的字段 */
function diffFields(input: {
  chainFields: readonly string[];
  frontendFields: readonly string[];
  allowlist: readonly string[];
  aliases?: Record<string, string>;
}): { missing: string[]; stale: string[] } {
  const allowed = new Set(input.allowlist);
  const frontend = new Set(input.frontendFields);
  const aliases = input.aliases ?? {};
  const missing: string[] = [];
  for (const field of input.chainFields) {
    if (allowed.has(field) || frontend.has(field)) continue;
    const alias = aliases[field];
    if (alias && frontend.has(alias)) continue;
    missing.push(alias ? `${field}（或 ${alias}）` : field);
  }
  return { missing, stale: input.allowlist.filter((field) => frontend.has(field)) };
}

const DRIFT_CASES: DriftCase[] = [
  {
    chain: 'PokemonState',
    frontend: 'Pokemon',
    // docType：链上判别字段，API 不暴露
    allowlist: ['docType'],
  },
  {
    chain: 'ItemState',
    frontend: 'Item',
    // docType：链上判别字段，API 不暴露
    allowlist: ['docType'],
  },
  {
    chain: 'PlayerState',
    frontend: 'User',
    allowlist: [
      'docType', // 链上判别字段
      'mspId', // Fabric 组织身份，仅链码/后端使用
      'rating', // 排位分经 GET /ranked/* 下发，不在 User 上
      'transferLockUntil', // 链上 72h 转账锁，后端只用于拦截，不下发
    ],
    // 链上 playerId 就是注册用户名，API /users/me 以 username 暴露
    aliases: { playerId: 'username' },
  },
];

describe('类型漂移：链上状态 ↔ 前端接口', () => {
  it('解析器能读出链上三个状态接口与对应前端接口', () => {
    const chainTargets = ['PlayerState', 'PokemonState', 'ItemState'] as const;
    for (const name of chainTargets) {
      const fields = chainInterfaces.get(name);
      expect(fields, `backend/src/fabric/chain.types.ts 缺少 ${name}`).toBeTruthy();
      expect(fields!.length, `${name} 没解析出字段`).toBeGreaterThan(3);
    }
    expect(chainInterfaces.get('PokemonState')).toEqual(expect.arrayContaining(['id', 'speciesId', 'ownerId']));
    expect(frontendInterfaces.get('Pokemon')).toEqual(expect.arrayContaining(['id', 'speciesId', 'ownerId']));
    expect(frontendInterfaces.get('Item')).toEqual(expect.arrayContaining(['id', 'typeId', 'ownerId']));
    expect(frontendInterfaces.get('User')).toEqual(expect.arrayContaining(['username', 'nickname', 'points']));
  });

  it('漂移检测本身有效：缺失字段会被列出、过期 allowlist 会被提示', () => {
    expect(
      diffFields({ chainFields: ['id', 'docType', 'rating'], frontendFields: ['id'], allowlist: ['docType'] }),
    ).toEqual({ missing: ['rating'], stale: [] });
    expect(
      diffFields({ chainFields: ['id'], frontendFields: ['id'], allowlist: ['id'] }).stale,
    ).toEqual(['id']);
    expect(
      diffFields({
        chainFields: ['playerId'],
        frontendFields: ['username'],
        allowlist: [],
        aliases: { playerId: 'username' },
      }).missing,
    ).toEqual([]);
  });

  for (const drift of DRIFT_CASES) {
    it(`${drift.chain} 的每个字段都在前端 ${drift.frontend} 中（缺字段会列出来）`, () => {
      const chainFields = chainInterfaces.get(drift.chain);
      const frontendFields = frontendInterfaces.get(drift.frontend);
      expect(chainFields, `链上接口 ${drift.chain} 不存在`).toBeTruthy();
      expect(frontendFields, `前端接口 ${drift.frontend} 不存在`).toBeTruthy();

      const { missing, stale } = diffFields({
        chainFields: chainFields!,
        frontendFields: frontendFields!,
        allowlist: drift.allowlist,
        aliases: drift.aliases,
      });
      expect(
        missing,
        `${drift.chain} 有字段未出现在 ${drift.frontend}：请同步 frontend/src/types.ts，或在 allowlist 登记原因`,
      ).toEqual([]);

      // allowlist 反向校验：字段已经补进前端后就要从白名单删掉，避免以后漂移被静默放过
      expect(stale, `${drift.frontend} 已包含这些字段，请从 allowlist 删除：${stale.join(', ')}`).toEqual([]);
    });
  }
});
