export type PaymentMethod = 'cash' | 'card' | 'qr';

export function paymentShares(payments: Partial<Record<PaymentMethod, string>> = {}) {
  const methods: PaymentMethod[] = ['cash', 'card', 'qr'];
  const total = methods.reduce((sum, method) => sum + BigInt(payments[method] ?? '0'), 0n);
  return methods.map((method) => ({
    method,
    amount: payments[method] ?? '0',
    share: total > 0n ? Number((BigInt(payments[method] ?? '0') * 10000n) / total) / 100 : 0,
  }));
}

export const yen = (value: unknown) => '¥' + BigInt(String(value ?? 0)).toLocaleString('ja-JP');
