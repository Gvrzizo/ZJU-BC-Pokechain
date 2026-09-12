/* eslint-disable no-console */
/**
 * Demo seed: npm run seed
 *  - users ash / gary (player, password demo1234), arbiter (role=arbitrator,
 *    Org2MSP attr in fabric mode; directly flagged in mock mode), admin
 *  - on-chain RegisterPlayer for each (+ GrantRole arbitrator for arbiter)
 *  - poke balls / stones for ash & gary
 *  - a few minted pokemon per player via the full Commit->Reveal->Mint flow
 *
 * Fully idempotent: every mint uses a deterministic id/eventId plus a fixed
 * idemKey, so reruns replay the first result instead of duplicating assets
 * (seeds must be deterministic because RevealAndVerify rechecks sha256(serverSeed)).
 *
 * Requires PG + Redis (and FABRIC_MOCK=true unless a network is up).
 */
import { NestFactory } from '@nestjs/core';
import * as argon2 from 'argon2';
import { AppModule } from '../app.module';
import { UsersService } from '../users/users.service';
import { ContractService } from '../fabric/contract.service';
import { ADMIN_IDENTITY, SYSTEM_IDENTITY } from '../fabric/chain.types';
import { sha256hex, DeriveStream } from '../common/utils/crypto.util';
import { NATURES } from '../game-data/natures.data';
import { getSpecies } from '../game-data/species.data';

const SEED_VERSION = 'v1';

/** Stable value for one seed field (reruns must replay the same commit/reveal). */
function seedHex(scope: string, ...parts: Array<string | number>): string {
  return sha256hex(`pokechain-seed|${SEED_VERSION}|${scope}|${parts.join('|')}`);
}

async function mintPokemonFor(
  contract: ContractService,
  owner: string,
  speciesId: number,
  level: number,
): Promise<void> {
  const species = getSpecies(speciesId);
  if (!species) throw new Error(`unknown species ${speciesId}`);
  const scope = `${owner}-${speciesId}`;
  const eventId = `ev_seed_${SEED_VERSION}_${scope}`;
  const serverSeed = seedHex('server', owner, speciesId);
  const clientSeed = seedHex('client', owner, speciesId);
  const id = `p_seed_${SEED_VERSION}_${scope}`;
  await contract.commitRandom(
    SYSTEM_IDENTITY,
    {
      eventId,
      purpose: 'capture',
      playerId: owner,
      commitHash: sha256hex(serverSeed),
      clientSeed,
    },
    { idemKey: `seed-${SEED_VERSION}-commit-${scope}` },
  );
  await contract.revealAndVerify(SYSTEM_IDENTITY, eventId, serverSeed, {
    idemKey: `seed-${SEED_VERSION}-reveal-${scope}`,
  });
  const stream = new DeriveStream(serverSeed, clientSeed, eventId);
  const iv = (n: number) => Math.floor(stream.at(n) * 32);
  await contract.mintFromCapture(
    SYSTEM_IDENTITY,
    {
      id,
      playerId: owner,
      speciesId: species.id,
      name: species.name,
      ivs: { hp: iv(1), atk: iv(2), def: iv(3), spatk: iv(4), spdef: iv(5), speed: iv(6) },
      nature: NATURES[Math.floor(stream.at(7) * NATURES.length) % NATURES.length],
      ability: species.ability,
      shiny: stream.at(8) < 1 / 4096,
      moves: species.defaultMoves.slice(0, 4),
      dnaHash: sha256hex(`${speciesId}|${eventId}|seed`),
      eventId,
    },
    { idemKey: `seed-${SEED_VERSION}-pokemon-${scope}` },
  );
  if (level > 5) {
    await contract.applyGrowth(SYSTEM_IDENTITY, id, { level }, {
      idemKey: `seed-${SEED_VERSION}-growth-${scope}`,
    });
  }
  console.log(`  ensured ${species.name} (lv${level}) for ${owner}`);
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const users = app.get(UsersService);
    const contract = app.get(ContractService);

    const passwordHash = await argon2.hash('demo1234');
    const accounts = [
      { username: 'ash', nickname: '小智', role: 'player', msp: 'Org1MSP' },
      { username: 'gary', nickname: '小茂', role: 'player', msp: 'Org1MSP' },
      { username: 'arbiter', nickname: '仲裁员', role: 'arbitrator', msp: 'Org2MSP' },
      { username: 'admin', nickname: '管理员', role: 'admin', msp: 'Org1MSP' },
    ];

    for (const acc of accounts) {
      let user = await users.findByUsername(acc.username);
      if (!user) {
        user = users.create({
          username: acc.username,
          nickname: acc.nickname,
          passwordHash,
          role: acc.role,
          fabricMspId: acc.msp,
        });
        await users.save(user);
        console.log(`created user ${acc.username} (role=${acc.role}, msp=${acc.msp})`);
      }
      await contract.registerPlayer(ADMIN_IDENTITY, acc.username, acc.nickname, {
        idemKey: `register-${acc.username}`,
      });
    }
    await contract.grantRole(ADMIN_IDENTITY, 'arbiter', 'arbitrator', { idemKey: 'grant-arbiter' });
    console.log('granted on-chain role arbitrator to arbiter');

    const items: Array<[string, string, number]> = [
      ['ash', 'poke-ball', 10],
      ['ash', 'great-ball', 5],
      ['gary', 'poke-ball', 10],
      ['gary', 'ultra-ball', 3],
      ['ash', 'potion', 3],
      ['gary', 'potion', 3],
      ['ash', 'thunder-stone', 1],
    ];
    for (const [playerId, typeId, quantity] of items) {
      const scope = `${playerId}-${typeId}`;
      await contract.mintItem(
        SYSTEM_IDENTITY,
        {
          id: `i_seed_${SEED_VERSION}_${scope}`,
          playerId,
          typeId,
          quantity,
          uri: `minio://assets/items/${typeId}.png`,
          metadataHash: sha256hex(`${typeId}|seed`),
        },
        { idemKey: `seed-${SEED_VERSION}-item-${scope}` },
      );
    }
    console.log('ensured demo items');

    await mintPokemonFor(contract, 'ash', 25, 18); // pikachu
    await mintPokemonFor(contract, 'ash', 6, 36); // charizard
    await mintPokemonFor(contract, 'gary', 9, 34); // blastoise
    await mintPokemonFor(contract, 'gary', 133, 16); // eevee
    await mintPokemonFor(contract, 'gary', 94, 30); // gengar

    console.log('seed complete. login: ash/gary/arbiter/admin, password demo1234');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
