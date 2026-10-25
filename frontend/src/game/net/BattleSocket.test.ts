import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const ioMock = vi.fn();
vi.mock('socket.io-client', () => ({ io: (...args: unknown[]) => ioMock(...args) }));

import { BattleSocket, LobbySocket } from './BattleSocket';
import { useAuthStore } from '@/stores/auth';
import { useBattleStore } from '@/stores/battle';

interface FakeSocket {
  on: ReturnType<typeof vi.fn>;
  io: { on: ReturnType<typeof vi.fn> };
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  handlers: Map<string, (payload: unknown) => void>;
}

function makeSocket(): FakeSocket {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    on: vi.fn((event: string, fn: (payload: unknown) => void) => {
      handlers.set(event, fn);
    }),
    io: { on: vi.fn() },
    emit: vi.fn(),
    disconnect: vi.fn(),
    handlers,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  ioMock.mockReset();
});

describe('BattleSocket 鉴权与重连（H16）', () => {
  it('auth 回调每次取当前 token：重连不会带过期 token', () => {
    const socket = makeSocket();
    ioMock.mockReturnValue(socket);
    const auth = useAuthStore();
    auth.accessToken = 'tok-old';

    new BattleSocket().connect('b_1');
    const options = ioMock.mock.calls[0][1] as { auth: (cb: (v: unknown) => void) => void };
    const cb = vi.fn();
    options.auth(cb);
    expect(cb).toHaveBeenLastCalledWith({ token: 'tok-old' });

    auth.accessToken = 'tok-new';
    options.auth(cb);
    expect(cb).toHaveBeenLastCalledWith({ token: 'tok-new' });
  });

  it('connect_error 为鉴权失败时提示并停止重连', () => {
    const socket = makeSocket();
    ioMock.mockReturnValue(socket);
    new BattleSocket().connect('b_1');

    socket.handlers.get('connect_error')!(new Error('jwt expired'));
    expect(useBattleStore().lastError).toBe('UNAUTHORIZED');
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('非鉴权的 connect_error 不主动断开（网络抖动交给自动重连）', () => {
    const socket = makeSocket();
    ioMock.mockReturnValue(socket);
    new BattleSocket().connect('b_1');

    socket.handlers.get('connect_error')!(new Error('xhr poll error'));
    expect(useBattleStore().lastError).toBe('');
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('LobbySocket 同样使用动态 token 回调', () => {
    const socket = makeSocket();
    ioMock.mockReturnValue(socket);
    const auth = useAuthStore();
    auth.accessToken = 'tok-lobby';

    new LobbySocket().connect();
    const options = ioMock.mock.calls[0][1] as { auth: (cb: (v: unknown) => void) => void };
    const cb = vi.fn();
    options.auth(cb);
    expect(cb).toHaveBeenLastCalledWith({ token: 'tok-lobby' });
  });
});
