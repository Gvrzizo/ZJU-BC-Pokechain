import { DeriveStream, sha256hex } from '../src/common/utils/crypto.util';
import { computeDamage, critCheck, damageFactor } from '../src/battles/engine/battle-math';
import { getMove } from '../src/game-data/moves.data';
import { getSpecies } from '../src/game-data/species.data';
import { computeStats, emptyEvs, normalizeEvs } from '../src/game-data/stats';
import { typeEffectiveness } from '../src/game-data/type-chart';
import { PokemonState } from '../src/fabric/chain.types';
import { CaptureService } from '../src/pokemon/capture.service';
import { deriveWildSpecimen, deriveWildTurn } from '../src/pokemon/capture-derive';
import { WildService } from '../src/wild/wild.service';
import {
  makeBondService,
  makeChain,
  makePokemonService,
  makeRedis,
  registerPlayers,
  seedPokemon,
  userIdentity,
} from './helpers';

/**
 * 野怪战斗的羁绊加成（docs/backend-api.md §11.2）：`wild.service::toCombatant` 把链上 `bond`
 * 传给 `computeStats`，PvE 的最终能力值（非 HP 五项）与 PvP 同一口径。
 */

const SERVER_SEED = 'aa'.repeat(32);
const WILD_LEVEL = 20;
const ash = userIdentity('ash');

function build() {
  const { chain, contract } = makeChain();
  const redis = makeRedis();
  const capture = new CaptureService(chain, contract, redis);
  const wild = new WildService(contract, capture, makePokemonService(contract, redis), makeBondService(contract, redis), redis);
  return { chain, contract, redis, capture, wild };
}

/** 同一个体（只有 bond 不同）对同一野怪的第一回合出招（tackle）伤害——会话与派生流完全确定。 */
async function firstTurnDamage(bond: number) {
  const ctx = build();
  await registerPlayers(ctx.contract, 'ash');
  const mon = await seedPokemon(ctx.chain, 'ash', {
    id: `p_bond_${bond}`,
    speciesId: 149, // 快龙：物攻高，+5% 后伤害差异明显
    level: 40,
    bond,
    moves: ['tackle'],
  });
  const eventId = `ev_wild_bond_${bond}`;
  const clientSeed = '0000000000000000';
  await ctx.contract.commitRandom(ash, {
    eventId,
    purpose: 'capture',
    playerId: 'ash',
    commitHash: sha256hex(SERVER_SEED),
    clientSeed,
  });
  await ctx.redis.setJson(`capture:${eventId}`, {
    playerId: 'ash',
    serverSeed: SERVER_SEED,
    clientSeed,
    attempts: 0,
    speciesId: 25,
    wildLevel: WILD_LEVEL,
  });

  const started = await ctx.wild.start(ash, eventId, mon.id);
  const after = await ctx.wild.action(ash, started.sessionId, { type: 'move', moveId: 'tackle' });
  const damage = after.log
    .flatMap((t) => t.events)
    .find((e) => e.kind === 'damage' && e.side === 'player')!.detail.damage;
  return { eventId, clientSeed, mon, damage };
}

/** 用纯函数复算期望伤害：攻击力按 `computeStats(..., bond)` 取（掷点取自同一派生流）。 */
function expectedDamage(eventId: string, clientSeed: string, mon: PokemonState): number {
  const stream = new DeriveStream(SERVER_SEED, clientSeed, eventId);
  const rolls = deriveWildTurn(stream, 1);
  const specimen = deriveWildSpecimen(stream);
  const wild = getSpecies(25)!;
  const wildDef = computeStats(wild.base, specimen.ivs, emptyEvs(), WILD_LEVEL, specimen.nature).def;
  const species = getSpecies(mon.speciesId)!;
  const attack = computeStats(species.base, mon.ivs, normalizeEvs(mon.evs), mon.level, mon.nature, mon.bond ?? 0).atk;
  const move = getMove('tackle')!;
  return computeDamage({
    level: mon.level,
    power: move.power,
    attack,
    defense: wildDef,
    effectiveness: typeEffectiveness(move.type, wild.type),
    crit: critCheck(rolls.player.crit),
    factor: damageFactor(rolls.player.factor),
  });
}

describe('野怪战斗吃羁绊加成（wild.service::toCombatant，docs/backend-api.md §11.2）', () => {
  it('bond 0 与 bond 255 的伤害不同，且各自等于按该羁绊算出的最终攻击力的伤害', async () => {
    const zero = await firstTurnDamage(0);
    const full = await firstTurnDamage(255);

    expect(expectedDamage(zero.eventId, zero.clientSeed, zero.mon)).toBe(zero.damage);
    expect(expectedDamage(full.eventId, full.clientSeed, full.mon)).toBe(full.damage);
    // 数据健全性：满羁绊 +5% 非 HP 五项后物攻更高，伤害也更高
    const species = getSpecies(149)!;
    const atk = (mon: PokemonState, bond: number) =>
      computeStats(species.base, mon.ivs, normalizeEvs(mon.evs), mon.level, mon.nature, bond).atk;
    expect(atk(full.mon, 255)).toBeGreaterThan(atk(full.mon, 0));
    expect(full.damage).toBeGreaterThan(zero.damage);
  });

  it('HP 不吃羁绊：满血上限只由种族值/IV/EV/等级/性格决定', async () => {
    const zero = await firstTurnDamage(0);
    const full = await firstTurnDamage(255);
    const species = getSpecies(149)!;
    const hp = (mon: PokemonState, bond: number) =>
      computeStats(species.base, mon.ivs, normalizeEvs(mon.evs), mon.level, mon.nature, bond).hp;
    expect(hp(full.mon, 255)).toBe(hp(full.mon, 0));
    expect(hp(zero.mon, 0)).toBe(hp(zero.mon, 255));
  });
});
