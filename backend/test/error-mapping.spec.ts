import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { ErrorDetail } from '@hyperledger/fabric-protos/lib/gateway/gateway_pb';
import { Status } from '@hyperledger/fabric-protos/lib/google/rpc/status_pb';
import { Any } from 'google-protobuf/google/protobuf/any_pb.js';
import { FabricChainAdapter } from '../src/fabric/fabric-chain.adapter';
import { CodedError, findCodedMessage, splitCodedMessage } from '../src/common/utils/errors';
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
    ['TRANSFER_LOCKED: player ash cannot transfer points yet', HttpStatus.CONFLICT, 'TRANSFER_LOCKED', 'player ash cannot transfer points yet'],
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

describe('真链 gateway 错误展开（EndorseError.details / cause）', () => {
  it('从 peer 的 "chaincode response 500, CODE: msg" 提取链码错误', () => {
    const raw =
      'failed to endorse transaction, see attached details for more info\n' +
      'chaincode response 500, TRANSFER_LOCKED: player ash cannot transfer points before 2026-10-28T00:00:00.000Z';
    expect(findCodedMessage(raw)).toEqual({
      code: 'TRANSFER_LOCKED',
      message: 'player ash cannot transfer points before 2026-10-28T00:00:00.000Z',
    });
  });

  it('多行 details 取最后一个可识别 code（内层比外层具体）', () => {
    const raw = [
      'failed to endorse transaction, see attached details for more info',
      'chaincode response 500, KEY_REQUIRED: 天空之柱需要天空之钥（sky-key）才能进入',
    ].join('\n');
    expect(findCodedMessage(raw)?.code).toBe('KEY_REQUIRED');
  });

  it('没有 code 时返回 null，splitCodedMessage 仍回退 INTERNAL_ERROR', () => {
    expect(findCodedMessage('context deadline exceeded')).toBeNull();
    expect(splitCodedMessage('context deadline exceeded')).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'context deadline exceeded',
    });
  });
});

describe('FabricChainAdapter 错误展开（gRPC ServiceError.details 是字符串）', () => {
  const adapter = new FabricChainAdapter({} as never, { get: () => true } as never, {} as never);

  it('把 ABORTED 外层文本与 peer 的 chaincode response 细节合并后取内层 code', () => {
    const err = {
      message: '10 ABORTED: failed to endorse transaction, see attached details for more info',
      details:
        'chaincode response 500, TRANSFER_LOCKED: player ash cannot transfer points before 2026-10-28T00:00:00.000Z',
      code: 10,
    };
    const text = (adapter as unknown as { errorText(e: unknown): string }).errorText(err);
    expect(text).toContain('TRANSFER_LOCKED');
    expect(findCodedMessage(text)?.code).toBe('TRANSFER_LOCKED');
  });

  it('也支持解析后的 ErrorDetail[]（GatewayError.details）', () => {
    const err = {
      message: 'failed to endorse transaction',
      details: [{ address: 'peer0', message: 'chaincode response 500, FORBIDDEN: only system', mspId: 'Org1MSP' }],
    };
    const text = (adapter as unknown as { errorText(e: unknown): string }).errorText(err);
    expect(findCodedMessage(text)?.code).toBe('FORBIDDEN');
  });
});

describe('FabricChainAdapter 错误展开（grpc-status-details-bin 元数据）', () => {
  const adapter = new FabricChainAdapter({} as never, { get: () => true } as never, {} as never);

  it('解出 peer 的 google.rpc.Status → ErrorDetail 链码错误', () => {
    const detail = new ErrorDetail();
    detail.setAddress('peer0.org1.pokechain.com:7051');
    detail.setMspId('Org1MSP');
    detail.setMessage('chaincode response 500, TRANSFER_LOCKED: player ash cannot transfer points');
    const anyDetail = new Any();
    anyDetail.setTypeUrl('type.googleapis.com/gateway.ErrorDetail');
    anyDetail.setValue(detail.serializeBinary());
    const status = new Status();
    status.addDetails(anyDetail);
    const metadata = {
      get: (key: string) =>
        key === 'grpc-status-details-bin' ? [Buffer.from(status.serializeBinary())] : [],
    };
    const err = {
      message: '10 ABORTED: failed to endorse transaction, see attached details for more info',
      details: 'failed to endorse transaction, see attached details for more info',
      metadata,
      code: 10,
    };
    const text = (adapter as unknown as { errorText(e: unknown): string }).errorText(err);
    expect(findCodedMessage(text)?.code).toBe('TRANSFER_LOCKED');
    expect(findCodedMessage(text)?.message).toContain('cannot transfer points');
  });
});
