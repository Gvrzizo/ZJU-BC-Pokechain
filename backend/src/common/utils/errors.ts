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
