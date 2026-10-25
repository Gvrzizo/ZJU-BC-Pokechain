import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { CodedError } from '../src/common/utils/errors';
import { makeChain, makePokemonService, makeRedis, registerPlayers, seedPokemon, userIdentity } from './helpers';

/** 用假 host 跑全局异常过滤器，返回实际写出的 status / body。 */
function runFilter(exception: unknown): { statusCode: number; body: Record<string, unknown> } {
  const out = { statusCode: 0, body: {} as Record<string, unknown> };
  const response = {
    status(code: number) {
      out.statusCode = code;
      return {
        json(body: Record<string, unknown>) {
          out.body = body;
        },
      };
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as never;
  new AllExceptionsFilter().catch(exception, host);
  return out;
}

/** 500 会打 error 日志；测试里静音，保持输出干净。 */
beforeAll(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterAll(() => {
  jest.restoreAllMocks();
});

describe('H8 链码错误码 → HTTP 状态（全局过滤器）', () => {
  it.each([
    ['NOT_OWNER: pokemon p is not yours', HttpStatus.FORBIDDEN, 'NOT_OWNER', 'pokemon p is not yours'],
    ['FORBIDDEN: only system', HttpStatus.FORBIDDEN, 'FORBIDDEN', 'only system'],
    ['ASSET_LOCKED: pokemon p is LOCKED_BATTLE', HttpStatus.CONFLICT, 'ASSET_LOCKED', 'pokemon p is LOCKED_BATTLE'],
    ['BAD_STATE: battle b is ACTIVE', HttpStatus.CONFLICT, 'BAD_STATE', 'battle b is ACTIVE'],
    ['BATTLE_NOT_FOUND: no battle x', HttpStatus.NOT_FOUND, 'BATTLE_NOT_FOUND', 'no battle x'],
    ['INSUFFICIENT_POINTS: balance 0', HttpStatus.BAD_REQUEST, 'INSUFFICIENT_POINTS', 'balance 0'],
    ['INVALID_PARAM: bad input', HttpStatus.BAD_REQUEST, 'INVALID_PARAM', 'bad input'],
  ])('%s → %i %s', (message, status, code, detail) => {
    const { statusCode, body } = runFilter(new Error(message));
    expect(statusCode).toBe(status);
    expect(body).toEqual({ statusCode: status, code, message: detail });
  });

  it('未收录的普通 Error 仍是 500（不把真 bug 伪装成 4xx）', () => {
    const { statusCode, body } = runFilter(new Error('SOMETHING_WEIRD: boom'));
    expect(statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body).toMatchObject({ code: 'SOMETHING_WEIRD', message: 'boom' });
  });

  it('带 statusCode 的 CodedError（Mock 适配器）未收录时沿用其 4xx 提示', () => {
    const { statusCode } = runFilter(new CodedError('MOCK_ONLY_CODE', 'mock detail'));
    expect(statusCode).toBe(HttpStatus.BAD_REQUEST);
  });

  it('HttpException 的 status 优先于语义表（业务层已带状态）', () => {
    const { statusCode, body } = runFilter(
      new HttpException('TOO_MANY_REQUESTS: slow down', HttpStatus.TOO_MANY_REQUESTS),
    );
    expect(statusCode).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(body).toMatchObject({ code: 'TOO_MANY_REQUESTS', message: 'slow down' });
  });

  it('真实链路：train 积分不足不再 500（CodedError → 400 INSUFFICIENT_POINTS）', async () => {
    const { chain, contract } = makeChain();
    await registerPlayers(contract, 'ash');
    await seedPokemon(chain, 'ash', { id: 'p_train_broke' });
    const pokemon = makePokemonService(contract, makeRedis());
    const err = await pokemon.train(userIdentity('ash'), 'p_train_broke', 5000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);

    const { statusCode, body } = runFilter(err);
    expect(statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(body).toMatchObject({ statusCode: HttpStatus.BAD_REQUEST, code: 'INSUFFICIENT_POINTS' });
    expect(String(body.message)).toContain('balance');
  });
});
