import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import type { Response } from 'express';
export interface InputFieldError {
  field: string;
  message: string;
}
export class BusinessError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
    public field?: string,
    public retryable = false,
    public fieldErrors?: InputFieldError[],
  ) {
    super(message);
  }
}
const selectionLabels: Readonly<Record<string, string>> = {
  shiftId: '開局記録',
  refundShiftId: '返金先の開局記録',
  storeId: '店舗',
  targetStoreId: '移動先の店舗',
  deviceId: '端末',
  productId: '商品',
  supplierId: '仕入先',
  staffId: '担当者',
  saleId: '売上記録',
  orderId: '発注記録',
  invoiceId: '仕入請求',
};
const amountLabels: Readonly<Record<string, string>> = {
  amount: '金額',
  opening: '準備金',
  actual: '実査額',
  price: '販売価格',
  cost: '原価',
  discount: '値引額',
  total: '合計金額',
  tendered: 'お預かり金額',
  unitAmount: '単価',
  discountAmount: '明細値引額',
};
const inputLabels: Readonly<Record<string, string>> = {
  name: '名称',
  sku: '商品コード',
  jan: 'JANコード',
  quantity: '数量',
  day: '営業日',
  from: '開始日',
  to: '終了日',
  effectiveAt: '適用日時',
  occurredAt: '操作日時',
  reference: '取引番号',
  direction: '入出金の区分',
  taxCode: '税区分',
};
export function inputValidationError(error: ZodError): BusinessError {
  const fields = new Map<string, InputFieldError>();
  for (const issue of error.issues) {
    const field = issue.path.map((part) => String(part)).join('.');
    if (fields.has(field)) continue;
    const key = [...issue.path].reverse().find((part) => typeof part === 'string');
    const selection = typeof key === 'string' ? selectionLabels[key] : undefined;
    const amount = typeof key === 'string' ? amountLabels[key] : undefined;
    const label = typeof key === 'string' ? inputLabels[key] : undefined;
    const message = selection
      ? `${selection}を選択してください。`
      : amount
        ? `${amount}は0以上の整数で入力してください。`
        : key === 'reason'
          ? issue.code === 'too_small'
            ? '理由を入力してください。'
            : '理由の入力内容を確認してください。'
          : key === 'pin'
            ? '担当者PINは4〜8桁の数字で入力してください。'
            : label
              ? `${label}の入力内容を確認してください。`
              : '入力内容を確認してください。';
    fields.set(field, { field, message });
    if (fields.size >= 20) break;
  }
  const fieldErrors = [...fields.values()];
  return new BusinessError(
    'INVALID_INPUT',
    [...new Set(fieldErrors.map((entry) => entry.message))].join(' ') ||
      '入力内容を確認してください。',
    400,
    fieldErrors[0]?.field || undefined,
    false,
    fieldErrors,
  );
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
    const businessError =
      error instanceof ZodError
        ? inputValidationError(error)
        : error instanceof BusinessError
          ? error
          : undefined;
    const oversized =
      typeof error === 'object' &&
      error !== null &&
      (('status' in error && error.status === 413) ||
        ('statusCode' in error && error.statusCode === 413) ||
        ('type' in error && error.type === 'entity.too.large'));
    const status = oversized
      ? 413
      : businessError
        ? businessError.status
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
          : businessError
            ? businessError.code
            : status === 500
              ? 'INTERNAL_ERROR'
              : 'INVALID_REQUEST',
        message: oversized
          ? '送信データの容量が上限を超えています。'
          : status === 500
            ? '処理に失敗しました。操作IDを変えず再送してください。'
            : businessError
              ? businessError.message
              : error instanceof Error
                ? error.message
                : '入力内容を確認してください。',
        field: businessError?.field ?? null,
        ...(businessError?.fieldErrors ? { fieldErrors: businessError.fieldErrors } : {}),
        retryable: oversized ? false : businessError ? businessError.retryable : status === 500,
        nextAction: oversized
          ? '分割して再送'
          : businessError?.code === 'INVALID_INPUT' && status === 400
            ? '該当する項目を修正してから保存してください。'
            : status === 401
              ? '再ログインしてください。'
              : '入力・同期状況を確認し、同じ操作IDで再試行してください。',
      });
  }
}
