import { ItemsService } from '../src/items/items.service';
import { ITEM_TYPES } from '../src/game-data/items.data';
import { SHOP_MAX_QTY, SHOP_PRICES, shopCatalog, shopSellPrice } from '../src/shop/shop.data';
import { ShopService } from '../src/shop/shop.service';
import { makeChain, makePokemonService, makeRedis, mintBall, registerPlayers, userIdentity } from './helpers';
import { ADMIN_IDENTITY } from '../src/fabric/chain.types';

const ash = userIdentity('ash');

/** 传说区钥匙 typeId（kind='key'：可购买、不可使用、不可回收） */
const KEY_TYPE_IDS = ['sky-key', 'ocean-key', 'magma-key', 'ruins-key', 'island-key', 'birth-key'];

function build() {
  const { chain, contract } = makeChain();
  const redis = makeRedis();
  return {
    chain,
    contract,
    shop: new ShopService(contract),
    items: new ItemsService(contract, makePokemonService(contract, redis)),
  };
}

const pointsOf = async (ctx: ReturnType<typeof build>, player = 'ash') =>
  (await ctx.contract.getPlayer(player)).points;

const stacksOf = (ctx: ReturnType<typeof build>, player = 'ash') =>
  ctx.contract.queryItemsByOwner(player);

describe('道具商店：商品表与价目（docs/backend-api.md §3）', () => {
  it('价目表：重平衡后的规格价（精灵球 50 / 高级球 400 / 进化石 800 / 技能机 800 / 银色王冠 1200 / 金色王冠 6000 / 钥匙 1500）', () => {
    expect(SHOP_PRICES).toEqual({
      'poke-ball': 50,
      'great-ball': 150,
      'ultra-ball': 400,
      potion: 50,
      'super-potion': 120,
      'thunder-stone': 800,
      'water-stone': 800,
      'fire-stone': 800,
      'tm-thunderbolt': 800,
      'tm-flamethrower': 800,
      'tm-surf': 800,
      'bottle-cap': 1200,
      'gold-bottle-cap': 6000,
      'rare-candy': 1000,
      'sky-key': 1500,
      'ocean-key': 1500,
      'magma-key': 1500,
      'ruins-key': 1500,
      'island-key': 1500,
      'birth-key': 1500,
    });
    // 回收价 = 半价向下取整，最低 1；非卖品无价；**钥匙一律不可回收**（NOT_SELLABLE）
    expect(shopSellPrice('poke-ball')).toBe(25);
    expect(shopSellPrice('ultra-ball')).toBe(200);
    expect(shopSellPrice('gold-bottle-cap')).toBe(3000);
    expect(shopSellPrice('master-ball')).toBeUndefined();
    for (const keyTypeId of KEY_TYPE_IDS) {
      expect([keyTypeId, SHOP_PRICES[keyTypeId]]).toEqual([keyTypeId, 1500]);
      expect([keyTypeId, shopSellPrice(keyTypeId)]).toEqual([keyTypeId, undefined]);
    }
    // 定价口径：休闲玩家日收入约 100-300P（收服 20 / 击倒 等级×1），王冠是周/月级目标；
    // 钥匙是**一次性**传说区门票（H11），1500 ≈ 数日积累，略贵于银色王冠、远低于金色王冠
    expect(SHOP_PRICES['bottle-cap'] / 300).toBeGreaterThanOrEqual(4);
    expect(SHOP_PRICES['ultra-ball']).toBeLessThan(SHOP_PRICES['bottle-cap']);
    expect(SHOP_PRICES['sky-key']).toBeGreaterThan(SHOP_PRICES['bottle-cap']);
    expect(SHOP_PRICES['sky-key']).toBeLessThan(SHOP_PRICES['gold-bottle-cap']);
  });

  it('GET /shop：全部道具类型都在表里，master-ball 标记为非卖品（库存标记 available=false）', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const catalog = await ctx.shop.catalog('ash');

    expect(catalog.points).toBe(1000);
    expect(catalog.maxQty).toBe(SHOP_MAX_QTY);
    expect(catalog.items.map((i) => i.typeId).sort()).toEqual(Object.keys(ITEM_TYPES).sort());

    const master = catalog.items.find((i) => i.typeId === 'master-ball')!;
    expect(master).toMatchObject({ price: null, sellPrice: null, available: false });
    const ball = catalog.items.find((i) => i.typeId === 'poke-ball')!;
    expect(ball).toMatchObject({ price: 50, sellPrice: 25, available: true });
    expect(shopCatalog().filter((i) => i.available)).toHaveLength(
      Object.keys(SHOP_PRICES).length,
    );
  });
});

describe('道具商店：购买（AddPoints + MintItem）', () => {
  it('购买扣积分、入库并自动合并同 typeId 堆叠', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    expect(await pointsOf(ctx)).toBe(1000);

    const first = await ctx.shop.buy(ash, 'poke-ball', 3);
    expect(first).toMatchObject({ typeId: 'poke-ball', quantity: 3, unitPrice: 50, total: 150, points: 850 });
    expect(first.item.typeId).toBe('poke-ball');

    // 第二次购买同一 typeId：链上自动合并成单一堆叠（数量累加）
    await ctx.shop.buy(ash, 'poke-ball', 2, 'buy-second-0001');
    const stacks = (await stacksOf(ctx)).filter((i) => i.typeId === 'poke-ball');
    expect(stacks).toHaveLength(1);
    expect(stacks[0].quantity).toBe(5);
    expect(await pointsOf(ctx)).toBe(750);
  });

  it('新道具（银色王冠 / 金色王冠 / 神奇糖果）可购买并落正确 typeId', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await ctx.contract.addPoints(ADMIN_IDENTITY, 'ash', 5000, 'test-topup'); // helpers 归一 1000 + 充值 5000

    await ctx.shop.buy(ash, 'bottle-cap', 1);
    await ctx.shop.buy(ash, 'rare-candy', 1, 'buy-candy-00001');
    const stacks = await stacksOf(ctx);
    expect(stacks.find((i) => i.typeId === 'bottle-cap')?.quantity).toBe(1);
    expect(stacks.find((i) => i.typeId === 'rare-candy')?.quantity).toBe(1);
    expect(await pointsOf(ctx)).toBe(6000 - 1200 - 1000);
  });

  it('余额不足：INSUFFICIENT_POINTS，积分与背包都不变', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await expect(ctx.shop.buy(ash, 'gold-bottle-cap', 1)).rejects.toThrow(/INSUFFICIENT_POINTS/);
    expect(await pointsOf(ctx)).toBe(1000);
    expect(await stacksOf(ctx)).toHaveLength(0);
  });

  it('购买重试：响应丢失后余额已花光，同一 idemKey 仍返回首次结果（不被余额校验误拒）', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await ctx.contract.addPoints(ADMIN_IDENTITY, 'ash', 200, 'test-topup'); // 1200 = 刚好一个银色王冠
    const key = 'buy-drain-000001';
    const first = await ctx.shop.buy(ash, 'bottle-cap', 1, key); // 1200 → 0
    expect(first.points).toBe(0);

    const replay = await ctx.shop.buy(ash, 'bottle-cap', 1, key);
    expect(replay.total).toBe(first.total);
    expect(replay.points).toBe(0);
    expect(await pointsOf(ctx)).toBe(0); // 没有二次扣分（也不会有第 2 个王冠）
    expect((await stacksOf(ctx)).filter((i) => i.typeId === 'bottle-cap')).toHaveLength(1);
  });

  it('非卖品 master-ball：NOT_FOR_SALE（不会扣分）', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await expect(ctx.shop.buy(ash, 'master-ball', 1)).rejects.toThrow(/NOT_FOR_SALE/);
    await expect(ctx.shop.buy(ash, 'unknown-item', 1)).rejects.toThrow(/NOT_FOR_SALE/);
    expect(await pointsOf(ctx)).toBe(1000);
  });

  it('传说区钥匙：1500P 上架（一次性门票）、不可回收、不可使用', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await ctx.contract.addPoints(ADMIN_IDENTITY, 'ash', 5000, 'test-topup');

    const bought = await ctx.shop.buy(ash, 'sky-key', 1);
    expect(bought).toMatchObject({ typeId: 'sky-key', nameZh: '天空之钥', unitPrice: 1500, total: 1500, points: 4500 });
    const stack = (await stacksOf(ctx)).find((i) => i.typeId === 'sky-key')!;
    expect(stack).toMatchObject({ quantity: 1, status: 'IDLE' });

    // 不可回收：避免误卖门票，也堵住"买了再卖回"的往返（钥匙在创建遇敌时被消耗）
    await expect(ctx.shop.sell(ash, stack.id, 1)).rejects.toThrow(/NOT_SELLABLE/);
    expect(await pointsOf(ctx)).toBe(4500);
    expect((await ctx.contract.getItem(stack.id)).quantity).toBe(1);

    // 不可使用：误点不会消耗钥匙（消耗只发生在创建传说区遇敌时）
    await expect(ctx.items.use(ash, stack.id, {})).rejects.toThrow(/NOT_USABLE/);
    expect((await ctx.contract.getItem(stack.id)).quantity).toBe(1);

    // 六把钥匙都上架、都不可回收，种类标记为 key（前端据此不显示"使用/卖出"）
    const catalog = await ctx.shop.catalog('ash');
    for (const typeId of KEY_TYPE_IDS) {
      expect(catalog.items.find((i) => i.typeId === typeId)).toMatchObject({
        kind: 'key',
        price: 1500,
        sellPrice: null,
        available: true,
      });
    }
  });

  it('同一 idemKey 重放：不重复扣分、不重复发货', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');

    const key = 'buy-retry-000001';
    const first = await ctx.shop.buy(ash, 'potion', 2, key);
    const replay = await ctx.shop.buy(ash, 'potion', 2, key);
    expect(replay.total).toBe(first.total);
    expect(await pointsOf(ctx)).toBe(1000 - 100); // 只扣一次（伤药 50 × 2）
    const stacks = (await stacksOf(ctx)).filter((i) => i.typeId === 'potion');
    expect(stacks).toHaveLength(1);
    expect(stacks[0].quantity).toBe(2); // 只发一次
  });
});

describe('道具商店：卖出（ConsumeItem + AddPoints 半价回收）', () => {
  it('按半价回收并消耗堆叠，锁定/非卖品/超量分别拒绝', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const stack = await mintBall(ctx.contract, 'ash', 'i_sell_ball', 'great-ball', 4);

    const sold = await ctx.shop.sell(ash, stack.id, 3);
    expect(sold).toMatchObject({ typeId: 'great-ball', quantity: 3, unitPrice: 75, refund: 225, points: 1225 });
    expect(sold.item.quantity).toBe(1);

    // 超量：堆叠只剩 1 个
    await expect(ctx.shop.sell(ash, stack.id, 4)).rejects.toThrow(/INSUFFICIENT_QUANTITY/);
    expect(await pointsOf(ctx)).toBe(1225);

    // 非本人
    await registerPlayers(ctx.contract, 'gary');
    await expect(ctx.shop.sell(userIdentity('gary'), stack.id, 1)).rejects.toThrow(/NOT_OWNER/);

    // 锁定资产（交易/对战托管中）
    const locked = await mintBall(ctx.contract, 'ash', 'i_locked', 'potion', 2);
    (ctx.chain as unknown as { put: (k: string, v: unknown) => void }).put(`item:${locked.id}`, {
      ...locked,
      status: 'LOCKED_TRADE',
      lockRef: 't_demo',
    });
    await expect(ctx.shop.sell(ash, locked.id, 1)).rejects.toThrow(/ASSET_LOCKED/);

    // 非卖品（master-ball 不在价目表里）
    const master = await mintBall(ctx.contract, 'ash', 'i_master_sell', 'master-ball', 1);
    await expect(ctx.shop.sell(ash, master.id, 1)).rejects.toThrow(/NOT_SELLABLE/);
  });

  it('同一 idemKey 重放：不重复销毁、不重复返分（堆叠已减量也不误判超量）', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    const stack = await mintBall(ctx.contract, 'ash', 'i_sell_retry', 'potion', 4);

    const key = 'sell-retry-000001';
    const first = await ctx.shop.sell(ash, stack.id, 3, key); // 4 → 1
    const replay = await ctx.shop.sell(ash, stack.id, 3, key); // 重试时只剩 1 个，仍应返回首次结果
    expect(replay.refund).toBe(first.refund);
    expect(replay.item.quantity).toBe(1);
    expect(await pointsOf(ctx)).toBe(1075); // 伤药回收 25×3，只返一次
    const after = await ctx.contract.getItem(stack.id);
    expect(after.quantity).toBe(1); // 只销毁一次
  });
});
