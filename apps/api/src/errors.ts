import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import type { Response } from 'express';
export class BusinessError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
    public field?: string,
    public retryable = false,
  ) {
    super(message);
  }
}
export function requireRule(
  condition: unknown,
  code: string,
  message: string,
  status = 409,
): asserts condition {
  if (!condition) throw new BusinessError(code, message, status);
}
@Catch()
export class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const oversized =
      typeof error === 'object' &&
      error !== null &&
      (('status' in error && error.status === 413) ||
        ('statusCode' in error && error.statusCode === 413) ||
        ('type' in error && error.type === 'entity.too.large'));
    const status = oversized
      ? 413
      : error instanceof BusinessError
        ? error.status
        : error instanceof ZodError
          ? 400
          : error instanceof HttpException
            ? error.getStatus()
            : 500;
    if (status === 500)
      console.error('API failure', error instanceof Error ? error.message : 'Unknown error');
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(status)
      .json({
        code: oversized
          ? 'PAYLOAD_TOO_LARGE'
          : error instanceof BusinessError
            ? error.code
            : status === 500
              ? 'INTERNAL_ERROR'
              : 'INVALID_REQUEST',
        message: oversized
          ? '送信データの容量が上限を超えています。'
          : status === 500
            ? '処理に失敗しました。操作IDを変えず再送してください。'
            : error instanceof Error
              ? error.message
              : '入力内容を確認してください。',
        field: error instanceof BusinessError ? (error.field ?? null) : null,
        retryable: oversized
          ? false
          : error instanceof BusinessError
            ? error.retryable
            : status === 500,
        nextAction: oversized
          ? '分割して再送'
          : status === 401
            ? '再ログインしてください。'
            : '入力・同期状況を確認し、同じ操作IDで再試行してください。',
      });
  }
}
