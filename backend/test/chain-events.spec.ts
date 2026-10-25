import { ChainEventsService } from '../src/fabric/chain-events.service';
import { ChainEventPayload } from '../src/fabric/chain.types';

/** P2-2b：known-event subscription filters by name and forwards the payload unchanged. */
function makeService() {
  let listener: ((name: string, payload: ChainEventPayload) => void) | undefined;
  const chain = {
    onChainEvent: (fn: (name: string, payload: ChainEventPayload) => void) => {
      listener = fn;
    },
  };
  const service = new ChainEventsService(chain as never);
  service.onModuleInit();
  return {
    service,
    emit: (name: string, payload: ChainEventPayload) => listener?.(name, payload),
  };
}

describe('ChainEventsService.onEvent（P2-2b 强类型事件订阅）', () => {
  it('只把匹配事件交给回调，payload 原样透传', () => {
    const { service, emit } = makeService();
    const points = jest.fn();
    const merged = jest.fn();
    service.onEvent('PointsChanged', points);
    service.onEvent('ItemMerged', merged);

    emit('PointsChanged', { playerId: 'ash', delta: 50, balance: 1050 });
    emit('ItemMerged', { ownerId: 'ash', typeId: 'poke-ball', id: 'i1', quantity: 10, merged: ['i2'] });
    emit('PokemonMinted', { id: 'p1', ownerId: 'ash' });

    expect(points).toHaveBeenCalledTimes(1);
    expect(points).toHaveBeenCalledWith({ playerId: 'ash', delta: 50, balance: 1050 });
    expect(merged).toHaveBeenCalledTimes(1);
    expect(merged).toHaveBeenCalledWith({
      ownerId: 'ash',
      typeId: 'poke-ball',
      id: 'i1',
      quantity: 10,
      merged: ['i2'],
    });
  });
});
