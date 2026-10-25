import { ADMIN_IDENTITY } from '../src/fabric/chain.types';
import { makeChain, userIdentity } from './helpers';

const DAY = 24 * 3600 * 1000;
const T0 = '2026-03-01T00:00:00.000Z';
const AFTER_LOCK = new Date(Date.parse(T0) + 72 * 3600 * 1000).toISOString();

function build() {
  const { chain, contract } = makeChain();
  return { chain, contract };
}

/** 直接注册（不经 helpers.registerPlayers：后者会补到 1000P 并解锁，掩盖 H10 行为）。 */
async function registerLocked(contract: ReturnType<typeof build>['contract'], ...names: string[]) {
  for (const name of names) {
    await contract.registerPlayer(ADMIN_IDENTITY, name, name, { nowISO: T0, idemKey: `register-${name}` });
  }
}

describe('H10 注册 400P + 72h 转账锁（Mock 与链码同语义）', () => {
  it('注册初始 400P；72h 内 TransferPoints / 交易支付积分均被拒（TRANSFER_LOCKED）', async () => {
    const { contract } = build();
    await registerLocked(contract, 'ash', 'bob');
    expect((await contract.getPlayer('ash')).points).toBe(400);
    expect((await contract.getPlayer('ash')).transferLockUntil).toBeTruthy();

    await expect(
      contract.transferPoints(userIdentity('ash'), 'ash', 'bob', 100, { nowISO: T0 }),
    ).rejects.toThrow(/TRANSFER_LOCKED/);

    const empty = { pokemonIds: [], itemIds: [], points: 0 };
    await expect(
      contract.createTrade(userIdentity('ash'), {
        id: 't_lock',
        fromId: 'ash',
        toId: 'bob',
        offer: { ...empty, points: 50 },
        request: empty,
        expiresAt: new Date(Date.parse(T0) + 3600_000).toISOString(),
      }, { nowISO: T0 }),
    ).rejects.toThrow(/TRANSFER_LOCKED/);

    // 边缘：恰好 72h 后解锁（字符串比较不是同一时区也按 Date.parse 判定）
    const ok = await contract.transferPoints(userIdentity('ash'), 'ash', 'bob', 100, { nowISO: AFTER_LOCK });
    expect(ok).toMatchObject({ fromId: 'ash', toId: 'bob', amount: 100 });
    expect((await contract.getPlayer('ash')).points).toBe(300);
    expect((await contract.getPlayer('bob')).points).toBe(500);
  });

  it('ClearTransferLock 仅 admin/system；解锁后即可转账，且旧记录缺字段视为无锁', async () => {
    const { contract } = build();
    await registerLocked(contract, 'ash', 'bob');
    await expect(contract.clearTransferLock(userIdentity('ash'), 'ash')).rejects.toThrow(/FORBIDDEN/);

    const unlocked = await contract.clearTransferLock(ADMIN_IDENTITY, 'ash', { idemKey: 'unlock-ash' });
    expect(unlocked.transferLockUntil).toBe('');
    await contract.transferPoints(userIdentity('ash'), 'ash', 'bob', 50, { idemKey: 'unlocked-transfer' });
    expect((await contract.getPlayer('ash')).points).toBe(350);
    expect((await contract.getPlayer('bob')).points).toBe(450);
  });
});
