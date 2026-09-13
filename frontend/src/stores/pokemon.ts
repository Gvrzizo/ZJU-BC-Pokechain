import { defineStore } from 'pinia';
import { getMyItems } from '@/api/items';
import { getMyPokemon, getPokedex } from '@/api/pokemon';
import { ownsRunningShoes } from '@/game/running';
import type { Item, PokedexEntry, Pokemon } from '@/types';

export const usePokemonStore = defineStore('pokemon', {
  state: () => ({
    myPokemon: [] as Pokemon[],
    items: [] as Item[],
    pokedex: [] as PokedexEntry[],
    loading: false,
    error: '',
  }),
  getters: {
    balls: (s): Item[] =>
      s.items.filter((i) => i.typeId.includes('ball') && i.quantity > 0 && i.status === 'IDLE'),
    /** 跑鞋（起始镇妈妈赠送）：持有就能按住 Shift 跑步 */
    hasRunningShoes: (s): boolean => ownsRunningShoes(s.items),
    ownedSpeciesIds: (s): Set<number> => new Set(s.myPokemon.map((p) => p.speciesId)),
  },
  actions: {
    async refreshAll() {
      this.loading = true;
      this.error = '';
      try {
        const [mons, items, dex] = await Promise.all([
          getMyPokemon(),
          getMyItems(),
          getPokedex(),
        ]);
        this.myPokemon = mons;
        this.items = items;
        this.pokedex = dex;
      } catch (e: any) {
        this.error = e?.response?.data?.message ?? '加载失败';
      } finally {
        this.loading = false;
      }
    },
    async refreshItems() {
      this.items = await getMyItems();
    },
    async refreshPokemon() {
      this.myPokemon = await getMyPokemon();
    },
    upsertPokemon(p: Pokemon) {
      const idx = this.myPokemon.findIndex((x) => x.id === p.id);
      if (idx >= 0) this.myPokemon[idx] = p;
      else this.myPokemon.push(p);
    },
  },
});
