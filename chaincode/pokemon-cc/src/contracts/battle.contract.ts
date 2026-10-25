import { Context, Contract, Returns, Transaction } from 'fabric-contract-api';
import { assertISO, checkedAmount, fail, requireHex64, requireNonEmpty } from '../common/assert';
import { parseWagerBundle, validatePokemonAssets } from '../common/bundle';
import { getEnrollmentId, getRole, requireArbitrator, requireRole } from '../common/cid';
import { canonicalJson, sha256hex } from '../common/crypto';
import { withIdempotency } from '../common/idempotency';
import { Battle, BOND_RESET_ON_TRANSFER, Item, ItemStackRef, WagerBundle } from '../common/model';
import { collectQuery, selectorQuery } from '../common/query';
import { childStackId, mergeIdleStacks, parentStackIdOf } from '../common/stacks';
import {
  assertCallerIsPlayer,
  creditPoints,
  debitPoints,
  deleteItem,
  emit,
  exists,
  loadBattle,
  loadItem,
  loadPlayer,
  loadPokemon,
  saveBattle,
  saveItem,
  savePlayer,
  savePokemon,
  tryLoadItem,
} from '../common/state';

export function wagerHashOf(playerA: string, playerB: string, wagerA: WagerBundle, wagerB: WagerBundle): string {
  return sha256hex(canonicalJson({ playerA, playerB, wagerA, wagerB }));
}

/** 兼容 items 字段上线前存入的旧 battle（`itemIds` → 整堆 qty=0）。 */
function wagerItemRefs(wager: WagerBundle): ItemStackRef[] {
  if (Array.isArray(wager.items)) return wager.items;
  const legacy = (wager as unknown as { itemIds?: string[] }).itemIds ?? [];
  return legacy.map((id) => ({ id, qty: 0 }));
}

function opponentOf(battle: Battle, playerId: string): string {
  if (playerId === battle.playerA) return battle.playerB;
  if (playerId === battle.playerB) return battle.playerA;
  fail('NOT_PARTY', `player ${playerId} is not a party of battle ${battle.id}`);
}

/**
 * 锁定一方的押注道具（docs/chaincode-api.md §2.6）：
 * qty=0（旧格式整堆）或 qty=堆叠总量 → 整堆 LOCKED_BATTLE；qty<总量 → 原堆叠减量保持 IDLE，
 * 另建确定性 id 的子堆叠 `<parentId>#w<battleId>` 置 LOCKED_BATTLE、lockRef=battleId。
 * qty 越界（>持有量）抛 INSUFFICIENT_QUANTITY，safeInt/qty≥1 已在解析层校验。
 */
async function resolveAndLockWagerItems(
  ctx: Context,
  battleId: string,
  ownerId: string,
  wager: WagerBundle,
  side: string,
  nowISO: string,
): Promise<Item[]> {
  const locked: Item[] = [];
  for (const ref of wagerItemRefs(wager)) {
    const parent = await loadItem(ctx, ref.id);
    if (parent.ownerId !== ownerId) {
      fail('NOT_OWNER', `[${side}] item ${ref.id} is owned by ${parent.ownerId}, not ${ownerId}`);
    }
    if (parent.status !== 'IDLE') {
      fail('ASSET_LOCKED', `[${side}] item ${ref.id} is not IDLE (status=${parent.status})`);
    }
    if (ref.qty === 0 || ref.qty === parent.quantity) {
      parent.status = 'LOCKED_BATTLE';
      parent.lockRef = battleId;
      await saveItem(ctx, parent);
      locked.push(parent);
      continue;
    }
    if (ref.qty > parent.quantity) {
      fail('INSUFFICIENT_QUANTITY', `[${side}] item ${ref.id} has ${parent.quantity}, cannot wager ${ref.qty}`);
    }
    parent.quantity -= ref.qty;
    await saveItem(ctx, parent);
    const childId = childStackId(parent.id, battleId);
    if (await exists(ctx, 'item', childId)) {
      fail('ITEM_EXISTS', `split stack id ${childId} already exists`);
    }
    const child: Item = {
      ...parent,
      id: childId,
      quantity: ref.qty,
      status: 'LOCKED_BATTLE',
      lockRef: battleId,
      createdAt: nowISO,
    };
    await saveItem(ctx, child);
    locked.push(child);
  }
  return locked;
}

/** 结算时定位某条 wager 引用实际锁定的堆叠：整堆锁→原堆叠，拆分锁→子堆叠。 */
async function lockedWagerItem(ctx: Context, ref: ItemStackRef, battleId: string): Promise<Item> {
  const parent = await tryLoadItem(ctx, ref.id);
  if (parent && parent.status === 'LOCKED_BATTLE' && parent.lockRef === battleId) return parent;
  const child = await tryLoadItem(ctx, childStackId(ref.id, battleId));
  if (child && child.status === 'LOCKED_BATTLE' && child.lockRef === battleId) return child;
  fail('BAD_STATE', `item ${ref.id} is not locked by battle ${battleId}`);
}

/**
 * 统一结算入口（docs/chaincode-api.md §2.6 settle 规则）：
 * - 赢家得双方押注的全部宝可梦与道具 + escrow 全部积分；wins/losses +1。
 *   易主的宝可梦 bond 重置为 30（赢家自有宝可梦保持原值）。
 *   收到的道具堆叠解锁后按合并规则（§2.4）与赢家同 typeId 的 IDLE 堆叠归一。
 * - DRAW：各自取回自己的押注资产与 escrow 积分；不记胜负。
 *   子堆叠数量并回原堆叠（原堆叠仍存在且 IDLE 时），否则恢复为独立 IDLE 堆叠。
 * - REFUND：同 DRAW（仲裁退款）。
 * 全部资产解锁→IDLE、写入 settledAt。任何一步校验失败整体抛错回滚。
 */
async function settle(ctx: Context, battle: Battle, outcome: string, nowISO: string): Promise<void> {
  const a = await loadPlayer(ctx, battle.playerA);
  const b = await loadPlayer(ctx, battle.playerB);
  const wageredPoke = [...battle.wagerA.pokemonIds, ...battle.wagerB.pokemonIds];
  const items = [];
  for (const ref of [...wagerItemRefs(battle.wagerA), ...wagerItemRefs(battle.wagerB)]) {
    items.push(await lockedWagerItem(ctx, ref, battle.id));
  }
  const pokemons = [];
  for (const pid of wageredPoke) {
    const p = await loadPokemon(ctx, pid);
    if (p.status !== 'LOCKED_BATTLE' || p.lockRef !== battle.id) {
      fail('BAD_STATE', `pokemon ${pid} is not locked by battle ${battle.id}`);
    }
    pokemons.push(p);
  }

  if (outcome === 'DRAW' || outcome === 'REFUND') {
    creditPoints(a, battle.escrow.pointsA);
    creditPoints(b, battle.escrow.pointsB);
    for (const item of items) {
      const parentId = parentStackIdOf(item.id);
      const parent = parentId ? await tryLoadItem(ctx, parentId) : null;
      if (parent && parent.status === 'IDLE' && parent.ownerId === item.ownerId && parent.typeId === item.typeId) {
        parent.quantity = checkedAmount(parent.quantity + item.quantity, `merged quantity of ${item.typeId}`);
        await saveItem(ctx, parent);
        await deleteItem(ctx, item.id);
        continue;
      }
      item.status = 'IDLE';
      item.lockRef = '';
      await saveItem(ctx, item);
    }
  } else {
    if (outcome !== battle.playerA && outcome !== battle.playerB) {
      fail('INVALID_WINNER', `winner must be ${battle.playerA}, ${battle.playerB} or DRAW, got "${outcome}"`);
    }
    const winner = outcome === battle.playerA ? a : b;
    const loser = outcome === battle.playerA ? b : a;
    for (const p of pokemons) {
      // 易主即归零：易主的宝可梦 bond 重置为 30，赢家自有宝可梦保持原值
      if (p.ownerId !== winner.playerId) {
        p.bond = BOND_RESET_ON_TRANSFER;
      }
      p.ownerId = winner.playerId;
    }
    for (const i of items) {
      i.ownerId = winner.playerId;
      i.status = 'IDLE';
      i.lockRef = '';
      await saveItem(ctx, i);
    }
    // 赢家收到的堆叠与本方同 typeId 的 IDLE 堆叠归一（本交易改写的堆叠经 extraIds 补充）
    const typeIds = [...new Set(items.map((i) => i.typeId))].sort();
    for (const typeId of typeIds) {
      await mergeIdleStacks(ctx, winner.playerId, typeId, items.filter((i) => i.typeId === typeId).map((i) => i.id));
    }
    creditPoints(winner, battle.escrow.pointsA + battle.escrow.pointsB);
    winner.wins += 1;
    loser.losses += 1;
  }

  for (const p of pokemons) {
    p.status = 'IDLE';
    p.lockRef = '';
    await savePokemon(ctx, p);
  }
  await savePlayer(ctx, a);
  await savePlayer(ctx, b);
  battle.settledAt = nowISO;
}

export class BattleContract extends Contract {
  constructor() {
    super('BattleContract');
  }

  @Transaction()
  public async CreateBattle(
    ctx: Context,
    id: string,
    playerA: string,
    playerB: string,
    wagerAJSON: string,
    wagerBJSON: string,
    wagerHash: string,
    nowISO: string,
    idemKey: string,
  ): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireNonEmpty(id, 'id');
      requireNonEmpty(playerA, 'playerA');
      requireNonEmpty(playerB, 'playerB');
      assertISO(nowISO, 'nowISO');
      if (playerA === playerB) {
        fail('SAME_PLAYER', 'playerA and playerB must be different');
      }
      if (await exists(ctx, 'battle', id)) {
        fail('BATTLE_EXISTS', `battle ${id} already exists`);
      }
      const a = await loadPlayer(ctx, playerA);
      const b = await loadPlayer(ctx, playerB);
      if (getRole(ctx) !== 'system') {
        const caller = getEnrollmentId(ctx);
        if (!caller || (caller !== playerA && caller !== playerB)) {
          fail('FORBIDDEN', `CreateBattle requires system or a battle party (caller ${caller || '<none>'})`);
        }
      }
      const wagerA = parseWagerBundle(wagerAJSON, 'wagerA');
      const wagerB = parseWagerBundle(wagerBJSON, 'wagerB');
      requireHex64(wagerHash, 'wagerHash');
      if (wagerHashOf(playerA, playerB, wagerA, wagerB) !== wagerHash.toLowerCase()) {
        fail('WAGER_HASH_MISMATCH', 'wagerHash does not match sha256(canonical({playerA,playerB,wagerA,wagerB}))');
      }
      const allPoke = [...wagerA.pokemonIds, ...wagerB.pokemonIds];
      const allItems = [...wagerItemRefs(wagerA).map((r) => r.id), ...wagerItemRefs(wagerB).map((r) => r.id)];
      if (new Set(allPoke).size !== allPoke.length || new Set(allItems).size !== allItems.length) {
        fail('INVALID_PARAM', 'the same asset cannot appear in both wagers');
      }
      const pokemonsA = await validatePokemonAssets(ctx, wagerA.pokemonIds, playerA, 'wagerA');
      const pokemonsB = await validatePokemonAssets(ctx, wagerB.pokemonIds, playerB, 'wagerB');
      // points 立即从双方余额扣入 escrow
      debitPoints(a, wagerA.points);
      debitPoints(b, wagerB.points);
      for (const p of [...pokemonsA, ...pokemonsB]) {
        p.status = 'LOCKED_BATTLE';
        p.lockRef = id;
        await savePokemon(ctx, p);
      }
      await resolveAndLockWagerItems(ctx, id, playerA, wagerA, 'wagerA', nowISO);
      await resolveAndLockWagerItems(ctx, id, playerB, wagerB, 'wagerB', nowISO);
      await savePlayer(ctx, a);
      await savePlayer(ctx, b);
      const battle: Battle = {
        docType: 'battle',
        id,
        playerA,
        playerB,
        wagerA,
        wagerB,
        wagerHash: wagerHash.toLowerCase(),
        status: 'CREATED',
        escrow: { pointsA: wagerA.points, pointsB: wagerB.points },
        result: {
          winnerId: '',
          resultHash: '',
          serverSig: '',
          serverSubmitted: false,
          confirmations: { A: false, B: false },
        },
        disputeReason: '',
        arbiterNote: '',
        createdAt: nowISO,
        settledAt: '',
      };
      await saveBattle(ctx, battle);
      emit(ctx, 'BattleCreated', { id, playerA, playerB, wagerHash: battle.wagerHash });
      return JSON.stringify(battle);
    });
  }

  @Transaction()
  public async ActivateBattle(ctx: Context, id: string, nowISO: string, idemKey: string): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireRole(ctx, 'system');
      assertISO(nowISO, 'nowISO');
      const battle = await loadBattle(ctx, id);
      if (battle.status !== 'CREATED') {
        fail('BAD_STATE', `battle ${id} is ${battle.status}, expected CREATED`);
      }
      battle.status = 'ACTIVE';
      await saveBattle(ctx, battle);
      emit(ctx, 'BattleActivated', { id });
      return JSON.stringify(battle);
    });
  }

  @Transaction()
  public async SubmitResult(
    ctx: Context,
    id: string,
    winnerId: string,
    resultHash: string,
    serverSig: string,
    nowISO: string,
    idemKey: string,
  ): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireRole(ctx, 'system');
      requireNonEmpty(winnerId, 'winnerId');
      requireHex64(resultHash, 'resultHash');
      requireNonEmpty(serverSig, 'serverSig');
      assertISO(nowISO, 'nowISO');
      const battle = await loadBattle(ctx, id);
      if (battle.status !== 'ACTIVE') {
        fail('BAD_STATE', `battle ${id} is ${battle.status}, expected ACTIVE`);
      }
      if (winnerId !== battle.playerA && winnerId !== battle.playerB && winnerId !== 'DRAW') {
        fail('INVALID_WINNER', `winnerId must be ${battle.playerA}, ${battle.playerB} or DRAW`);
      }
      battle.result = {
        winnerId,
        resultHash: resultHash.toLowerCase(),
        serverSig,
        serverSubmitted: true,
        confirmations: { A: false, B: false },
      };
      battle.status = 'RESULT_SUBMITTED';
      await saveBattle(ctx, battle);
      emit(ctx, 'BattleResultSubmitted', { id, winnerId, resultHash: battle.result.resultHash });
      return JSON.stringify(battle);
    });
  }

  @Transaction()
  public async ConfirmResult(ctx: Context, id: string, playerId: string, nowISO: string, idemKey: string): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireNonEmpty(id, 'id');
      assertISO(nowISO, 'nowISO');
      const battle = await loadBattle(ctx, id);
      if (battle.status !== 'RESULT_SUBMITTED') {
        fail('BAD_STATE', `battle ${id} is ${battle.status}, expected RESULT_SUBMITTED`);
      }
      if (playerId !== battle.playerA && playerId !== battle.playerB) {
        fail('NOT_PARTY', `player ${playerId} is not a party of battle ${id}`);
      }
      const player = await loadPlayer(ctx, playerId);
      assertCallerIsPlayer(ctx, player);
      const side = playerId === battle.playerA ? 'A' : 'B';
      battle.result.confirmations[side] = true;
      emit(ctx, 'BattleConfirmed', { id, side, playerId });
      if (battle.result.confirmations.A && battle.result.confirmations.B) {
        await settle(ctx, battle, battle.result.winnerId, nowISO);
        battle.status = 'SETTLED';
        emit(ctx, 'BattleSettled', { id, winnerId: battle.result.winnerId });
      }
      await saveBattle(ctx, battle);
      return JSON.stringify(battle);
    });
  }

  /** 超时兜底：RESULT_SUBMITTED 后一方掉线不确认时由 system 直接结算。幂等。 */
  @Transaction()
  public async SettleBattle(ctx: Context, id: string, nowISO: string, idemKey: string): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireRole(ctx, 'system');
      assertISO(nowISO, 'nowISO');
      const battle = await loadBattle(ctx, id);
      if (battle.status !== 'RESULT_SUBMITTED') {
        fail('BAD_STATE', `battle ${id} is ${battle.status}, expected RESULT_SUBMITTED`);
      }
      await settle(ctx, battle, battle.result.winnerId, nowISO);
      battle.status = 'SETTLED';
      await saveBattle(ctx, battle);
      emit(ctx, 'BattleSettled', { id, winnerId: battle.result.winnerId, via: 'SettleBattle' });
      return JSON.stringify(battle);
    });
  }

  @Transaction()
  public async Forfeit(ctx: Context, id: string, loserId: string, reason: string, nowISO: string, idemKey: string): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireRole(ctx, 'system');
      requireNonEmpty(loserId, 'loserId');
      requireNonEmpty(reason, 'reason');
      assertISO(nowISO, 'nowISO');
      const battle = await loadBattle(ctx, id);
      if (battle.status !== 'ACTIVE' && battle.status !== 'RESULT_SUBMITTED') {
        fail('BAD_STATE', `battle ${id} is ${battle.status}, expected ACTIVE or RESULT_SUBMITTED`);
      }
      const winnerId = opponentOf(battle, loserId);
      // 认输同样是「结果」：写入 winner 与确定性 resultHash（真链结算页/排行榜/e2e 都读 result.winnerId）；
      // 已有 SubmitResult 的 serverSig/resultHash 时只补 winner，不覆盖服务器签名。
      battle.result.winnerId = winnerId;
      if (!battle.result.serverSubmitted) {
        battle.result.resultHash = sha256hex(`forfeit|${battle.id}|${loserId}|${reason}`);
        battle.result.serverSubmitted = true;
      }
      await settle(ctx, battle, winnerId, nowISO);
      battle.status = 'SETTLED';
      battle.arbiterNote = `FORFEIT: ${reason}`;
      await saveBattle(ctx, battle);
      emit(ctx, 'BattleSettled', { id, winnerId, via: 'Forfeit', loserId });
      return JSON.stringify(battle);
    });
  }

  @Transaction()
  public async Dispute(ctx: Context, id: string, playerId: string, reason: string, nowISO: string, idemKey: string): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireNonEmpty(id, 'id');
      requireNonEmpty(reason, 'reason');
      assertISO(nowISO, 'nowISO');
      const battle = await loadBattle(ctx, id);
      if (battle.status === 'SETTLED' || battle.status === 'REFUNDED' || battle.status === 'DISPUTED') {
        fail('BAD_STATE', `battle ${id} is ${battle.status}, cannot be disputed`);
      }
      if (playerId !== battle.playerA && playerId !== battle.playerB) {
        fail('NOT_PARTY', `player ${playerId} is not a party of battle ${id}`);
      }
      const player = await loadPlayer(ctx, playerId);
      assertCallerIsPlayer(ctx, player);
      battle.status = 'DISPUTED';
      battle.disputeReason = reason;
      await saveBattle(ctx, battle);
      emit(ctx, 'BattleDisputed', { id, by: playerId, reason });
      return JSON.stringify(battle);
    });
  }

  @Transaction()
  public async Arbitrate(
    ctx: Context,
    id: string,
    outcome: string,
    arbiterNote: string,
    nowISO: string,
    idemKey: string,
  ): Promise<string> {
    return withIdempotency(ctx, idemKey, nowISO, async () => {
      requireArbitrator(ctx);
      requireNonEmpty(outcome, 'outcome');
      assertISO(nowISO, 'nowISO');
      const battle = await loadBattle(ctx, id);
      if (battle.status !== 'DISPUTED') {
        fail('BAD_STATE', `battle ${id} is ${battle.status}, expected DISPUTED`);
      }
      if (outcome === 'REFUND') {
        await settle(ctx, battle, 'REFUND', nowISO);
        battle.status = 'REFUNDED';
      } else {
        if (outcome !== 'DRAW' && outcome !== battle.playerA && outcome !== battle.playerB) {
          fail('INVALID_WINNER', `outcome must be ${battle.playerA}, ${battle.playerB}, DRAW or REFUND`);
        }
        await settle(ctx, battle, outcome, nowISO);
        battle.status = 'SETTLED';
      }
      battle.arbiterNote = arbiterNote;
      await saveBattle(ctx, battle);
      emit(ctx, 'BattleArbitrated', { id, outcome, arbiterNote });
      if (battle.status === 'SETTLED') {
        emit(ctx, 'BattleSettled', { id, winnerId: outcome, via: 'Arbitrate' });
      }
      return JSON.stringify(battle);
    });
  }

  @Transaction(false)
  @Returns('string')
  public async GetBattle(ctx: Context, id: string): Promise<string> {
    return JSON.stringify(await loadBattle(ctx, id));
  }

  @Transaction(false)
  @Returns('string')
  public async QueryByPlayer(ctx: Context, playerId: string): Promise<string> {
    requireNonEmpty(playerId, 'playerId');
    const list = await collectQuery(
      ctx,
      selectorQuery({ docType: 'battle', $or: [{ playerA: playerId }, { playerB: playerId }] }),
    );
    return JSON.stringify(list);
  }
}
