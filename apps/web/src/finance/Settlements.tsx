import React, { useEffect, useRef, useState } from 'react';
import {
  FactReverseRequestSchema,
  PaymentActionDtoSchema,
  PaymentDtoSchema,
  PaymentRequestSchema,
  RefundActionDtoSchema,
  SupplierRefundRequestSchema,
  financePageSchema,
  type InvoiceDto,
  type PaymentDto,
} from '@regi/core/finance';
import {
  financeDate,
  financeMessage,
  financePath,
  financeValue,
  financeYen,
  japanInstant,
  validateFinanceRequest,
  type FinanceProps,
} from '../finance-ui';

export function InvoiceSettlements({
  props,
  invoice,
  reload,
  kind,
}: {
  props: FinanceProps;
  invoice: InvoiceDto;
  reload: () => Promise<void>;
  kind: 'payment' | 'refund';
}) {
  const refund = kind === 'refund';
  const path = refund ? '/v1/purchase-refunds' : '/v1/purchase-payments';
  const [amount, setAmount] = useState('');
  const [occurred, setOccurred] = useState('');
  const [method, setMethod] = useState('bank-transfer');
  const [reference, setReference] = useState('');
  const [evidenceId, setEvidenceId] = useState('');
  const [note, setNote] = useState('');
  const [records, setRecords] = useState<PaymentDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<PaymentDto | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [reverseAt, setReverseAt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const canCreate = refund ? invoice.permissions.canReceiveRefund : invoice.permissions.canPay;
  const canReverse = ['admin', 'headquarters'].includes(props.actorRole);
  async function load(next: string | null = null) {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const query = { invoiceId: invoice.id, pageSize: '50', ...(next ? { cursor: next } : {}) };
      const page = financeValue(
        financePageSchema(PaymentDtoSchema),
        await props.api(financePath(path, props.store, query)),
      );
      if (current === generation.current) {
        setRecords((prior) => (next ? [...prior, ...page.items] : page.items));
        setCursor(page.nextCursor);
      }
    } catch (caught: unknown) {
      if (current === generation.current) setError(financeMessage(caught));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [props.scopeKey, invoice.id, invoice.version]);
  async function create() {
    const input = {
      storeId: props.store,
      invoiceId: invoice.id,
      expectedInvoiceVersion: invoice.version,
      amount,
      method,
      reference: reference.trim() || null,
      evidenceId: evidenceId || null,
      note,
      ...(refund ? { receivedAt: japanInstant(occurred) } : { paidAt: japanInstant(occurred) }),
    };
    validateFinanceRequest(
      refund ? SupplierRefundRequestSchema : PaymentRequestSchema,
      input,
      '正しい整数円の金額・実際の日時・支払方法を入力してください。',
    );
    const current = generation.current;
    const result = financeValue(
      refund ? RefundActionDtoSchema : PaymentActionDtoSchema,
      await props.post(path, input),
    );
    if (current !== generation.current) return;
    setAmount('');
    setOccurred('');
    setNotice(
      `${refund ? '返金受領' : '支払'} ${financeYen(result.record.amount)}を記録しました。`,
    );
    await reload();
  }
  async function reverse() {
    if (!selected) return;
    const input = {
      storeId: props.store,
      expectedInvoiceVersion: invoice.version,
      reason: reverseReason,
      effectiveAt: japanInstant(reverseAt),
      evidenceId: evidenceId || null,
    };
    validateFinanceRequest(
      FactReverseRequestSchema,
      input,
      '取り消す理由と実際の取消日時を入力してください。',
    );
    const current = generation.current;
    financeValue(
      refund ? RefundActionDtoSchema : PaymentActionDtoSchema,
      await props.post(`${path}/${selected.id}/reverse`, input),
    );
    if (current !== generation.current) return;
    setSelected(null);
    setReverseReason('');
    setReverseAt('');
    setNotice('元の記録を保持し、取消記録を追加しました。');
    await reload();
  }
  return (
    <section className="finance-card">
      <h3>{refund ? '仕入先からの返金受領' : '支払記録'}</h3>
      <p>
        {refund ? '返金待ち' : '未払残高'}：
        <strong>
          {financeYen(refund ? invoice.balance.refundDueAmount : invoice.balance.payableAmount)}
        </strong>
      </p>
      {canCreate && (
        <form
          className="finance-form"
          onSubmit={(event) => {
            event.preventDefault();
            void props.action(create);
          }}
        >
          <div className="finance-field-grid">
            <label>
              {refund ? '実際に受領した返金額（円）' : '実際に支払った金額（円）'}
              <input
                required
                inputMode="numeric"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            <label>
              {refund ? '実際の返金受領日時（日本時間）' : '実際の支払日時（日本時間）'}
              <input
                required
                type="datetime-local"
                step="1"
                value={occurred}
                onChange={(event) => setOccurred(event.target.value)}
              />
            </label>
            <label>
              {refund ? '返金方法' : '支払方法'}
              <select value={method} onChange={(event) => setMethod(event.target.value)}>
                <option value="bank-transfer">銀行振込</option>
                <option value="cash">現金</option>
                <option value="other">その他</option>
              </select>
            </label>
            <label>
              外部の取引番号・参照
              <input
                maxLength={200}
                required={method === 'bank-transfer'}
                value={reference}
                onChange={(event) => setReference(event.target.value)}
              />
            </label>
            <label>
              根拠資料
              <select value={evidenceId} onChange={(event) => setEvidenceId(event.target.value)}>
                <option value="">未選択</option>
                {invoice.evidence
                  .filter((item) =>
                    [refund ? 'supplier-refund' : 'payment', 'supporting'].includes(item.role),
                  )
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.originalName}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <label>
            補足・その他の方法の説明
            <textarea
              required={method === 'other'}
              maxLength={500}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <p className="finance-note">
            完了した取引を記録します。REGIから銀行振込を実行する操作ではありません。
          </p>
          <button className="primary" disabled={props.busy}>
            {refund ? '返金受領を記録' : '支払を記録'}
          </button>
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">履歴を取得しています…</p>}
      {error && <p role="alert">{error}</p>}
      <div className="finance-table-scroll">
        <table>
          <caption>{refund ? '返金受領の履歴' : '支払の履歴'}</caption>
          <thead>
            <tr>
              <th>実際の日時</th>
              <th>金額</th>
              <th>方法・参照</th>
              <th>状態</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.id}>
                <td>{financeDate(record.occurredAt)}</td>
                <td>{financeYen(record.amount)}</td>
                <td>
                  {record.method === 'cash'
                    ? '現金'
                    : record.method === 'bank-transfer'
                      ? '銀行振込'
                      : 'その他'}{' '}
                  {record.reference}
                </td>
                <td>{record.reversalOf ? '取消記録' : record.reversedBy ? '取消済み' : '有効'}</td>
                <td>
                  {canReverse && !record.reversedBy && !record.reversalOf && (
                    <button
                      disabled={props.busy}
                      onClick={() => {
                        setSelected(record);
                        setReverseReason('');
                        setReverseAt('');
                      }}
                    >
                      理由を付けて取り消す
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && !error && records.length === 0 && <p>記録はありません。</p>}
      {cursor && (
        <button disabled={loading} onClick={() => void load(cursor)}>
          次の50件を表示
        </button>
      )}
      {selected && (
        <form
          className="finance-form finance-warning"
          onSubmit={(event) => {
            event.preventDefault();
            void props.action(reverse);
          }}
        >
          <h4>{financeYen(selected.amount)}の記録を取り消す</h4>
          <label>
            取消理由
            <input
              required
              maxLength={500}
              value={reverseReason}
              onChange={(event) => setReverseReason(event.target.value)}
            />
          </label>
          <label>
            実際の取消日時（日本時間）
            <input
              required
              type="datetime-local"
              step="1"
              value={reverseAt}
              onChange={(event) => setReverseAt(event.target.value)}
            />
          </label>
          <div className="finance-actions">
            <button disabled={props.busy}>取消記録を追加</button>
            <button type="button" onClick={() => setSelected(null)}>
              やめる
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
