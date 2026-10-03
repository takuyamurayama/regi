import React, { useEffect, useRef, useState } from 'react';
import {
  InvoiceSummaryDtoSchema,
  financePageSchema,
  type InvoiceSummaryDto,
} from '@regi/core/finance';
import {
  financeMessage,
  financePath,
  financeValue,
  financeYen,
  type FinanceProps,
} from '../finance-ui';
import { FinanceInvoiceEditor } from './InvoiceEditor';

export function FinanceInvoices(props: FinanceProps) {
  const [records, setRecords] = useState<InvoiceSummaryDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState('all');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  async function load(next: string | null = null) {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const query = {
        state,
        search,
        pageSize: '50',
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(next ? { cursor: next } : {}),
      };
      const page = financeValue(
        financePageSchema(InvoiceSummaryDtoSchema),
        await props.api(financePath('/v1/purchase-invoices', props.store, query)),
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
    if (!props.invoiceId) void load();
    return () => {
      generation.current++;
    };
  }, [props.scopeKey, props.invoiceId]);
  function close() {
    setCreating(false);
    props.navigate(`/purchases/invoices?${new URLSearchParams({ storeId: props.store })}`);
    void load();
  }
  if (creating || props.invoiceId)
    return (
      <FinanceInvoiceEditor
        key={`${props.scopeKey}:${props.invoiceId ?? 'new'}`}
        props={props}
        close={close}
      />
    );
  return (
    <section className="finance-section" aria-labelledby="invoices-heading">
      <header className="finance-section-header">
        <div>
          <h2 id="invoices-heading">仕入請求</h2>
          <p>原請求書と入荷を照合し、買掛・支払・減額・返金を管理します。</p>
        </div>
        <button className="primary" disabled={props.busy} onClick={() => setCreating(true)}>
          請求の下書きを作成
        </button>
      </header>
      <form
        className="finance-filter"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <label>
          仕入先・原番号を検索
          <input
            maxLength={100}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label>
          状態
          <select value={state} onChange={(event) => setState(event.target.value)}>
            <option value="all">すべて</option>
            <option value="draft">下書き</option>
            <option value="posted">確定済み</option>
            <option value="cancelled">下書き取消済み</option>
            <option value="voided">確定取消済み</option>
          </select>
        </label>
        <label>
          原請求日・開始
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label>
          原請求日・終了
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
        <button disabled={loading}>検索</button>
      </form>
      {loading && <p role="status">請求を取得しています…</p>}
      {error && (
        <p role="alert" className="finance-error">
          {error}
        </p>
      )}
      {!loading && !error && records.length === 0 && (
        <div className="finance-empty">
          <h3>条件に合う請求はありません</h3>
          <p>請求書を受領したら、下書きから登録してください。</p>
        </div>
      )}
      <div className="finance-table-scroll">
        <table>
          <caption>仕入請求一覧</caption>
          <thead>
            <tr>
              <th>原請求番号・内部番号</th>
              <th>仕入先</th>
              <th>状態</th>
              <th>原請求額</th>
              <th>未払残高</th>
              <th>返金待ち</th>
              <th>期日</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.id}>
                <td>
                  {record.sourceIdentity?.kind === 'numbered'
                    ? record.sourceIdentity.invoiceNumber
                    : (record.sourceIdentity?.sourceReference ?? '原番号未入力')}
                  <small>
                    {record.internalReference} ・版{record.revision}
                  </small>
                </td>
                <td>{record.supplierName}</td>
                <td>
                  {record.state === 'draft'
                    ? '下書き'
                    : record.state === 'posted'
                      ? '確定済み'
                      : record.state === 'voided'
                        ? '確定取消'
                        : '下書き取消'}
                </td>
                <td>{financeYen(record.balance.originalGross)}</td>
                <td>{financeYen(record.balance.payableAmount)}</td>
                <td>{financeYen(record.balance.refundDueAmount)}</td>
                <td>{record.dueDate ?? '未入力'}</td>
                <td>
                  <button
                    disabled={props.busy}
                    onClick={() =>
                      props.navigate(
                        `/purchases/invoices/${record.id}?${new URLSearchParams({ storeId: props.store })}`,
                      )
                    }
                  >
                    請求の詳細
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor && (
        <button disabled={loading} onClick={() => void load(cursor)}>
          次の50件を表示
        </button>
      )}
    </section>
  );
}
