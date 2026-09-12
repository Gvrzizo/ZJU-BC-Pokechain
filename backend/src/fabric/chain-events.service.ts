import { Injectable, OnModuleInit } from '@nestjs/common';
import { Subject } from 'rxjs';
import { ChainAdapter } from './chain.adapter';
import { ChainEventPayload } from './chain.types';

export interface ChainEvent {
  name: string;
  payload: ChainEventPayload;
}

/**
 * Fan-out for chain events. The adapter (Fabric: chain event listener,
 * Mock: direct callback) feeds this stream; the battle gateway and cache
 * invalidation subscribe to it.
 */
@Injectable()
export class ChainEventsService implements OnModuleInit {
  private readonly subject = new Subject<ChainEvent>();
  readonly stream$ = this.subject.asObservable();

  constructor(private readonly chain: ChainAdapter) {}

  onModuleInit(): void {
    this.chain.onChainEvent((name, payload) => this.subject.next({ name, payload }));
  }
}
