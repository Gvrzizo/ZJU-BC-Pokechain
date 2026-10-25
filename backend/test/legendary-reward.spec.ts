import { ZONES } from '../src/game-data/encounter.data';
import { grantLegendaryDexReward, legendaryDexItemId } from '../src/pokemon/legendary-reward';
import { makeChain, registerPlayers, seedPokemon } from './helpers';

function build() {
  const { chain, contract } = makeChain();
  return { chain, contract };
}

/** 六个传说区各取池内第一只，铸造到玩家名下。 */
async function mintLegendaries(chain: ReturnType<typeof build>['chain'], owner: string, count = 6) {
  const zones = ZONES.filter((zone) => zone.legendary === true).slice(0, count);
  for (const [index, zone] of zones.entries()) {
    await seedPokemon(chain, owner, {
      id: `p_dex_${index}`,
      speciesId: (zone.poolSpeciesIds ?? [25])[0],
    });
  }
  return zones;
}

describe('H13 传说图鉴 6/6 → 大师球（玩家侧来源）', () => {
  it('六个传说区各有一只 → 发 1 个大师球；重复调用幂等不叠加', async () => {
    const { chain, contract } = build();
    await registerPlayers(contract, 'ash');
    await mintLegendaries(chain, 'ash');

    expect(await grantLegendaryDexReward(contract, 'ash')).toBe(true);
    let stacks = (await contract.queryItemsByOwner('ash')).filter((item) => item.typeId === 'master-ball');
    expect(stacks).toHaveLength(1);
    expect(stacks[0]).toMatchObject({ quantity: 1, status: 'IDLE', ownerId: 'ash', id: legendaryDexItemId('ash') });

    // 重放（同一固定 idemKey）：不再发第二个
    expect(await grantLegendaryDexReward(contract, 'ash')).toBe(true);
    stacks = (await contract.queryItemsByOwner('ash')).filter((item) => item.typeId === 'master-ball');
    expect(stacks).toHaveLength(1);
    expect(stacks[0].quantity).toBe(1);
  });

  it('缺少任一传说区 → 不发；补上一只后才发', async () => {
    const { chain, contract } = build();
    await registerPlayers(contract, 'ash');
    const zones = await mintLegendaries(chain, 'ash', 5);
    expect(await grantLegendaryDexReward(contract, 'ash')).toBe(false);
    expect((await contract.queryItemsByOwner('ash')).filter((item) => item.typeId === 'master-ball')).toHaveLength(0);

    const missing = ZONES.filter((zone) => zone.legendary === true)[5];
    await seedPokemon(chain, 'ash', { id: 'p_dex_missing', speciesId: (missing.poolSpeciesIds ?? [25])[0] });
    expect(await grantLegendaryDexReward(contract, 'ash')).toBe(true);
    expect(
      (await contract.queryItemsByOwner('ash')).filter((item) => item.typeId === 'master-ball'),
    ).toHaveLength(1);
    expect(zones).toHaveLength(5);
  });
});
