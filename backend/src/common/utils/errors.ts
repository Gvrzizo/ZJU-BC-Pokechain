import { HttpException, HttpStatus } from '@nestjs/common';

const CODE_RE = /^([A-Z][A-Z0-9_]{1,63}):\s?(.*)$/s;

/** Error thrown by chain adapters / business code; message follows 'CODE: human readable'. */
export class CodedError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = HttpStatus.BAD_REQUEST,
  ) {
    super(`${code}: ${message}`);
  }
}

/** Business exception carrying a machine-readable code surfaced as {statusCode, code, message}. */
export class AppException extends HttpException {
  constructor(code: string, message: string, statusCode: number = HttpStatus.BAD_REQUEST) {
    super(`${code}: ${message}`, statusCode);
  }
}

/** Split a 'CODE: message' string (as thrown by the chaincode) into parts. */
export function splitCodedMessage(raw: string): { code: string; message: string } {
  const match = CODE_RE.exec(raw ?? '');
  if (match) {
    return { code: match[1], message: match[2] || raw };
  }
  return { code: 'INTERNAL_ERROR', message: raw };
}

/**
 * 链码错误码 → HTTP 状态（P1-4）。
 *
 * 真链适配器把链码的 `Error("CODE: message")` 透传成只有 `code` 的普通 Error（没有 status），
 * 以前统一落到 500；全局过滤器用这张表映射成稳定语义。业务层已用 `AppException`
 * 携带 status 的路径优先，不看这张表。未收录的 code 保持 500（便于发现漏网错误）。
 *
 * 取向：权限 403；状态/资源冲突 409；入参/余额类 400；实体不存在 404。
 */
export const CHAIN_HTTP_STATUS: Readonly<Record<string, HttpStatus>> = {
  // ---- 权限 / 身份 ----
  NOT_OWNER: HttpStatus.FORBIDDEN,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_ADMIN: HttpStatus.FORBIDDEN,
  NOT_ARBITRATOR: HttpStatus.FORBIDDEN,
  NOT_AUTHORIZED: HttpStatus.FORBIDDEN,
  NOT_PARTY: HttpStatus.FORBIDDEN,
  NOT_HOST: HttpStatus.FORBIDDEN,
  // ---- 不存在 ----
  NOT_FOUND: HttpStatus.NOT_FOUND,
  PLAYER_NOT_FOUND: HttpStatus.NOT_FOUND,
  ITEM_NOT_FOUND: HttpStatus.NOT_FOUND,
  POKEMON_NOT_FOUND: HttpStatus.NOT_FOUND,
  ROOM_NOT_FOUND: HttpStatus.NOT_FOUND,
  TEMPLATE_NOT_FOUND: HttpStatus.NOT_FOUND,
  BATTLE_NOT_FOUND: HttpStatus.NOT_FOUND,
  WILD_SESSION_NOT_FOUND: HttpStatus.NOT_FOUND,
  // ---- 状态机 / 锁定 / 重复 ----
  ASSET_LOCKED: HttpStatus.CONFLICT,
  BAD_STATE: HttpStatus.CONFLICT,
  INVALID_BATTLE_STATE: HttpStatus.CONFLICT,
  INVALID_RANDOM_STATE: HttpStatus.CONFLICT,
  RAND_NOT_REVEALED: HttpStatus.CONFLICT,
  RANDOM_NOT_REVEALED: HttpStatus.CONFLICT,
  RAND_CONSUMED: HttpStatus.CONFLICT,
  EVENT_CONSUMED: HttpStatus.CONFLICT,
  TRADE_NOT_OPEN: HttpStatus.CONFLICT,
  TRADE_EXPIRED: HttpStatus.CONFLICT,
  TRADE_NOT_EXPIRED: HttpStatus.CONFLICT,
  ROOM_NOT_OPEN: HttpStatus.CONFLICT,
  ROOM_NOT_READY: HttpStatus.CONFLICT,
  PLAYER_NOT_IN_ROOM: HttpStatus.CONFLICT,
  SAME_PLAYER: HttpStatus.CONFLICT,
  INSUFFICIENT_QUANTITY: HttpStatus.CONFLICT,
  IV_MAXED: HttpStatus.CONFLICT,
  LEVEL_MAXED: HttpStatus.CONFLICT,
  MOVE_KNOWN: HttpStatus.CONFLICT,
  HP_FULL: HttpStatus.CONFLICT,
  FAINTED: HttpStatus.CONFLICT,
  KEY_REQUIRED: HttpStatus.FORBIDDEN,
  LEGENDARY_OWNED: HttpStatus.CONFLICT,
  WILD_BATTLE_FINISHED: HttpStatus.CONFLICT,
  EVENT_EXISTS: HttpStatus.CONFLICT,
  RAND_EXISTS: HttpStatus.CONFLICT,
  PLAYER_EXISTS: HttpStatus.CONFLICT,
  ITEM_EXISTS: HttpStatus.CONFLICT,
  POKEMON_EXISTS: HttpStatus.CONFLICT,
  TRADE_EXISTS: HttpStatus.CONFLICT,
  BATTLE_EXISTS: HttpStatus.CONFLICT,
  // ---- 入参 / 余额 ----
  INVALID_PARAM: HttpStatus.BAD_REQUEST,
  INVALID_JSON: HttpStatus.BAD_REQUEST,
  INVALID_AMOUNT: HttpStatus.BAD_REQUEST,
  INVALID_TIME: HttpStatus.BAD_REQUEST,
  INVALID_HASH: HttpStatus.BAD_REQUEST,
  INVALID_COMMIT_HASH: HttpStatus.BAD_REQUEST,
  INVALID_IV: HttpStatus.BAD_REQUEST,
  INVALID_LEVEL: HttpStatus.BAD_REQUEST,
  INVALID_EXP: HttpStatus.BAD_REQUEST,
  INVALID_WINNER: HttpStatus.BAD_REQUEST,
  INVALID_OUTCOME: HttpStatus.BAD_REQUEST,
  INSUFFICIENT_POINTS: HttpStatus.BAD_REQUEST,
  SEED_MISMATCH: HttpStatus.BAD_REQUEST,
  PLAYER_MISMATCH: HttpStatus.BAD_REQUEST,
  RAND_PLAYER_MISMATCH: HttpStatus.BAD_REQUEST,
  PURPOSE_MISMATCH: HttpStatus.BAD_REQUEST,
  WAGER_HASH_MISMATCH: HttpStatus.BAD_REQUEST,
  TOO_MANY_MOVES: HttpStatus.BAD_REQUEST,
  IV_DECREASE: HttpStatus.BAD_REQUEST,
  LEVEL_REGRESSION: HttpStatus.BAD_REQUEST,
  OVERFLOW: HttpStatus.BAD_REQUEST,
  NO_EVOLUTION: HttpStatus.BAD_REQUEST,
  LEVEL_TOO_LOW: HttpStatus.BAD_REQUEST,
  NOT_A_STONE: HttpStatus.BAD_REQUEST,
  NOT_A_BALL: HttpStatus.BAD_REQUEST,
  NOT_USABLE: HttpStatus.BAD_REQUEST,
  TARGET_REQUIRED: HttpStatus.BAD_REQUEST,
  FORGET_REQUIRED: HttpStatus.BAD_REQUEST,
  NOT_FOR_SALE: HttpStatus.BAD_REQUEST,
  NOT_SELLABLE: HttpStatus.BAD_REQUEST,
};

/** 链码错误码的 HTTP 状态；未收录返回 undefined（调用方决定回退）。 */
export function httpStatusForCode(code: string): HttpStatus | undefined {
  return CHAIN_HTTP_STATUS[code];
}
