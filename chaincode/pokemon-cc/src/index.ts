import { BattleContract } from './contracts/battle.contract';
// --- [FEAT:breeding] begin ---
import { BreedingContract } from './contracts/breeding.contract';
// --- [FEAT:breeding] end ---
import { HistoryContract } from './contracts/history.contract';
import { ItemContract } from './contracts/item.contract';
import { PlayerContract } from './contracts/player.contract';
import { PokemonContract } from './contracts/pokemon.contract';
import { RandomContract } from './contracts/random.contract';
import { TradeContract } from './contracts/trade.contract';

export { BattleContract } from './contracts/battle.contract';
// --- [FEAT:breeding] begin ---
export { BreedingContract } from './contracts/breeding.contract';
// --- [FEAT:breeding] end ---
export { HistoryContract } from './contracts/history.contract';
export { ItemContract } from './contracts/item.contract';
export { PlayerContract } from './contracts/player.contract';
export { PokemonContract } from './contracts/pokemon.contract';
export { RandomContract } from './contracts/random.contract';
export { TradeContract } from './contracts/trade.contract';

export const contracts: any[] = [
  PlayerContract,
  RandomContract,
  PokemonContract,
  ItemContract,
  TradeContract,
  BattleContract,
  // --- [FEAT:history] begin ---
  HistoryContract,
  // --- [FEAT:history] end ---
  // --- [FEAT:breeding] begin ---
  BreedingContract,
  // --- [FEAT:breeding] end ---
];
