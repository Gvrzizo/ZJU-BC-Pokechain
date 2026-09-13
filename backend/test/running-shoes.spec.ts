import { HttpStatus } from '@nestjs/common';
import { ItemsService } from '../src/items/items.service';
import { getItemType } from '../src/game-data/items.data';
import { shopCatalog, shopPrice, shopSellPrice } from '../src/shop/shop.data';
import {
  RUNNING_SHOES_TYPE_ID,
  RUNNING_SPEED_MULTIPLIER,
  RunningShoesService,
  runningShoesItemId,
} from '../src/users/running-shoes.service';
import { StarterService } from '../src/users/starter.service';
import { makeChain, makePokemonService, makeRedis, registerPlayers, userIdentity } from './helpers';

const ash = userIdentity('ash');
const gary = userIdentity('gary');

function build() {
  const { chain, contract } = makeChain();
  const redis = makeRedis();
  const starters = new StarterService(contract, redis);
  return {
    chain,
    contract,
    redis,
    starters,
    shoes: new RunningShoesService(contract, starters),
    items: new ItemsService(contract, makePokemonService(contract, redis)),
  };
}

const shoesOf = async (ctx: ReturnType<typeof build>, player = 'ash') =>
  (await ctx.contract.queryItemsByOwner(player)).filter((i) => i.typeId === RUNNING_SHOES_TYPE_ID);

describe('跑鞋（起始镇妈妈赠送，docs/backend-api.md §3）', () => {
  it('道具类型：kind=key、中文名「跑鞋」、不上架也不可回收', () => {
    const type = getItemType(RUNNING_SHOES_TYPE_ID);
    expect(type).toMatchObject({ name: 'Running Shoes', nameZh: '跑鞋', kind: 'key' });

    // 不在价目表里：购买抛 NOT_FOR_SALE，回收价 undefined → NOT_SELLABLE
    expect(shopPrice(RUNNING_SHOES_TYPE_ID)).toBeUndefined();
    expect(shopSellPrice(RUNNING_SHOES_TYPE_ID)).toBeUndefined();
    const entry = shopCatalog().find((i) => i.typeId === RUNNING_SHOES_TYPE_ID)!;
    expect(entry).toMatchObject({ price: null, sellPrice: null, available: false });
  });

  it('首次领取：铸造一份跑鞋，ID 确定到玩家名，返回速度倍率', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');

    const res = await ctx.shoes.claim(ash);

    expect(res.claimed).toBe(true);
    expect(res.speedMultiplier).toBe(RUNNING_SPEED_MULTIPLIER);
    expect(res.item).toMatchObject({
      id: runningShoesItemId('ash'),
      typeId: RUNNING_SHOES_TYPE_ID,
      ownerId: 'ash',
      quantity: 1,
      status: 'IDLE',
    });
    expect(await shoesOf(ctx)).toHaveLength(1);
  });

  it('重复领取幂等：返回已有那一份（claimed=false），不重复发放、不报错', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');

    const first = await ctx.shoes.claim(ash);
    const again = await ctx.shoes.claim(ash);
    const third = await ctx.shoes.claim(ash);

    expect(again.claimed).toBe(false);
    expect(third.claimed).toBe(false);
    expect(again.item).toEqual(first.item);
    expect(third.item.id).toBe(first.item.id);
    // 链上只有一份（数量 1，没有被重复铸造堆起来）
    expect(await shoesOf(ctx)).toMatchObject([{ id: first.item.id, quantity: 1 }]);
  });

  it('老账号（已注册但没领过）同样能领；不同玩家各自一份、ID 不同', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash', 'gary');

    const mine = await ctx.shoes.claim(ash);
    const yours = await ctx.shoes.claim(gary);

    expect(mine.claimed).toBe(true);
    expect(yours.claimed).toBe(true);
    expect(mine.item.id).not.toBe(yours.item.id);
    expect(await shoesOf(ctx, 'ash')).toHaveLength(1);
    expect(await shoesOf(ctx, 'gary')).toHaveLength(1);
  });

  it('跑鞋不可使用（NOT_USABLE），也不影响背包里其它道具', async () => {
    const ctx = build();
    await registerPlayers(ctx.contract, 'ash');
    await ctx.contract.mintItem(
      { mspId: 'Org1MSP', role: 'system', userId: 'system' },
      {
        id: 'i_potion_1',
        playerId: 'ash',
        typeId: 'potion',
        quantity: 1,
        uri: 'minio://assets/items/potion.png',
        metadataHash: 'x',
      },
      { idemKey: 'mint-potion-1' },
    );
    const { item } = await ctx.shoes.claim(ash);

    await expect(ctx.items.use(ash, item.id, {})).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
    expect((await ctx.contract.getItem('i_potion_1')).quantity).toBe(1);
  });
});
