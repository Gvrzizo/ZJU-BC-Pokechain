import type Redis from 'ioredis';

/** Delta computed by MockChainAdapter during one transaction. */
export interface MockChainDelta {
  state: { set: Map<string, string>; del: string[] };
  idem: { set: Map<string, string>; del: string[] };
  // --- [FEAT:history] begin ---
  /** 键历史：field = 状态键，value = 该键全部版本的 JSON 数组。 */
  history: { set: Map<string, string> };
  // --- [FEAT:history] end ---
}

export interface MockChainSnapshot {
  state: Map<string, string>;
  idem: Map<string, string>;
  // --- [FEAT:history] begin ---
  history: Map<string, string>;
  // --- [FEAT:history] end ---
}

/**
 * Shared storage for the mock world state. Keeping it process-local made the
 * seed process invisible to the API process (and to every later rerun), so the
 * demo accounts ended up with no items/pokemon. With a store the mock chain is
 * shared through Redis exactly like a real ledger would be.
 */
export interface MockChainStore {
  load(): Promise<MockChainSnapshot>;
  apply(delta: MockChainDelta): Promise<void>;
  clear(): Promise<void>;
}

export const MOCK_CHAIN_PREFIX = 'mockchain:';

/** Redis-backed store: one hash field per state key (prefix `mockchain:`). */
export class RedisMockChainStore implements MockChainStore {
  private readonly stateKey = `${MOCK_CHAIN_PREFIX}state`;
  private readonly idemKey = `${MOCK_CHAIN_PREFIX}idem`;
  // --- [FEAT:history] begin ---
  private readonly historyKey = `${MOCK_CHAIN_PREFIX}hist`;
  // --- [FEAT:history] end ---

  constructor(private readonly client: Redis) {}

  async load(): Promise<MockChainSnapshot> {
    const [state, idem, history] = await Promise.all([
      this.client.hgetall(this.stateKey),
      this.client.hgetall(this.idemKey),
      // --- [FEAT:history] begin ---
      this.client.hgetall(this.historyKey),
      // --- [FEAT:history] end ---
    ]);
    return {
      state: new Map(Object.entries(state)),
      idem: new Map(Object.entries(idem)),
      // --- [FEAT:history] begin ---
      history: new Map(Object.entries(history ?? {})),
      // --- [FEAT:history] end ---
    };
  }

  async apply(delta: MockChainDelta): Promise<void> {
    const pipeline = this.client.multi();
    for (const [field, value] of delta.state.set) pipeline.hset(this.stateKey, field, value);
    if (delta.state.del.length > 0) pipeline.hdel(this.stateKey, ...delta.state.del);
    for (const [field, value] of delta.idem.set) pipeline.hset(this.idemKey, field, value);
    if (delta.idem.del.length > 0) pipeline.hdel(this.idemKey, ...delta.idem.del);
    // --- [FEAT:history] begin ---
    for (const [field, value] of delta.history.set) pipeline.hset(this.historyKey, field, value);
    // --- [FEAT:history] end ---
    await pipeline.exec();
  }

  async clear(): Promise<void> {
    // --- [FEAT:history] begin ---
    await this.client.del(this.stateKey, this.idemKey, this.historyKey);
    // --- [FEAT:history] end ---
  }
}
