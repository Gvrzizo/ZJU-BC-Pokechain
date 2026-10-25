import { Injectable, OnModuleInit } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { filter } from 'rxjs/operators';
import { ChainAdapter } from './chain.adapter';
import { ChainEventMap, ChainEventName, ChainEventPayload } from './chain.types';

export interface ChainEvent {
  name: string;
  payload: ChainEventPayload;
}

/**
 * Fan-out for chain events. The adapter (Fabric: chain event listener,
 * Mock: direct callback) feeds this stream; the battle gateway and cache
 * invalidation subscribe to it.
 *
 * 已知事件优先用 `onEvent` 订阅（P2-2b）：事件名校验 + payload 强类型，
 * 避免消费方手写 `['PointsChanged', ...].includes(name)` 字符串表。
 */
@Injectable()
export class ChainEventsService implements OnModuleInit {
  private readonly subject = new Subject<ChainEvent>();
  readonly stream$: Observable<ChainEvent> = this.subject.asObservable();

  constructor(private readonly chain: ChainAdapter) {}

  onModuleInit(): void {
    this.chain.onChainEvent((name, payload) => this.subject.next({ name, payload }));
  }

  /** 订阅单个已知链上事件；回调里的 payload 是对应事件的判别类型。 */
  onEvent<K extends ChainEventName>(name: K, handler: (payload: ChainEventMap[K]) => void): void {
    this.stream$
      .pipe(filter((event) => event.name === name))
      .subscribe((event) => handler(event.payload as ChainEventMap[K]));
  }
}
