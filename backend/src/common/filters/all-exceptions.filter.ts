import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { splitCodedMessage, httpStatusForCode } from '../utils/errors';

/**
 * Unified error shape: { statusCode, code, message }.
 * Chain errors thrown as 'CODE: msg' are passed through with their code preserved.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let raw = 'Internal server error';

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        raw = body;
      } else if (body && typeof body === 'object') {
        const msg = (body as Record<string, unknown>).message;
        raw = Array.isArray(msg) ? msg.join('; ') : String(msg ?? exception.message);
      } else {
        raw = exception.message;
      }
    } else if (exception instanceof Error) {
      raw = exception.message;
    }

    let { code, message } = splitCodedMessage(raw);

    // 链码/适配器异常只有 code、没有 status：按 H8 的语义表映射（未收录保持 500）
    if (!(exception instanceof HttpException)) {
      const mapped = httpStatusForCode(code);
      if (mapped !== undefined) {
        statusCode = mapped;
      } else {
        const hinted = (exception as { statusCode?: unknown })?.statusCode;
        if (typeof hinted === 'number' && hinted >= 400 && hinted < 500) statusCode = hinted;
      }
    }

    if (code === 'INTERNAL_ERROR') {
      // map common framework errors to stable codes
      if (statusCode === HttpStatus.UNAUTHORIZED) code = 'UNAUTHORIZED';
      else if (statusCode === HttpStatus.FORBIDDEN) code = 'FORBIDDEN';
      else if (statusCode === HttpStatus.NOT_FOUND) code = 'NOT_FOUND';
      else if (statusCode === HttpStatus.CONFLICT) code = 'CONFLICT';
      else if (statusCode === HttpStatus.TOO_MANY_REQUESTS) code = 'RATE_LIMITED';
      else if (statusCode < 500) code = 'BAD_REQUEST';
    }
    if (statusCode >= 500) {
      this.logger.error(`${code}: ${message}`, exception instanceof Error ? exception.stack : undefined);
    }

    res.status(statusCode).json({ statusCode, code, message });
  }
}
