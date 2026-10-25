import { randomUUID } from 'crypto';
import { CaptureService } from '../src/pokemon/capture.service';
import { ItemsService } from '../src/items/items.service';
import { ShopService } from '../src/shop/shop.service';
import { getItemType } from '../src/game-data/items.data';
import { zoneSpeciesIds } from '../src/game-data/encounter.data';
import {
  makeChain,
  makePokemonService,
  makeRedis,
  mintBall,
  registerPlayers,
  seedPokemon,
  userIdentity,
} from './helpers';
import type { MockChainAdapter } from '../src/fabric/mock-chain.adapter';
import type { ContractService } from '../src/fabric/contract.service';
import { SYSTEM_IDENTITY } from '../src/fabric/chain.types';

const ash = userIdentity('ash');

type Ctx = ReturnType<typeof build>;

function build() {
  const { chain, contract } = makeChain();
  const redis = makeRedis();
  const pokemon = makePokemonService(contract, redis);
  return {
    chain,
    contract,
    redis,
    capture: new CaptureService(chain, contract, redis),
    items: new ItemsService(contract, pokemon),
    shop: new ShopService(contract),
  };
}

/** 直接铸一把钥匙（走链上 MintItem，等价于商店购买）。 */
function mintKey(ctx: Ctx, typeId: string, quantity = 1, owner = 'ash') {
  return mintBall(ctx.contract, owner, `i_${typeId}_${randomUUID().slice(0, 8)}`, typeId, quantity);
}

/** 当前进程内的 capture 会话键（ioredis-mock 在同进程内共享数据，断言只看前后差集）。 */
async function captureSessions(ctx: Ctx): Promise<string[]> {
  return (await ctx.redis.client.keys('capture:*')).sort();
}

describe('传说区门控（docs/backend-api.md §2「传说区」）', () => {
  it('无钥匙进入被拒：403 KEY_REQUIRED，消息带 typeId 与中文名，且不建事件、不扣分', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const before = (await ctx.contract.getPlayer('ash')).points;
    const sessionsBefore = await captureSessions(ctx);

    await expect(ctx.capture.encounter(ash, undefined, 0, 'sky-pillar')).rejects.toMatchObject({
      status: 403,
    });
    await expect(ctx.capture.encounter(ash, undefined, 0, 'sky-pillar')).rejects.toThrow(
      /KEY_REQUIRED: .*天空之钥（sky-key）/,
    );
    // 六个传说区都需要各自的钥匙
    for (const [zoneId, keyTypeId] of [
      ['seafloor', 'ocean-key'],
      ['magma', 'magma-key'],
      ['ruins', 'ruins-key'],
      ['southern-island', 'island-key'],
      ['birth-island', 'birth-key'],
    ] as const) {
      await expect(ctx.capture.encounter(ash, undefined, 0, zoneId)).rejects.toThrow(
        new RegExp(`KEY_REQUIRED: .*${getItemType(keyTypeId)!.nameZh}（${keyTypeId}）`),
      );
    }
    // 校验先于 Commit：没有新增 capture 会话、积分不变
    expect(await captureSessions(ctx)).toEqual(sessionsBefore);
    expect((await ctx.contract.getPlayer('ash')).points).toBe(before);
  });

  it('钥匙不匹配也不行（拿海洋之钥进天空之柱 → KEY_REQUIRED）', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await mintKey(ctx, 'ocean-key');
    await expect(ctx.capture.encounter(ash, undefined, 0, 'sky-pillar')).rejects.toThrow(/KEY_REQUIRED/);
    // 换成对应钥匙即可进入
    await mintKey(ctx, 'sky-key');
    const enc = await ctx.capture.encounter(ash, undefined, 0, 'sky-pillar');
    expect(enc.zone).toMatchObject({ id: 'sky-pillar', name: '天空之柱', legendary: true, keyTypeId: 'sky-key' });
  });

  it('钥匙是一次性门票：每次创建传说区遇敌消耗 1 把，用完后 KEY_REQUIRED（H11）', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const key = await mintKey(ctx, 'sky-key', 2);

    for (let i = 0; i < 2; i++) {
      const enc = await ctx.capture.encounter(ash, undefined, 0, 'sky-pillar');
      expect(enc.wild.speciesId).toBe(384);
      expect(enc.wild.level).toBeGreaterThanOrEqual(45);
      expect(enc.wild.level).toBeLessThanOrEqual(50);
      // Commit.meta 记规范 id（审计可复算 n=0/n=1）
      expect(JSON.parse((await ctx.contract.getRandom(enc.eventId)).meta)).toEqual({ zone: 'sky-pillar' });
      expect((await ctx.contract.getItem(key.id)).quantity).toBe(1 - i);
    }

    // 第三把没有 → 403，堆叠保持 0
    await expect(ctx.capture.encounter(ash, undefined, 0, 'sky-pillar')).rejects.toMatchObject({ status: 403 });
    await expect(ctx.capture.encounter(ash, undefined, 0, 'sky-pillar')).rejects.toThrow(/KEY_REQUIRED/);
    expect((await ctx.contract.getItem(key.id)).quantity).toBe(0);
  });

  it('数量为 0 或锁定中的钥匙都不算持有（KEY_REQUIRED）', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const key = await mintKey(ctx, 'magma-key');
    await ctx.contract.consumeItem(ash, key.id, 1, 'test-consume');
    await expect(ctx.capture.encounter(ash, undefined, 0, 'magma')).rejects.toThrow(/KEY_REQUIRED/);

    // 锁定中（押注/交易托管）的堆叠同样不能作为门票
    await mintKey(ctx, 'magma-key');
    const stacks = await ctx.contract.queryItemsByOwner('ash');
    const locked = stacks.find((i) => i.typeId === 'magma-key')!;
    (ctx.chain as unknown as { put: (k: string, v: unknown) => void }).put(`item:${locked.id}`, {
      ...locked,
      status: 'LOCKED_TRADE',
    });
    await expect(ctx.capture.encounter(ash, undefined, 0, 'magma')).rejects.toThrow(/KEY_REQUIRED/);
  });

  it('传说区禁止付费诱饵（LURE_NOT_ALLOWED），不扣费', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await mintKey(ctx, 'sky-key');
    const before = (await ctx.contract.getPlayer('ash')).points;
    const sessionsBefore = await captureSessions(ctx);

    for (const tier of [1, 2]) {
      await expect(ctx.capture.encounter(ash, undefined, tier, 'sky-pillar')).rejects.toMatchObject({ status: 400 });
      await expect(ctx.capture.encounter(ash, undefined, tier, 'sky-pillar')).rejects.toThrow(/LURE_NOT_ALLOWED/);
    }
    expect((await ctx.contract.getPlayer('ash')).points).toBe(before);
    expect(await captureSessions(ctx)).toEqual(sessionsBefore);
  });

  it('等级带：天空之柱 Lv45-50、古代遗迹固定 Lv40、诞生之岛固定 Lv45', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    // 钥匙是一次性门票：按后面的遇敌次数各备足（天空 40 / 遗迹 35 / 诞生 5）
    await mintKey(ctx, 'sky-key', 40);
    await mintKey(ctx, 'ruins-key', 35);
    await mintKey(ctx, 'birth-key', 5);

    const levels = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const enc = await ctx.capture.encounter(ash, undefined, 0, 'sky-pillar');
      expect(enc.wild.level).toBeGreaterThanOrEqual(45);
      expect(enc.wild.level).toBeLessThanOrEqual(50);
      levels.add(enc.wild.level);
    }
    expect([...levels].sort((a, b) => a - b)).toEqual([45, 46, 47, 48, 49, 50]);

    for (let i = 0; i < 5; i++) {
      expect((await ctx.capture.encounter(ash, undefined, 0, 'ruins')).wild.level).toBe(40);
      expect((await ctx.capture.encounter(ash, undefined, 0, 'birth-island')).wild.level).toBe(45);
    }
    // 遗迹池 = 三神柱（等权），抽到的种族必在池内
    const ruinsPool = new Set(zoneSpeciesIds('ruins'));
    for (let i = 0; i < 30; i++) {
      expect(ruinsPool.has((await ctx.capture.encounter(ash, undefined, 0, 'ruins')).wild.speciesId)).toBe(true);
    }
  });

  it('已拥有该区任一传说 → 409 LEGENDARY_OWNED（含锁定中的个体；消息点名种族）', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await mintKey(ctx, 'sky-key');
    await mintKey(ctx, 'ruins-key');

    // 锁在交易/对战里也算"已拥有"
    await seedPokemon(ctx.chain, 'ash', { id: 'p_ray', speciesId: 384, status: 'LOCKED_BATTLE' });
    await expect(ctx.capture.encounter(ash, undefined, 0, 'sky-pillar')).rejects.toMatchObject({ status: 409 });
    await expect(ctx.capture.encounter(ash, undefined, 0, 'sky-pillar')).rejects.toThrow(
      /LEGENDARY_OWNED: 你已经拥有 烈空坐/,
    );

    // 遗迹：拥有三神柱里的任意一只都会挡下整个区
    await seedPokemon(ctx.chain, 'ash', { id: 'p_regi', speciesId: 378, status: 'IDLE' });
    await expect(ctx.capture.encounter(ash, undefined, 0, 'ruins')).rejects.toThrow(/LEGENDARY_OWNED: 你已经拥有 雷吉艾斯/);
    // 别的区不受影响（持有的是雷吉艾斯，不是烈空坐）
    await expect(ctx.capture.encounter(ash, undefined, 0, 'sky-pillar')).rejects.toThrow(/LEGENDARY_OWNED/);
    // 南岛 / 诞生之岛 仍可进入
    await mintKey(ctx, 'island-key');
    expect((await ctx.capture.encounter(ash, undefined, 0, 'southern-island')).wild.speciesId).toBeGreaterThanOrEqual(380);
  });

  it('放生或交易走后可再捕（口径：看当前归属，不看历史）', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash', 'gary');
    await mintKey(ctx, 'sky-key', 2);
    const released = await seedPokemon(ctx.chain, 'ash', { id: 'p_ray2', speciesId: 384, status: 'IDLE' });
    await expect(ctx.capture.encounter(ash, undefined, 0, 'sky-pillar')).rejects.toThrow(/LEGENDARY_OWNED/);

    // ① 放生：ownerId 置空 → 不再算拥有
    await ctx.contract.releasePokemon(ash, released.id);
    const afterRelease = await ctx.capture.encounter(ash, undefined, 0, 'sky-pillar');
    expect(afterRelease.wild.speciesId).toBe(384);

    // ② 交易走：归属换成 gary 后 ash 可再捕
    await seedPokemon(ctx.chain, 'ash', { id: 'p_ray3', speciesId: 384, status: 'IDLE' });
    await expect(ctx.capture.encounter(ash, undefined, 0, 'sky-pillar')).rejects.toThrow(/LEGENDARY_OWNED/);
    await ctx.contract.transferPokemon(ash, 'p_ray3', 'gary');
    const afterTransfer = await ctx.capture.encounter(ash, undefined, 0, 'sky-pillar');
    expect(afterTransfer.wild.speciesId).toBe(384);
  });

  it('世界唯一性只对本人生效：别人的烈空坐不挡我（市场稀缺靠钥匙价格 + 每人一只）', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash', 'gary');
    await mintKey(ctx, 'sky-key');
    await seedPokemon(ctx.chain, 'gary', { id: 'p_gary_ray', speciesId: 384, status: 'IDLE' });
    const enc = await ctx.capture.encounter(ash, undefined, 0, 'sky-pillar');
    expect(enc.wild.speciesId).toBe(384);
  });

  it('全流程：无钥匙被拒 → 买钥匙 → 遇裂空座 → 捕捉 → 钥匙耗尽 403 → 补钥匙再遇 LEGENDARY_OWNED', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');

    // ① 无钥匙
    await expect(ctx.capture.encounter(ash, undefined, 0, 'sky-pillar')).rejects.toThrow(/KEY_REQUIRED/);

    // ② 商店购买天空之钥（1500P；注册送 1000P，先补足积分）
    await ctx.contract.addPoints(SYSTEM_IDENTITY, 'ash', 5000, 'test-grant');
    const bought = await ctx.shop.buy(ash, 'sky-key', 1);
    expect(bought).toMatchObject({ typeId: 'sky-key', nameZh: '天空之钥', unitPrice: 1500, total: 1500 });

    // ③ 遇裂空座（大师球必中，直接走快速捕捉）
    const enc = await ctx.capture.encounter(ash, undefined, 0, 'sky-pillar');
    expect(enc.wild).toMatchObject({ speciesId: 384, nameZh: '烈空坐' });
    const ball = await mintBall(ctx.contract, 'ash', 'i_master_sky', 'master-ball', 1);
    const caught = await ctx.capture.attempt(ash, enc.eventId, ball.id);
    expect(caught.success).toBe(true);
    if (!caught.success) throw new Error('expected capture success');
    expect(caught.pokemon.speciesId).toBe(384);
    expect(caught.pokemon.level).toBe(enc.wild.level);
    expect(caught.pokemon.level).toBeGreaterThanOrEqual(45);

    // ④ 再遇：钥匙已在遇敌时消耗 → 先 403 KEY_REQUIRED（无钥匙优先于归属校验）
    expect((await ctx.contract.getItem(bought.item.id)).quantity).toBe(0);
    await expect(ctx.capture.encounter(ash, undefined, 0, 'sky-pillar')).rejects.toMatchObject({ status: 403 });

    // ⑤ 补一把钥匙再遇：已拥有 → 409，且这把钥匙不被消耗
    const extra = await mintKey(ctx, 'sky-key');
    await expect(ctx.capture.encounter(ash, undefined, 0, 'sky-pillar')).rejects.toMatchObject({ status: 409 });
    await expect(ctx.capture.encounter(ash, undefined, 0, 'sky-pillar')).rejects.toThrow(
      /LEGENDARY_OWNED: 你已经拥有 烈空坐/,
    );
    expect((await ctx.contract.getItem(extra.id)).quantity).toBe(1);
  });

  it('钥匙不可使用、不可在商店回收（避免误操作）', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const key = await mintKey(ctx, 'ruins-key');

    await expect(ctx.items.use(ash, key.id, {})).rejects.toThrow(/NOT_USABLE/);
    await expect(ctx.shop.sell(ash, key.id, 1)).rejects.toThrow(/NOT_SELLABLE/);
    // 道具本体没有被动过（数量/状态不变）
    expect(await ctx.contract.getItem(key.id)).toMatchObject({ quantity: 1, status: 'IDLE' });
  });
});
