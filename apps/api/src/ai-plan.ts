import { businessDate } from '../../../packages/core/src';
import { requireRule } from './errors';
export function quotaMonth(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 7);
}
export function planQuery(input: any, products: { id: string; name: string }[], now = new Date()) {
  const question = input.question.trim();
  requireRule(
    question && !/SQL|削除|更新し|INSERT|DROP|他法人|PIN|暗証|個人名/i.test(question),
    'AI_QUESTION',
    '更新・個人情報ではなく販売・在庫等の集計質問を入力してください',
    400,
  );
  let metric = /日報/.test(question)
    ? 'daily'
    : /粗利|利益/.test(question)
      ? 'profit'
      : /支払|現金|カード|QR/.test(question)
        ? 'payments'
        : /発注|入荷残/.test(question)
          ? 'orders'
          : /在庫|欠品|過剰/.test(question)
            ? 'inventory'
            : /売上|販売/.test(question)
              ? 'sales'
              : input.metric;
  requireRule(
    ['sales', 'payments', 'profit', 'inventory', 'orders', 'daily'].includes(metric) &&
      /売上|販売|支払|現金|カード|QR|粗利|利益|発注|入荷|在庫|欠品|過剰|比較|日報|傾向/.test(
        question,
      ),
    'AI_QUESTION',
    '集計対象を特定できません。売上・在庫・商品比較などを指定してください',
    400,
  );
  const today = businessDate(now.toISOString()),
    shift = (day: string, count: number) =>
      new Date(Date.parse(day + 'T00:00:00Z') + count * 86400000).toISOString().slice(0, 10);
  let from = input.from ?? today,
    to = input.to ?? today;
  const monthStart = today.slice(0, 7) + '-01',
    weekStart = shift(today, -((new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7));
  if (/今月/.test(question)) {
    from = monthStart;
    to = today;
  }
  if (/先月/.test(question)) {
    to = shift(monthStart, -1);
    from = to.slice(0, 7) + '-01';
  }
  if (/今週/.test(question)) {
    from = weekStart;
    to = today;
  }
  if (/先週/.test(question)) {
    from = shift(weekStart, -7);
    to = shift(weekStart, -1);
  }
  if (/今年/.test(question)) {
    from = today.slice(0, 4) + '-01-01';
    to = today;
  }
  if (/昨年|去年/.test(question)) {
    from = String(Number(today.slice(0, 4)) - 1) + '-01-01';
    to = from.slice(0, 4) + '-12-31';
  }
  requireRule(
    !/明日|来週|来月|来年/.test(question),
    'AI_PERIOD',
    '未来の需要は需要予測画面を利用してください。実績照会には過去・現在の期間を指定してください',
    400,
  );
  if (/今日|本日/.test(question)) from = to = today;
  if (/昨日/.test(question)) from = to = shift(today, -1);
  if (/直近7日|過去7日/.test(question)) {
    from = shift(today, -6);
    to = today;
  }
  const dates = question.match(/\d{4}-\d{2}-\d{2}/g);
  if (dates?.length) {
    from = dates[0];
    to = dates[1] ?? dates[0];
  }
  const validDate = (date: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date)) &&
    new Date(Date.parse(date)).toISOString().slice(0, 10) === date;
  requireRule(
    validDate(from) && validDate(to) && from <= to,
    'AI_PERIOD',
    '有効な開始日・終了日を指定してください',
    400,
  );
  const selected = products
    .filter((product) => question.includes(product.name))
    .slice(0, 10)
    .map((product) => product.id);
  if (/比較/.test(question)) {
    requireRule(selected.length >= 2, 'AI_COMPARISON', '登録商品名を2つ以上指定してください', 400);
    metric = 'comparison';
  }
  return {
    metric,
    from,
    to,
    productIds: selected,
    intent:
      metric === 'comparison'
        ? '登録商品の販売数・支払額比較'
        : metric === 'daily'
          ? '営業日日報'
          : `期間内の${metric}集計`,
  };
}
