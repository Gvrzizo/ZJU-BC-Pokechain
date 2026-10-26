import { Context } from 'fabric-contract-api';
import { createHash } from 'node:crypto';
import { normalizeWagerInput } from '../../src/common/bundle';
import { canonicalJson, sha256hex } from '../../src/common/crypto';
import { BattleContract, wagerHashOf } from '../../src/contracts/battle.contract';
// --- [FEAT:breeding] begin ---
import { BreedingContract } from '../../src/contracts/breeding.contract';
// --- [FEAT:breeding] end ---
import { HistoryContract } from '../../src/contracts/history.contract';
import { ItemContract } from '../../src/contracts/item.contract';
import { PlayerContract } from '../../src/contracts/player.contract';
import { PokemonContract } from '../../src/contracts/pokemon.contract';
import { RandomContract } from '../../src/contracts/random.contract';
import { TradeContract } from '../../src/contracts/trade.contract';
import { WagerInput } from '../../src/common/model';

export const ORG1 = 'Org1MSP';
export const ORG2 = 'Org2MSP';

export const T1 = '2026-01-01T00:00:00.000Z';
export const T2 = '2026-01-01T01:00:00.000Z';
export const T3 = '2026-01-01T02:00:00.000Z';
export const T4 = '2026-01-01T03:00:00.000Z';
export const EXPIRES = '2026-01-02T00:00:00.000Z';

export const SERVER_SEED = 'aa11bb22cc33dd44ee55ff660011223344556677889900aabbccddeeff00112233';
export const CLIENT_SEED = 'c1e27a8b9d0ef123c1e27a8b9d0ef123';

export function hash(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export const IVS_JSON = JSON.stringify({ hp: 10, atk: 12, def: 8, spatk: 15, spdef: 14, speed: 20 });
export const MOVES_JSON = JSON.stringify(['thunder-shock', 'growl']);

// --- [FEAT:history] begin ---
interface MockVersion {
  txId: string;
  seconds: number;
  isDelete: boolean;
  value: Buffer;
}
// --- [FEAT:history] end ---

function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function matchSelector(selector: Record<string, unknown>, doc: Record<string, unknown>): boolean {
  return Object.entries(selector).every(([key, cond]) => {
    if (key === '$or') {
      return (cond as Record<string, unknown>[]).some((sub) => matchSelector(sub, doc));
    }
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      return deepEqual(doc[key], cond);
    }
    return doc[key] === cond;
  });
}

/**
 * 最小 ChaincodeStub mock：世界状态 + 事务写缓存。
 * 与真实 Fabric 一致：交易抛错时全部写操作回滚，事件一并丢弃。
 * （@theledger/fabric-mock-stub 依赖 fabric-shim ^1.4 / TS3，与本工程 fabric 2.5 栈不兼容，故手写。）
 */
export class MockStub {
  private state = new Map<string, Buffer>();
  private tx: Map<string, Buffer | null> | null = null;
  /** 当前交易内的事件（回滚即丢弃）。 */
  public events: Array<{ name: string; payload: string }> = [];
  /** 所有已提交交易的事件历史。 */
  public committedEvents: Array<{ name: string; payload: string }> = [];
  private txCounter = 0;
  // --- [FEAT:history] begin ---
  /** 已提交的键版本（仅测试用：Fabric 的 historydb 由 peer 维护，这里手工记一份）。 */
  private versions = new Map<string, MockVersion[]>();
  private currentTxId = '';
  private currentTxMs = 0;
  private histCounter = 0;
  // --- [FEAT:history] end ---

  beginTx(): void {
    this.tx = new Map();
    this.events = [];
    // --- [FEAT:history] begin ---
    this.histCounter += 1;
    this.currentTxId = `mock-tx-${this.histCounter}`;
    this.currentTxMs = 1767225600000 + this.histCounter * 1000; // 2026-01-01T00:00:00Z 起每条 +1s
    // --- [FEAT:history] end ---
  }

  commitTx(): void {
    if (!this.tx) return;
    for (const [k, v] of this.tx) {
      if (v === null) this.state.delete(k);
      else this.state.set(k, v);
      // --- [FEAT:history] begin ---
      const list = this.versions.get(k) ?? [];
      list.push({ txId: this.currentTxId, seconds: Math.floor(this.currentTxMs / 1000), isDelete: v === null, value: v ?? Buffer.alloc(0) });
      this.versions.set(k, list);
      // --- [FEAT:history] end ---
    }
    this.committedEvents.push(...this.events);
    this.tx = null;
  }

  rollbackTx(): void {
    this.tx = null;
    this.events = [];
  }

  async getState(key: string): Promise<Buffer> {
    if (this.tx && this.tx.has(key)) {
      const v = this.tx.get(key);
      return v ? Buffer.from(v) : Buffer.alloc(0);
    }
    const v = this.state.get(key);
    return v ? Buffer.from(v) : Buffer.alloc(0);
  }

  async putState(key: string, value: Buffer | Uint8Array): Promise<void> {
    if (!this.tx) throw new Error('mock: no active transaction');
    this.tx.set(key, Buffer.from(value));
  }

  async deleteState(key: string): Promise<void> {
    if (!this.tx) throw new Error('mock: no active transaction');
    this.tx.set(key, null);
  }

  // --- [FEAT:history] begin ---
  /** 与 fabric-shim 的 getHistoryForKey 同形：按提交顺序（旧→新）返回该键的每个版本。 */
  async getHistoryForKey(key: string): Promise<{
    next: () => Promise<{
      value: { txId: string; timestamp: { seconds: { toString: () => string }; nanos: number }; isDelete: boolean; value: Buffer };
      done: boolean;
    }>;
    close: () => Promise<void>;
  }> {
    const list = this.versions.get(key) ?? [];
    let index = 0;
    return {
      next: async () => {
        if (index >= list.length) return { done: true } as never;
        const version = list[index++];
        return {
          value: {
            txId: version.txId,
            timestamp: { seconds: { toString: () => String(version.seconds) }, nanos: 0 },
            isDelete: version.isDelete,
            value: Buffer.from(version.value),
          },
          done: false,
        };
      },
      close: async () => undefined,
    };
  }
  // --- [FEAT:history] end ---

  setEvent(name: string, payload: Buffer | Uint8Array): void {
    this.events.push({ name, payload: Buffer.from(payload).toString('utf8') });
  }

  async getQueryResult(query: string): Promise<{
    next: () => Promise<{ value?: { key: string; value: Buffer }; done: boolean }>;
    close: () => Promise<void>;
  }> {
    const parsed = JSON.parse(query) as { selector?: Record<string, unknown> };
    const selector = parsed.selector ?? (parsed as Record<string, unknown>);
    const merged = new Map<string, Buffer>(this.state);
    if (this.tx) {
      for (const [k, v] of this.tx) {
        if (v === null) merged.delete(k);
        else merged.set(k, v);
      }
    }
    const hits: Array<{ key: string; value: Buffer }> = [];
    for (const [k, v] of [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      try {
        const doc = JSON.parse(v.toString()) as Record<string, unknown>;
        if (matchSelector(selector, doc)) hits.push({ key: k, value: v });
      } catch {
        // 非 JSON 数据不参与富查询
      }
    }
    let idx = 0;
    return {
      next: async () =>
        idx < hits.length ? { value: hits[idx++], done: false } : { done: true },
      close: async () => undefined,
    };
  }

  getTxID(): string {
    return `mock-tx-${++this.txCounter}`;
  }

  getChannelID(): string {
    return 'gamechannel';
  }
}

/**
 * 构造链码 Context。`enrollmentId` 写入 CID attr `hf.EnrollmentID`（CA 会自动写入该属性）；
 * 不传则证书不含该属性——用于验证"缺属性即拒绝"。
 */
export function makeCtx(stub: MockStub, mspId: string, role?: string, enrollmentId?: string): Context {
  const ctx = new Context();
  ctx.stub = stub as unknown as Context['stub'];
  const attrs: Record<string, string> = role ? { role } : {};
  if (enrollmentId !== undefined) attrs['hf.EnrollmentID'] = enrollmentId;
  ctx.clientIdentity = {
    getMSPID: () => mspId,
    getAttributeValue: (name: string) => (name in attrs ? attrs[name] : null),
    getAttributeNames: () => Object.keys(attrs),
    assertAttributeValue: (name: string, value: string) => attrs[name] === value,
    getID: () => `x509::mock::${mspId}::${enrollmentId ?? ''}`,
    getIDBytes: () => Buffer.from(mspId),
  } as unknown as Context['clientIdentity'];
  return ctx;
}

/** 以事务语义执行一次链码调用：成功提交、抛错回滚。 */
export async function invoke<T>(stub: MockStub, fn: () => Promise<T>): Promise<T> {
  stub.beginTx();
  try {
    const result = await fn();
    stub.commitTx();
    return result;
  } catch (e) {
    stub.rollbackTx();
    throw e;
  }
}

export class World {
  readonly stub = new MockStub();
  readonly player = new PlayerContract();
  readonly random = new RandomContract();
  readonly pokemon = new PokemonContract();
  readonly item = new ItemContract();
  readonly trade = new TradeContract();
  readonly battle = new BattleContract();
  // --- [FEAT:history] begin ---
  readonly history = new HistoryContract();
  // --- [FEAT:history] end ---
  // --- [FEAT:breeding] begin ---
  readonly breeding = new BreedingContract();
  // --- [FEAT:breeding] end ---

  /** 低层身份：显式 mspId/role/enrollmentId（enrollmentId 省略 = 证书无该属性）。 */
  ctx(mspId: string, role?: string, enrollmentId?: string): Context {
    return makeCtx(this.stub, mspId, role, enrollmentId);
  }

  /** 玩家本人证书（player role，hf.EnrollmentID=playerId）。 */
  ctxAs(playerId: string, mspId = ORG1): Context {
    return makeCtx(this.stub, mspId, 'player', playerId);
  }

  adminCtx(): Context {
    return this.ctx(ORG1, 'admin', 'admin');
  }

  systemCtx(): Context {
    return this.ctx(ORG1, 'system', 'system');
  }

  arbitratorCtx(): Context {
    return this.ctx(ORG2, 'arbitrator', 'arbiter');
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    return invoke(this.stub, fn);
  }

  /**
   * 注册玩家：链上 RegisterPlayer 仅 admin/system（后端注册用 ADMIN_IDENTITY），故以 admin 身份代发。
   * 测试基线：注册后补到 1000P 并解除 72h 转账锁（H10）——battle/trade 用例关注业务语义，
   * 专项用例直接调用 RegisterPlayer 断言 400P/锁定/ClearTransferLock。
   */
  async registerPlayer(playerId: string, mspId: string, now = T1): Promise<void> {
    await this.run(() =>
      this.player.RegisterPlayer(this.ctx(mspId, 'admin', 'admin'), playerId, `nick-${playerId}`, now, `idem-reg-${playerId}`),
    );
    const current = (await this.getPlayer(playerId)).points;
    if (current !== 1000) {
      await this.run(() =>
        this.player.AddPoints(this.systemCtx(), playerId, String(1000 - current), 'test-topup', now, `idem-topup-${playerId}`),
      );
    }
    await this.run(() => this.player.ClearTransferLock(this.adminCtx(), playerId, now, `idem-unlock-${playerId}`));
  }

  async mintItem(id: string, ownerId: string, quantity: number, now = T1, typeId = 'poke-ball'): Promise<void> {
    await this.run(() =>
      this.item.MintItem(this.systemCtx(), id, ownerId, typeId, String(quantity), `minio://assets/items/${typeId}.png`, hash(`meta-${id}`), now, `idem-mintitem-${id}`),
    );
  }

  /** 完整捕捉随机流程：Commit → RevealAndVerify。 */
  async commitReveal(eventId: string, purpose: string, playerId: string, now = T1): Promise<void> {
    await this.run(() =>
      this.random.Commit(this.systemCtx(), eventId, purpose, playerId, sha256hex(SERVER_SEED), CLIENT_SEED, now, `idem-commit-${eventId}`),
    );
    await this.run(() =>
      this.random.RevealAndVerify(this.systemCtx(), eventId, SERVER_SEED, now, `idem-reveal-${eventId}`),
    );
  }

  /** 完整捕捉铸宝可梦：Commit → RevealAndVerify → MintFromCapture。 */
  async capturePokemon(id: string, ownerId: string, now = T2): Promise<void> {
    const eventId = `ev_${id}`;
    await this.commitReveal(eventId, 'capture', ownerId, T1);
    await this.run(() =>
      this.pokemon.MintFromCapture(
        this.systemCtx(),
        id,
        ownerId,
        '25',
        '皮卡丘',
        IVS_JSON,
        'hardy',
        'static',
        'false',
        MOVES_JSON,
        hash(`dna-${id}`),
        eventId,
        now,
        `idem-mint-${id}`,
      ),
    );
  }

  /** 双人对战创建所需 wagerHash 计算（与链上一致：先按 parseWagerBundle 规则归一）。 */
  wagerHash(playerA: string, playerB: string, wagerA: WagerInput, wagerB: WagerInput): string {
    return wagerHashOf(
      playerA,
      playerB,
      normalizeWagerInput(wagerA, 'wagerA'),
      normalizeWagerInput(wagerB, 'wagerB'),
    );
  }

  async getPlayer(playerId: string) {
    return JSON.parse(await this.run(() => this.player.GetPlayer(this.systemCtx(), playerId)));
  }

  async getPokemon(id: string) {
    return JSON.parse(await this.run(() => this.pokemon.GetPokemon(this.systemCtx(), id)));
  }

  async getItem(id: string) {
    return JSON.parse(await this.run(() => this.item.GetItem(this.systemCtx(), id)));
  }

  async getTrade(id: string) {
    return JSON.parse(await this.run(() => this.trade.GetTrade(this.systemCtx(), id)));
  }

  async getBattle(id: string) {
    return JSON.parse(await this.run(() => this.battle.GetBattle(this.systemCtx(), id)));
  }

  async getRand(eventId: string) {
    return JSON.parse(await this.run(() => this.random.GetRandom(this.systemCtx(), eventId)));
  }

  // --- [FEAT:history] begin ---
  async getHistory(
    pokemonId: string,
    max?: number,
  ): Promise<{
    summary: { firstOwner: string; currentOwner: string; transfers: number; versions: number; truncated: boolean };
    entries: Array<Record<string, unknown>>;
  }> {
    return JSON.parse(
      await this.run(() => this.history.GetPokemonHistory(this.systemCtx(), pokemonId, max === undefined ? undefined : String(max))),
    );
  }
  // --- [FEAT:history] end ---

  eventNames(): string[] {
    return this.stub.committedEvents.map((e) => e.name);
  }
}

/** 断言 Promise 以 `CODE: ` 前缀抛错（错误格式 CODE: message）。 */
export async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toThrow(new RegExp(`^${code}: `));
}
