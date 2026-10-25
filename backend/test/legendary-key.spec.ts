import { randomUUID } from 'crypto';
import { sha256hex } from '../src/common/utils/crypto.util';
import { CaptureService } from '../src/pokemon/capture.service';
import { WildService } from '../src/wild/wild.service';
import { loadWildSession, wildSessionKey } from '../src/wild/wild-session';
import type { WildSession } from '../src/wild/wild-session';
import {
  SYSTEM_IDENTITY,
  makeBondService,
  makeChain,
  makePokemonService,
  makeRedis,
  mintBall,
  registerPlayers,
  seedPokemon,
  userIdentity,
} from './helpers';

const ash = userIdentity('ash');

type Ctx = ReturnType<typeof build>;

function build() {
  const { chain, contract } = makeChain();
  const redis = makeRedis();
  const capture = new CaptureService(chain, contract, redis);
  const wild = new WildService(
    contract,
    capture,
    makePokemonService(contract, redis),
    makeBondService(contract, redis),
    redis,
  );
  return { chain, contract, redis, capture, wild };
}

function mintKey(ctx: Ctx, typeId: string, quantity = 1) {
  return mintBall(ctx.contract, 'ash', `i_${typeId}_${randomUUID().slice(0, 8)}`, typeId, quantity);
}

async function quantityOf(ctx: Ctx, itemId: string): Promise<number> {
  return (await ctx.contract.getItem(itemId)).quantity;
}

/** 按 typeId 汇总本人堆叠数量（退款 MintItem 会触发链上同 typeId 合并，堆叠 id 可能变化）。 */
async function typeQuantityOf(ctx: Ctx, typeId: string): Promise<number> {
  const stacks = (await ctx.contract.queryItemsByOwner('ash')).filter((i) => i.typeId === typeId);
  return stacks.reduce((sum, i) => sum + i.quantity, 0);
}

/** capture:* 键（含 pending 登记）——用来断言"拒绝时没有新建事件"。 */
async function captureKeys(ctx: Ctx): Promise<string[]> {
  return (await ctx.redis.client.keys('capture:*')).sort();
}

/** 把野怪压到 1 HP：击倒判定与派生流无关，测试只关心奖励口径。返回落盘后的会话（含 zoneId）。 */
async function patchWildHp(ctx: Ctx, sessionId: string, hp: number): Promise<WildSession> {
  const session = await loadWildSession(ctx.redis, sessionId);
  if (!session) throw new Error(`wild session ${sessionId} not found`);
  session.wild.hp = hp;
  await ctx.redis.setJson(wildSessionKey(sessionId), session, 900);
  return session;
}

/** 100 级测试宝可梦 + tackle（命中 100%），保证任何回合都能击倒 1 HP 的野怪。 */
async function seedHero(ctx: Ctx, id: string) {
  return seedPokemon(ctx.chain, 'ash', {
    id,
    speciesId: 150,
    level: 100,
    moves: ['tackle'],
  });
}

/** 走真实 encounter → wild.start → 击倒流程，返回 KO 后的状态与积分变化。 */
async function knockOut(ctx: Ctx, heroId: string, eventId: string) {
  const started = await ctx.wild.start(ash, eventId, heroId);
  const session = await patchWildHp(ctx, started.sessionId, 1);
  const before = (await ctx.contract.getPlayer('ash')).points;
  const after = await ctx.wild.action(ash, started.sessionId, { type: 'move', moveId: 'tackle' });
  const points = (await ctx.contract.getPlayer('ash')).points;
  expect(after.status).toBe('WILD_FAINTED');
  return { after, hero: await ctx.contract.getPokemon(heroId), points, before, zoneId: session.zoneId };
}

describe('传说钥匙一次性消耗（H11，docs/backend-api.md §2「传说区」）', () => {
  it('传说区遇敌消耗恰好 1 把钥匙（2 → 1），同一 event 重放 ConsumeItem 不重复扣', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const key = await mintKey(ctx, 'sky-key', 2);
    const consume = jest.spyOn(ctx.contract, 'consumeItem');

    const event = await ctx.capture.encounter(ash, undefined, 0, 'sky-pillar');
    expect(await quantityOf(ctx, key.id)).toBe(1);
    expect(consume).toHaveBeenCalledWith(ash, key.id, 1, 'legendary-key', {
      idemKey: `${event.eventId}-legendary-key`,
    });

    // 同一个 eventId 的消耗重放（模拟网络重试/重放）：命中 idempotent，不再扣第二把
    const replay = await ctx.contract.consumeItem(ash, key.id, 1, 'legendary-key', {
      idemKey: `${event.eventId}-legendary-key`,
    });
    expect(replay.quantity).toBe(1);
    expect(await quantityOf(ctx, key.id)).toBe(1);
    consume.mockRestore();

    // 第二个事件再消耗 1 把 → 0
    const second = await ctx.capture.encounter(ash, undefined, 0, 'sky-pillar');
    expect(second.eventId).not.toBe(event.eventId);
    expect(await quantityOf(ctx, key.id)).toBe(0);
  });

  it('钥匙用完后第二次遇敌 403 KEY_REQUIRED，且不再消耗任何道具/不建事件', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const key = await mintKey(ctx, 'magma-key', 1);
    await ctx.capture.encounter(ash, undefined, 0, 'magma');
    expect(await quantityOf(ctx, key.id)).toBe(0);

    const keysBefore = await captureKeys(ctx);
    await expect(ctx.capture.encounter(ash, undefined, 0, 'magma')).rejects.toMatchObject({ status: 403 });
    await expect(ctx.capture.encounter(ash, undefined, 0, 'magma')).rejects.toThrow(/KEY_REQUIRED/);
    expect(await quantityOf(ctx, key.id)).toBe(0);
    expect(await captureKeys(ctx)).toEqual(keysBefore);
  });

  it('已拥有该区传说 → 409 LEGENDARY_OWNED，钥匙不被消耗、不建事件', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const key = await mintKey(ctx, 'sky-key', 1);
    await seedPokemon(ctx.chain, 'ash', { id: 'p_owned_ray', speciesId: 384, status: 'IDLE' });

    const keysBefore = await captureKeys(ctx);
    await expect(ctx.capture.encounter(ash, undefined, 0, 'sky-pillar')).rejects.toMatchObject({ status: 409 });
    await expect(ctx.capture.encounter(ash, undefined, 0, 'sky-pillar')).rejects.toThrow(
      /LEGENDARY_OWNED: 你已经拥有 烈空坐/,
    );
    expect(await quantityOf(ctx, key.id)).toBe(1);
    expect(await captureKeys(ctx)).toEqual(keysBefore);
  });

  it('传说区击倒 0 积分（不发 reward:wild-faint），普通区仍是 等级×1', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const key = await mintKey(ctx, 'sky-key', 1);
    await seedHero(ctx, 'p_legendary_hero');

    const legendary = await ctx.capture.encounter(ash, undefined, 0, 'sky-pillar');
    // 遇敌已消耗钥匙；野怪战斗（start/action/击倒）不得二次消耗
    expect(await quantityOf(ctx, key.id)).toBe(0);
    const addPoints = jest.spyOn(ctx.contract, 'addPoints');
    const legendaryKo = await knockOut(ctx, 'p_legendary_hero', legendary.eventId);
    expect(legendaryKo.zoneId).toBe('sky-pillar'); // 遇敌区域随野怪会话落盘
    expect(legendaryKo.after.faintReward).toBe(0);
    expect(legendaryKo.points).toBe(legendaryKo.before);
    expect(
      addPoints.mock.calls.some(([, , , reason]) => String(reason).includes('reward:wild-faint')),
    ).toBe(false);
    addPoints.mockRestore();
    expect(await quantityOf(ctx, key.id)).toBe(0);
    expect(legendaryKo.hero.level).toBe(100);

    // 普通区：击倒奖励 = 野怪等级 × 1
    await seedHero(ctx, 'p_normal_hero');
    const normal = await ctx.capture.encounter(ash, undefined, 0, 'route-grass');
    const normalKo = await knockOut(ctx, 'p_normal_hero', normal.eventId);
    expect(normalKo.zoneId).toBe('route-grass');
    expect(normalKo.after.faintReward).toBe(normal.wild.level);
    expect(normalKo.points - normalKo.before).toBe(normal.wild.level);
  });

  it('Commit 失败时尽力退还 1 把钥匙（idemKey/metadataHash 固定，重复退款幂等）', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await mintKey(ctx, 'ruins-key', 2);
    const mintItem = jest.spyOn(ctx.contract, 'mintItem');
    const commit = jest.spyOn(ctx.contract, 'commitRandom').mockRejectedValueOnce(new Error('COMMIT_FAILED: chain down'));

    await expect(ctx.capture.encounter(ash, undefined, 0, 'ruins')).rejects.toThrow(/COMMIT_FAILED/);
    commit.mockRestore();

    // 先扣 1 把（2 → 1），退款 MintItem 又补回 1 把（同 typeId 自动合并 → 总计仍为 2）
    expect(await typeQuantityOf(ctx, 'ruins-key')).toBe(2);
    const refund = mintItem.mock.calls.find(([, args]) => args.typeId === 'ruins-key');
    expect(refund).toBeDefined();
    const [, refundArgs, refundMeta] = refund!;
    expect(refundArgs).toMatchObject({
      playerId: 'ash',
      typeId: 'ruins-key',
      quantity: 1,
      uri: 'minio://assets/items/ruins-key.png',
    });
    const idemKey = (refundMeta as { idemKey?: string }).idemKey!;
    const eventId = idemKey.replace(/-legendary-key-refund$/, '');
    expect(idemKey).toBe(`${eventId}-legendary-key-refund`);
    expect(refundArgs.metadataHash).toBe(sha256hex(`legendary-key-refund|${eventId}`));
    // 承诺没写成事件
    await expect(ctx.contract.getRandom(eventId)).rejects.toThrow(/RAND_NOT_FOUND/);
    mintItem.mockRestore();

    // 退款本身幂等：同一 idemKey 重试不会把钥匙刷成 3
    await ctx.contract.mintItem(
      SYSTEM_IDENTITY,
      {
        id: `i_${randomUUID()}`,
        playerId: 'ash',
        typeId: 'ruins-key',
        quantity: 1,
        uri: 'minio://assets/items/ruins-key.png',
        metadataHash: sha256hex(`legendary-key-refund|${eventId}`),
      },
      { idemKey },
    );
    expect(await typeQuantityOf(ctx, 'ruins-key')).toBe(2);
  });
});
