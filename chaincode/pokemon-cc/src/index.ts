import { BattleContract } from './contracts/battle.contract';
import { ItemContract } from './contracts/item.contract';
import { PlayerContract } from './contracts/player.contract';
import { PokemonContract } from './contracts/pokemon.contract';
import { RandomContract } from './contracts/random.contract';
import { TradeContract } from './contracts/trade.contract';

export { BattleContract } from './contracts/battle.contract';
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
];
