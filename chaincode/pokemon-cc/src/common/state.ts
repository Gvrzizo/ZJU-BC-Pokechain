import { Context } from 'fabric-contract-api';
import { checkedAmount, fail } from './assert';
import { getMspId } from './cid';
import { keyOf } from './keys';
import { Battle, BOND_DEFAULT, Item, Player, Pokemon, RandomCommit, RATING_DEFAULT, Trade, zeroEvs } from './model';

async function load<T>(ctx: Context, docType: string, id: string, notFoundCode: string): Promise<T> {
  const data = await ctx.stub.getState(keyOf(docType, id));
  if (!data || data.length === 0) {
    fail(notFoundCode, `${docType} ${id} does not exist`);
  }
  return JSON.parse(data.toString()) as T;
}

async function save(ctx: Context, docType: string, id: string, doc: unknown): Promise<void> {
  await ctx.stub.putState(keyOf(docType, id), Buffer.from(JSON.stringify(doc)));
}

export async function exists(ctx: Context, docType: string, id: string): Promise<boolean> {
  const data = await ctx.stub.getState(keyOf(docType, id));
  return !!data && data.length > 0;
}

export async function loadPlayer(ctx: Context, id: string): Promise<Player> {
  const p = await load<Player>(ctx, 'player', id, 'PLAYER_NOT_FOUND');
  // 兼容 rating 字段上线前的旧记录（缺失即视为 1000，不改写状态）
  if (typeof p.rating !== 'number') p.rating = RATING_DEFAULT;
  return p;
}
export const savePlayer = (ctx: Context, p: Player) => save(ctx, 'player', p.playerId, p);

export async function loadPokemon(ctx: Context, id: string): Promise<Pokemon> {
  const p = await load<Pokemon>(ctx, 'pokemon', id, 'POKEMON_NOT_FOUND');
  // 兼容 evs/bond 字段上线前的旧记录（缺失即视为全 0 / 铸造默认值，不改写状态）
  if (!p.evs) p.evs = zeroEvs();
  if (typeof p.bond !== 'number') p.bond = BOND_DEFAULT;
  return p;
}
export const savePokemon = (ctx: Context, p: Pokemon) => save(ctx, 'pokemon', p.id, p);

export const loadItem = (ctx: Context, id: string) => load<Item>(ctx, 'item', id, 'ITEM_NOT_FOUND');
export const saveItem = (ctx: Context, i: Item) => save(ctx, 'item', i.id, i);

/** 读取道具，不存在返回 null（合并/退款路径需要容忍堆叠已被删除）。 */
export async function tryLoadItem(ctx: Context, id: string): Promise<Item | null> {
  const data = await ctx.stub.getState(keyOf('item', id));
  if (!data || data.length === 0) return null;
  return JSON.parse(data.toString()) as Item;
}

/** 删除道具记录（堆叠合并后清理被并入的堆叠）。 */
export async function deleteItem(ctx: Context, id: string): Promise<void> {
  await ctx.stub.deleteState(keyOf('item', id));
}

export const loadTrade = (ctx: Context, id: string) => load<Trade>(ctx, 'trade', id, 'TRADE_NOT_FOUND');
export const saveTrade = (ctx: Context, t: Trade) => save(ctx, 'trade', t.id, t);

export const loadBattle = (ctx: Context, id: string) => load<Battle>(ctx, 'battle', id, 'BATTLE_NOT_FOUND');
export const saveBattle = (ctx: Context, b: Battle) => save(ctx, 'battle', b.id, b);

export async function loadRand(ctx: Context, id: string): Promise<RandomCommit> {
  const r = await load<RandomCommit>(ctx, 'rand', id, 'RAND_NOT_FOUND');
  // 兼容 meta 字段上线前提交的旧记录（缺失即视为空串，不改写状态）
  if (r.meta === undefined) r.meta = '';
  return r;
}
export const saveRand = (ctx: Context, r: RandomCommit) => save(ctx, 'rand', r.eventId, r);

/** 调用者必须是该玩家本人（mspId 匹配，docs/chaincode-api.md §2.1）。 */
export function assertCallerIsPlayer(ctx: Context, player: Player): void {
  const caller = getMspId(ctx);
  if (caller !== player.mspId) {
    fail('NOT_OWNER', `caller msp ${caller} does not match player ${player.playerId} (msp ${player.mspId})`);
  }
}

/** 所有权 + 未锁定断言，返回资产本体。 */
export async function requireOwnedIdlePokemon(ctx: Context, id: string, ownerId: string): Promise<Pokemon> {
  const p = await loadPokemon(ctx, id);
  if (p.ownerId !== ownerId) {
    fail('NOT_OWNER', `pokemon ${id} is owned by ${p.ownerId}, not ${ownerId}`);
  }
  if (p.status !== 'IDLE') {
    fail('ASSET_LOCKED', `pokemon ${id} is not IDLE (status=${p.status})`);
  }
  return p;
}

export async function requireOwnedIdleItem(ctx: Context, id: string, ownerId: string): Promise<Item> {
  const i = await loadItem(ctx, id);
  if (i.ownerId !== ownerId) {
    fail('NOT_OWNER', `item ${id} is owned by ${i.ownerId}, not ${ownerId}`);
  }
  if (i.status !== 'IDLE') {
    fail('ASSET_LOCKED', `item ${id} is not IDLE (status=${i.status})`);
  }
  return i;
}

/** 扣分（余额不足抛 INSUFFICIENT_POINTS）。 */
export function debitPoints(player: Player, amount: number): void {
  if (amount < 0 || !Number.isSafeInteger(amount)) {
    fail('INVALID_PARAM', `debit amount must be a non-negative safe integer, got ${amount}`);
  }
  if (player.points < amount) {
    fail('INSUFFICIENT_POINTS', `player ${player.playerId} has ${player.points}, needs ${amount}`);
  }
  player.points = checkedAmount(player.points - amount, `points of ${player.playerId}`);
}

/** 加分（溢出检查）。 */
export function creditPoints(player: Player, amount: number): void {
  if (amount < 0 || !Number.isSafeInteger(amount)) {
    fail('INVALID_PARAM', `credit amount must be a non-negative safe integer, got ${amount}`);
  }
  player.points = checkedAmount(player.points + amount, `points of ${player.playerId}`);
}

/**
 * RandomContract 内部操作（docs/chaincode-api.md §2.2）：消费已揭示的随机事件。
 * 供同链码其他合约直接调用（共享键空间，不走 invokeChaincode）。
 * 须 REVEALED、purpose/playerId 匹配，→CONSUMED，返回 resultHash。
 */
export async function consumeRandom(ctx: Context, eventId: string, purpose: string, playerId: string): Promise<string> {
  const rand = await loadRand(ctx, eventId);
  if (rand.status === 'CONSUMED') {
    fail('RAND_CONSUMED', `random event ${eventId} already consumed`);
  }
  if (rand.status !== 'REVEALED') {
    fail('RAND_NOT_REVEALED', `random event ${eventId} is ${rand.status}, expected REVEALED`);
  }
  if (rand.purpose !== purpose) {
    fail('PURPOSE_MISMATCH', `random event ${eventId} purpose is ${rand.purpose}, expected ${purpose}`);
  }
  if (rand.playerId !== playerId) {
    fail('RAND_PLAYER_MISMATCH', `random event ${eventId} belongs to ${rand.playerId}, not ${playerId}`);
  }
  rand.status = 'CONSUMED';
  await saveRand(ctx, rand);
  return rand.resultHash;
}

export function emit(ctx: Context, name: string, payload: unknown): void {
  ctx.stub.setEvent(name, Buffer.from(JSON.stringify(payload)));
}
