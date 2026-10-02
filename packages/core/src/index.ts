export const RULE_VERSION = 'regi-1';
export type LineInput = {
  productId: string;
  name: string;
  quantity: number;
  price: string;
  discount: string;
  rateBps: number;
  cost: string;
  stockManaged: boolean;
  taxContext?: 'master' | 'dine-in' | 'takeaway';
};
export type CalculatedLine = LineInput & {
  net: string;
  allocatedDiscount: string;
  paid: string;
  unitRefunds: string[];
  managementTax: string;
  unitTaxRefunds: string[];
};
export function money(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,29})$/.test(value))
    throw new Error('金額は非負の整数文字列で指定してください');
  return BigInt(value);
}
export function allocate(total: bigint, weights: bigint[]): bigint[] {
  if (total < 0n || weights.some((value) => value < 0n)) throw new Error('配分値が不正です');
  const sum = weights.reduce((left, right) => left + right, 0n);
  if (sum === 0n) {
    if (total !== 0n) throw new Error('ゼロ金額へ配分できません');
    return weights.map(() => 0n);
  }
  const result = weights.map((value) => (total * value) / sum);
  let remainder = total - result.reduce((left, right) => left + right, 0n);
  const order = weights
    .map((value, index) => ({ index, remainder: (total * value) % sum }))
    .sort((left, right) =>
      left.remainder === right.remainder
        ? left.index - right.index
        : left.remainder > right.remainder
          ? -1
          : 1,
    );
  for (const entry of order) {
    if (remainder-- <= 0n) break;
    result[entry.index]++;
  }
  return result;
}
export function calculate(lines: LineInput[], discount: string, mode: 'inclusive' | 'exclusive') {
  if (!['inclusive', 'exclusive'].includes(mode) || !lines.length || lines.length > 500)
    throw new Error('会計が不正です');
  const net = lines.map((line) => {
    if (
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 10000 ||
      !Number.isSafeInteger(line.rateBps) ||
      line.rateBps < 0 ||
      line.rateBps > 10000
    )
      throw new Error('数量・税率が不正です');
    money(line.cost);
    const gross = money(line.price) * BigInt(line.quantity);
    const reduction = money(line.discount);
    if (reduction > gross) throw new Error('値引きが明細金額を超えています');
    return gross - reduction;
  });
  const totalDiscount = money(discount);
  if (totalDiscount > net.reduce((left, right) => left + right, 0n))
    throw new Error('値引きが会計金額を超えています');
  const reductions = allocate(totalDiscount, net);
  const remaining = net.map((value, index) => value - reductions[index]);
  const paid = [...remaining];
  const managementTax = remaining.map(() => 0n);
  const taxes: { rateBps: number; base: string; tax: string; paid: string }[] = [];
  for (const rateBps of [...new Set(lines.map((line) => line.rateBps))]) {
    const indexes = lines
      .map((line, index) => (line.rateBps === rateBps ? index : -1))
      .filter((index) => index >= 0);
    const base = indexes.reduce((sum, index) => sum + remaining[index], 0n);
    const tax = (base * BigInt(rateBps)) / BigInt(mode === 'inclusive' ? 10000 + rateBps : 10000);
    const taxShares = allocate(
      tax,
      indexes.map((index) => remaining[index]),
    );
    indexes.forEach((index, position) => {
      managementTax[index] = taxShares[position];
    });
    if (mode === 'exclusive') {
      const shares = allocate(
        tax,
        indexes.map((index) => remaining[index]),
      );
      indexes.forEach((index, position) => {
        paid[index] += shares[position];
      });
    }
    taxes.push({
      rateBps,
      base: base.toString(),
      tax: tax.toString(),
      paid: (mode === 'inclusive' ? base : base + tax).toString(),
    });
  }
  return {
    ruleVersion: RULE_VERSION,
    mode,
    discount,
    total: paid.reduce((left, right) => left + right, 0n).toString(),
    taxes,
    lines: lines.map((line, index): CalculatedLine => {
      const units = allocate(
        paid[index],
        Array.from({ length: line.quantity }, () => 1n),
      );
      return {
        ...line,
        net: net[index].toString(),
        allocatedDiscount: reductions[index].toString(),
        paid: paid[index].toString(),
        managementTax: managementTax[index].toString(),
        unitRefunds: units.map((value) => value.toString()),
        unitTaxRefunds: allocate(managementTax[index], units).map((value) => value.toString()),
      };
    }),
  };
}
export function businessDate(instant: string): string {
  const milliseconds = Date.parse(instant);
  if (!Number.isFinite(milliseconds)) throw new Error('日時が不正です');
  return new Date(milliseconds + 4 * 3600000).toISOString().slice(0, 10);
}
export function offlineAllowed(
  now: string,
  authorizationUntil: string,
  contractUntil: string,
  lastSync: string,
): boolean {
  const current = Date.parse(now);
  return (
    [
      current,
      Date.parse(authorizationUntil),
      Date.parse(contractUntil),
      Date.parse(lastSync),
    ].every(Number.isFinite) &&
    current < Date.parse(authorizationUntil) &&
    current < Date.parse(contractUntil) &&
    current >= Date.parse(lastSync) &&
    current - Date.parse(lastSync) <= 72 * 3600000
  );
}
