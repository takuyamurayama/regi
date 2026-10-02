import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
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
  catch(error: any, host: ArgumentsHost) {
    const status =
      error instanceof BusinessError
        ? error.status
        : error instanceof ZodError
          ? 400
          : error instanceof HttpException
            ? error.getStatus()
            : 500;
    if (status === 500) console.error('API failure', error.message);
    host
      .switchToHttp()
      .getResponse()
      .status(status)
      .json({
        code: error.code ?? (status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST'),
        message:
          status === 500 ? '処理に失敗しました。操作IDを変えず再送してください。' : error.message,
        field: error.field ?? null,
        retryable: error.retryable ?? status === 500,
        nextAction:
          status === 401
            ? '再ログインしてください。'
            : '入力・同期状況を確認し、同じ操作IDで再試行してください。',
      });
  }
}
