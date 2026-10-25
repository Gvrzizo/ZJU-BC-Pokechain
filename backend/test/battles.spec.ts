import { computeWagerHash } from '../src/fabric/chain.adapter';
import { BattleManagerService } from '../src/battles/battle-manager.service';
import { BattlesService } from '../src/battles/battles.service';
import { SigningService } from '../src/battles/signing.service';
import { BattleLog } from '../src/battles/entities/battle-log.entity';
import { DisputeRecord } from '../src/battles/entities/dispute-record.entity';
import { AuditLog } from '../src/admin/entities/audit-log.entity';
import { SYSTEM_IDENTITY, userIdentity, makeBlocks, makeChain, makeConfig, makeHpService, makeRedis, mockRepo, registerPlayers, seedPokemon } from './helpers';

const WAGER = { pokemonIds: [] as string[], itemIds: [] as string[], points: 50 };

async function createActiveBattle(contract: ReturnType<typeof makeChain>['contract'], id = 'b_1') {
  const wagerHash = computeWagerHash('ash', 'gary', WAGER, WAGER);
  await contract.createBattle(SYSTEM_IDENTITY, { id, playerA: 'ash', playerB: 'gary', wagerA: WAGER, wagerB: WAGER, wagerHash });
  await contract.activateBattle(SYSTEM_IDENTITY, id);
  return contract.getBattle(id);
}

describe('Battle wager settlement & arbitration (mock chain)', () => {
  it('CreateBattle escrows points and locks wagered assets', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const pika = await seedPokemon(chain, 'ash', { id: 'p_wager' });
    const wagerA = { pokemonIds: [pika.id], itemIds: [], points: 50 };
    const wagerHash = computeWagerHash('ash', 'gary', wagerA, WAGER);
    await contract.createBattle(SYSTEM_IDENTITY, { id: 'b_escrow', playerA: 'ash', playerB: 'gary', wagerA, wagerB: WAGER, wagerHash });
    expect((await contract.getPlayer('ash')).points).toBe(950);
    expect((await contract.getPlayer('gary')).points).toBe(950);
    expect((await contract.getPokemon(pika.id)).status).toBe('LOCKED_BATTLE');
    const battle = await contract.getBattle('b_escrow');
    expect(battle.escrow).toEqual({ pointsA: 50, pointsB: 50 });
  });

  it('rejects a tampered wagerHash (WAGER_HASH_MISMATCH)', async () => {
    const { contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    await expect(
      contract.createBattle(SYSTEM_IDENTITY, {
        id: 'b_hash',
        playerA: 'ash',
        playerB: 'gary',
        wagerA: WAGER,
        wagerB: WAGER,
        wagerHash: 'f'.repeat(64),
      }),
    ).rejects.toThrow(/WAGER_HASH_MISMATCH/);
  });

  it('SubmitResult + double ConfirmResult settles: winner takes all', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const pika = await seedPokemon(chain, 'ash', { id: 'p_settle' });
    const wagerA = { pokemonIds: [pika.id], itemIds: [], points: 50 };
    const wagerHash = computeWagerHash('ash', 'gary', wagerA, WAGER);
    await contract.createBattle(SYSTEM_IDENTITY, { id: 'b_settle', playerA: 'ash', playerB: 'gary', wagerA, wagerB: WAGER, wagerHash });
    await contract.activateBattle(SYSTEM_IDENTITY, 'b_settle');
    await contract.submitBattleResult(SYSTEM_IDENTITY, 'b_settle', 'gary', 'r'.repeat(64), 'sig');
    await contract.confirmBattleResult(userIdentity('ash'), 'b_settle', 'ash');
    const settled = await contract.confirmBattleResult(userIdentity('gary'), 'b_settle', 'gary');
    expect(settled.status).toBe('SETTLED');
    expect((await contract.getPlayer('gary')).points).toBe(1050); // 950 + 100 escrow
    expect((await contract.getPlayer('ash')).points).toBe(950);
    expect((await contract.getPokemon(pika.id)).ownerId).toBe('gary'); // loser asset to winner
    expect((await contract.getPokemon(pika.id)).status).toBe('IDLE');
    expect((await contract.getPlayer('gary')).wins).toBe(1);
    expect((await contract.getPlayer('ash')).losses).toBe(1);
  });

  it('DRAW returns everyone their own wager and escrow', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const pika = await seedPokemon(chain, 'ash', { id: 'p_draw' });
    const wagerA = { pokemonIds: [pika.id], itemIds: [], points: 50 };
    const wagerHash = computeWagerHash('ash', 'gary', wagerA, WAGER);
    await contract.createBattle(SYSTEM_IDENTITY, { id: 'b_draw', playerA: 'ash', playerB: 'gary', wagerA, wagerB: WAGER, wagerHash });
    await contract.activateBattle(SYSTEM_IDENTITY, 'b_draw');
    await contract.submitBattleResult(SYSTEM_IDENTITY, 'b_draw', 'DRAW', 'r'.repeat(64), 'sig');
    const settled = await contract.settleBattle(SYSTEM_IDENTITY, 'b_draw');
    expect(settled.status).toBe('SETTLED');
    expect((await contract.getPlayer('ash')).points).toBe(1000);
    expect((await contract.getPlayer('gary')).points).toBe(1000);
    expect((await contract.getPokemon(pika.id)).ownerId).toBe('ash');
    expect((await contract.getPlayer('ash')).wins).toBe(0);
  });

  it('SettleBattle fallback works without player confirmations', async () => {
    const { contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    await createActiveBattle(contract, 'b_fallback');
    await contract.submitBattleResult(SYSTEM_IDENTITY, 'b_fallback', 'ash', 'r'.repeat(64), 'sig');
    const settled = await contract.settleBattle(SYSTEM_IDENTITY, 'b_fallback');
    expect(settled.status).toBe('SETTLED');
    expect((await contract.getPlayer('ash')).points).toBe(1050);
    // idempotent: settling again returns the same settled state
    const again = await contract.settleBattle(SYSTEM_IDENTITY, 'b_fallback');
    expect(again.status).toBe('SETTLED');
  });

  it('Forfeit settles immediately with the other player as winner（C6：写入 result.winnerId/resultHash）', async () => {
    const { contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    await createActiveBattle(contract, 'b_forfeit');
    const settled = await contract.forfeitBattle(SYSTEM_IDENTITY, 'b_forfeit', 'ash', 'forfeit');
    expect(settled.status).toBe('SETTLED');
    expect(settled.result.winnerId).toBe('gary');
    // 真链结算页/排行榜/e2e 都读 result.winnerId：认输也必须写结果
    expect(settled.result.serverSubmitted).toBe(true);
    expect(settled.result.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await contract.getPlayer('gary')).points).toBe(1050);
    expect((await contract.getPlayer('gary')).wins).toBe(1);
  });

  it('Forfeit after SubmitResult keeps the submitted resultHash/serverSig, only winner is recorded', async () => {
    const { contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    await createActiveBattle(contract, 'b_forfeit_sub');
    await contract.submitBattleResult(SYSTEM_IDENTITY, 'b_forfeit_sub', 'gary', 'r'.repeat(64), 'sig');
    const settled = await contract.forfeitBattle(SYSTEM_IDENTITY, 'b_forfeit_sub', 'ash', 'forfeit');
    expect(settled.status).toBe('SETTLED');
    expect(settled.result).toMatchObject({ winnerId: 'gary', resultHash: 'r'.repeat(64), serverSig: 'sig', serverSubmitted: true });
    expect((await contract.getPlayer('gary')).wins).toBe(1);
  });

  it('Dispute freezes assets; Arbitrate REFUND returns everything (Org2 arbitrator only)', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    const pika = await seedPokemon(chain, 'ash', { id: 'p_disp' });
    const wagerA = { pokemonIds: [pika.id], itemIds: [], points: 50 };
    const wagerHash = computeWagerHash('ash', 'gary', wagerA, WAGER);
    await contract.createBattle(SYSTEM_IDENTITY, { id: 'b_disp', playerA: 'ash', playerB: 'gary', wagerA, wagerB: WAGER, wagerHash });
    await contract.activateBattle(SYSTEM_IDENTITY, 'b_disp');
    await contract.submitBattleResult(SYSTEM_IDENTITY, 'b_disp', 'gary', 'r'.repeat(64), 'sig');
    const disputed = await contract.disputeBattle(userIdentity('ash'), 'b_disp', 'ash', 'suspicious rng');
    expect(disputed.status).toBe('DISPUTED');
    // assets stay locked while disputed
    expect((await contract.getPokemon(pika.id)).status).toBe('LOCKED_BATTLE');

    // a normal player cannot arbitrate
    await expect(
      contract.arbitrateBattle(userIdentity('gary'), 'b_disp', 'REFUND', 'no'),
    ).rejects.toThrow(/NOT_ARBITRATOR/);

    const arbiter = userIdentity('arbiter', 'arbitrator', 'Org2MSP');
    const refunded = await contract.arbitrateBattle(arbiter, 'b_disp', 'REFUND', 'rng review inconclusive');
    expect(refunded.status).toBe('REFUNDED');
    expect((await contract.getPlayer('ash')).points).toBe(1000);
    expect((await contract.getPlayer('gary')).points).toBe(1000);
    expect((await contract.getPokemon(pika.id)).ownerId).toBe('ash');
    expect((await contract.getPokemon(pika.id)).status).toBe('IDLE');
  });

  it('arbitrate to a winner settles like a normal win', async () => {
    const { contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    await createActiveBattle(contract, 'b_arbwin');
    await contract.submitBattleResult(SYSTEM_IDENTITY, 'b_arbwin', 'gary', 'r'.repeat(64), 'sig');
    await contract.disputeBattle(userIdentity('gary'), 'b_arbwin', 'gary', 'opponent stalled');
    const arbiter = userIdentity('arbiter', 'arbitrator', 'Org2MSP');
    const settled = await contract.arbitrateBattle(arbiter, 'b_arbwin', 'gary', 'evidence supports gary');
    expect(settled.status).toBe('SETTLED');
    expect((await contract.getPlayer('gary')).points).toBe(1050);
    expect((await contract.getPlayer('gary')).wins).toBe(1);
  });

  it('only system may submit results (NOT_AUTHORIZED)', async () => {
    const { contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    await createActiveBattle(contract, 'b_auth');
    await expect(
      contract.submitBattleResult(userIdentity('ash'), 'b_auth', 'ash', 'r'.repeat(64), 'sig'),
    ).rejects.toThrow(/NOT_AUTHORIZED/);
  });
});

describe('BattleManagerService (timeouts & forfeit)', () => {
  const teamA = [{ pokemonId: 'pa1', speciesId: 25, level: 20, ivs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 }, moves: ['tackle'] }];
  const teamB = [{ pokemonId: 'pb1', speciesId: 9, level: 20, ivs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 }, moves: ['tackle'] }];

  function makeManager(configValues: Record<string, unknown>) {
    const { contract } = makeChain();
    const redis = makeRedis();
    const signing = new SigningService(makeConfig({ serverSigningKey: '' }));
    const logs = mockRepo<BattleLog>();
    const manager = new BattleManagerService(
      contract,
      redis,
      signing,
      makeConfig(configValues),
      logs as never,
    );
    return { manager, contract, logs };
  }

  /** The turn clock only starts once both players reached the battle screen. */
  async function startAndEnter(manager: BattleManagerService, battleId: string, team1 = teamA, team2 = teamB) {
    await manager.startBattle(battleId, 'ash', 'gary', team1, team2);
    manager.enterBattle(battleId, 'ash');
    manager.enterBattle(battleId, 'gary');
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('turn timeout: the idle side forfeits after 30s', async () => {
    const { manager, contract } = makeManager({ battle: { turnTimeoutMs: 30_000, disconnectTimeoutMs: 60_000, settleFallbackMs: 300_000 } });
    await registerPlayers(contract, 'ash', 'gary');
    await createActiveBattle(contract, 'b_to');
    await startAndEnter(manager, 'b_to');

    manager.submitAction('b_to', 'gary', { type: 'move', moveIndex: 0 }); // ash idles
    await jest.advanceTimersByTimeAsync(31_000);

    const battle = await contract.getBattle('b_to');
    expect(battle.status).toBe('SETTLED');
    expect(battle.result.winnerId).toBe('gary');
    expect((await contract.getPlayer('gary')).points).toBe(1050);
    expect(manager.activeCount()).toBe(0);
  });

  it('disconnect: the offline side forfeits after 60s', async () => {
    const { manager, contract } = makeManager({ battle: { turnTimeoutMs: 300_000, disconnectTimeoutMs: 60_000, settleFallbackMs: 600_000 } });
    await registerPlayers(contract, 'ash', 'gary');
    await createActiveBattle(contract, 'b_dc');
    await startAndEnter(manager, 'b_dc');

    manager.playerDisconnected('b_dc', 'ash');
    await jest.advanceTimersByTimeAsync(61_000);

    const battle = await contract.getBattle('b_dc');
    expect(battle.status).toBe('SETTLED');
    expect(battle.result.winnerId).toBe('gary');
  });

  it('reconnect inside the grace window cancels the forfeit', async () => {
    const { manager, contract } = makeManager({ battle: { turnTimeoutMs: 300_000, disconnectTimeoutMs: 60_000, settleFallbackMs: 600_000 } });
    await registerPlayers(contract, 'ash', 'gary');
    await createActiveBattle(contract, 'b_re');
    await startAndEnter(manager, 'b_re');

    manager.playerDisconnected('b_re', 'ash');
    await jest.advanceTimersByTimeAsync(30_000);
    manager.playerConnected('b_re', 'ash');
    await jest.advanceTimersByTimeAsync(120_000);

    expect((await contract.getBattle('b_re')).status).toBe('ACTIVE');
  });

  it('active forfeit: SubmitResult path is skipped, chain settles via Forfeit and a battle log is persisted', async () => {
    const { manager, contract, logs } = makeManager({ battle: { turnTimeoutMs: 300_000, disconnectTimeoutMs: 600_000, settleFallbackMs: 600_000 } });
    await registerPlayers(contract, 'ash', 'gary');
    await createActiveBattle(contract, 'b_ff');
    await startAndEnter(manager, 'b_ff');

    await manager.forfeit('b_ff', 'ash');
    const battle = await contract.getBattle('b_ff');
    expect(battle.status).toBe('SETTLED');
    expect(battle.result.winnerId).toBe('gary');
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0].resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(logs.rows[0].serverSig.length).toBeGreaterThan(0);
    // battle random was revealed for audit
    const random = await contract.getRandom('ev_battle_b_ff');
    expect(random.status).toBe('REVEALED');
  });
});

describe('BattlesService dispute index (GET /battles?status=disputed)', () => {
  it('dispute() records an OPEN entry; arbitrate() resolves it', async () => {
    const { contract } = makeChain();
    await registerPlayers(contract, 'ash', 'gary');
    await createActiveBattle(contract, 'b_idx');
    await contract.submitBattleResult(SYSTEM_IDENTITY, 'b_idx', 'gary', 'r'.repeat(64), 'sig');

    const disputes = mockRepo<DisputeRecord & { id?: string }>();
    const audits = mockRepo<AuditLog>();
    const users = {
      mustFindByUsername: async (u: string) => ({ username: u, fabricMspId: 'Org2MSP' }),
    };
    const manager = { get: () => undefined };
    const svc = new BattlesService(
      contract,
      makeRedis(),
      manager as never,
      users as never,
      makeBlocks(),
      makeHpService(),
      audits as never,
      disputes as never,
      makeConfig(),
    );

    await svc.dispute(userIdentity('ash'), 'b_idx', 'suspicious rng');
    let list = await svc.listDisputes('disputed');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'b_idx',
      playerA: 'ash',
      playerB: 'gary',
      status: 'DISPUTED',
      disputeReason: 'suspicious rng',
      raisedBy: 'ash',
    });

    await svc.arbitrate(userIdentity('arbiter', 'arbitrator'), 'b_idx', 'REFUND', 'inconclusive');
    expect(await svc.listDisputes('disputed')).toHaveLength(0);
    list = await svc.listDisputes('resolved');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'b_idx', status: 'ARBITRATED', outcome: 'REFUND' });
  });
});
