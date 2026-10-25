import { HttpException } from '@nestjs/common';
import { makeChain, makePokemonService, makeRedis, registerPlayers, seedPokemon } from './helpers';

function build() {
  const { chain, contract } = makeChain();
  const redis = makeRedis();
  return { chain, contract, pokemon: makePokemonService(contract, redis) };
}

/**
 * H1（docs/review-2026-10-25.md §2.1.4）：`GET /pokemon/:id` 只校验「登录」不校验「归属」，
 * 任意玩家可读他人 IV/EV/性格（BOLA）。修复后：非本人一律 404，不返回私密养成数据。
 */
describe('宝可梦详情归属校验（H1 BOLA）', () => {
  it('本人可读完整详情：ivs/evs/nature/level/renameCount 都在', async () => {
    const { chain, contract, pokemon } = build();
    await registerPlayers(contract, 'ash', 'gary');
    await seedPokemon(chain, 'ash', {
      id: 'p_mine',
      ivs: { hp: 31, atk: 0, def: 12, spatk: 30, spdef: 3, speed: 25 },
      nature: 'timid',
      level: 42,
    });
    const detail = await pokemon.getOneForUser('p_mine', 'ash');
    expect(detail).toMatchObject({ id: 'p_mine', ownerId: 'ash', level: 42, nature: 'timid', renameCount: 0 });
    expect(detail.ivs).toEqual({ hp: 31, atk: 0, def: 12, spatk: 30, spdef: 3, speed: 25 });
    expect(detail.evs).toBeDefined();
    expect(detail.stats?.hp).toBeGreaterThan(0);
    expect(detail.currentHp).toBeGreaterThan(0);
  });

  it('他人读取 → 404 NOT_FOUND（不泄露 IV/EV/性格，也不泄露资产是否存在）', async () => {
    const { chain, contract, pokemon } = build();
    await registerPlayers(contract, 'ash', 'gary');
    await seedPokemon(chain, 'ash', { id: 'p_bola' });

    const err = await pokemon.getOneForUser('p_bola', 'gary').catch((e: HttpException) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(404);
    expect((err as HttpException).message).toMatch(/^NOT_FOUND:/);
    // 错误信息里不带 owner，避免二次泄露
    expect((err as HttpException).message).not.toContain('ash');

    // 不存在的 id 与「别人的 id」返回同样的 404（不可枚举）
    const missing = await pokemon
      .getOneForUser('p_does_not_exist', 'gary')
      .catch((e: HttpException) => e);
    expect((missing as HttpException).getStatus()).toBe(404);
  });

  it('交易/押注锁定期间仍只有本人可读；放生后对原 owner 也是 404', async () => {
    const { chain, contract, pokemon } = build();
    await registerPlayers(contract, 'ash', 'gary');
    const mon = await seedPokemon(chain, 'ash', { id: 'p_locked' });
    const released = await seedPokemon(chain, 'ash', { id: 'p_released' });
    // 进入交易锁定（ash 自己的 offer）
    await contract.createTrade(
      { userId: 'ash', role: 'player', mspId: 'Org1MSP' },
      {
        id: 't_access',
        fromId: 'ash',
        toId: 'gary',
        offer: { pokemonIds: [mon.id], itemIds: [], points: 0 },
        request: { pokemonIds: [], itemIds: [], points: 0 },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    );
    expect((await pokemon.getOneForUser(mon.id, 'ash')).status).toBe('LOCKED_TRADE');
    await expect(pokemon.getOneForUser(mon.id, 'gary')).rejects.toThrow(/^NOT_FOUND:/);

    // 放生后 ownerId 清空 → 任何请求者（含原 owner）都 404
    await contract.releasePokemon({ userId: 'ash', role: 'player', mspId: 'Org1MSP' }, released.id);
    await expect(pokemon.getOneForUser(released.id, 'ash')).rejects.toThrow(/^NOT_FOUND:/);
  });
});
