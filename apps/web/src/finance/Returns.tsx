import React, { useEffect, useRef, useState } from 'react';
import {
  InvoiceDtoSchema,
  InvoiceSummaryDtoSchema,
  ReceiptCandidateDtoSchema,
  ReturnActionDtoSchema,
  ReturnDtoSchema,
  ReturnRequestSchema,
  ReturnReverseRequestSchema,
  SupplierDtoSchema,
  financePageSchema,
  type InvoiceSummaryDto,
  type ReceiptCandidateDto,
  type ReturnDto,
  type ReturnLineInput,
  type SupplierDto,
} from '@regi/core/finance';
import {
  financeDate,
  financeMessage,
  financePath,
  financeValue,
  japanInstant,
  validateFinanceRequest,
  type FinanceProps,
} from '../finance-ui';

export function FinanceReturns(props: FinanceProps) {
  const [records, setRecords] = useState<ReturnDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [suppliers, setSuppliers] = useState<SupplierDto[]>([]);
  const [supplierCursor, setSupplierCursor] = useState<string | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [candidates, setCandidates] = useState<ReceiptCandidateDto[]>([]);
  const [candidateCursor, setCandidateCursor] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<InvoiceSummaryDto[]>([]);
  const [invoiceCursor, setInvoiceCursor] = useState<string | null>(null);
  const [invoiceId, setInvoiceId] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [lines, setLines] = useState<ReturnLineInput[]>([]);
  const [returnedAt, setReturnedAt] = useState('');
  const [reason, setReason] = useState('');
  const [reverseRecord, setReverseRecord] = useState<ReturnDto | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [reverseAt, setReverseAt] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const selectionGeneration = useRef(0);
  const selectedInvoice = invoices.find((item) => item.id === invoiceId);
  async function load(cursor: string | null = null) {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const page = financeValue(
        financePageSchema(ReturnDtoSchema),
        await props.api(
          financePath('/v1/purchase-returns', props.store, {
            pageSize: '50',
            ...(cursor ? { cursor } : {}),
          }),
        ),
      );
      if (current === generation.current) {
        setRecords((prior) => (cursor ? [...prior, ...page.items] : page.items));
        setCursor(page.nextCursor);
      }
    } catch (caught: unknown) {
      if (current === generation.current) setError(financeMessage(caught));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  async function loadSuppliers(cursor: string | null = null) {
    const current = generation.current;
    try {
      const page = financeValue(
        financePageSchema(SupplierDtoSchema),
        await props.api(
          `/v1/suppliers?${new URLSearchParams({ active: 'all', pageSize: '50', ...(cursor ? { cursor } : {}) })}`,
        ),
      );
      if (current === generation.current) {
        setSuppliers((prior) => (cursor ? [...prior, ...page.items] : page.items));
        setSupplierCursor(page.nextCursor);
      }
    } catch (caught: unknown) {
      if (current === generation.current) setError(financeMessage(caught));
    }
  }
  async function loadSelection(kind: 'receipt' | 'invoice', cursor: string | null = null) {
    if (!supplierId) return;
    const current = generation.current;
    const selection = selectionGeneration.current;
    try {
      const query = {
        supplierId,
        pageSize: '50',
        ...(cursor ? { cursor } : {}),
        ...(kind === 'invoice' ? { state: 'posted' } : {}),
      };
      const response = await props.api(
        financePath(
          kind === 'invoice' ? '/v1/purchase-invoices' : '/v1/purchase-receipts/available',
          props.store,
          query,
        ),
      );
      if (current !== generation.current || selection !== selectionGeneration.current) return;
      if (kind === 'invoice') {
        const page = financeValue(financePageSchema(InvoiceSummaryDtoSchema), response);
        setInvoices((prior) => (cursor ? [...prior, ...page.items] : page.items));
        setInvoiceCursor(page.nextCursor);
      } else {
        const page = financeValue(financePageSchema(ReceiptCandidateDtoSchema), response);
        setCandidates((prior) => (cursor ? [...prior, ...page.items] : page.items));
        setCandidateCursor(page.nextCursor);
      }
    } catch (caught: unknown) {
      if (current === generation.current && selection === selectionGeneration.current)
        setError(financeMessage(caught));
    }
  }
  useEffect(() => {
    void load();
    void loadSuppliers();
    return () => {
      generation.current++;
    };
  }, [props.scopeKey]);
  useEffect(() => {
    selectionGeneration.current++;
    setLines([]);
    setInvoiceId('');
    setSelectedKey('');
    setCandidates([]);
    setInvoices([]);
    setCandidateCursor(null);
    setInvoiceCursor(null);
    void loadSelection('receipt');
    void loadSelection('invoice');
  }, [supplierId]);
  function addLine() {
    const candidate = candidates.find(
      (item) => `${item.receiptId}:${item.receiptLineIndex}` === selectedKey,
    );
    if (!candidate || !/^[1-9][0-9]{0,4}$/.test(quantity) || Number(quantity) > 10000) {
      setError('入荷明細と1〜10,000の整数の返品数量を選択してください。');
      return;
    }
    const already = lines
      .filter(
        (item) =>
          item.receiptId === candidate.receiptId &&
          item.receiptLineIndex === candidate.receiptLineIndex,
      )
      .reduce((sum, item) => sum + item.quantity, 0);
    if (already + Number(quantity) > candidate.returnableQuantity) {
      setError('物品返品可能な数量を超えています。');
      return;
    }
    setLines([
      ...lines,
      {
        receiptId: candidate.receiptId,
        receiptLineIndex: candidate.receiptLineIndex,
        quantity: Number(quantity),
      },
    ]);
    setError('');
  }
  async function create() {
    const input = {
      storeId: props.store,
      invoiceId: invoiceId || null,
      expectedInvoiceVersion: selectedInvoice?.version ?? null,
      returnedAt: japanInstant(returnedAt),
      reason,
      lines,
    };
    validateFinanceRequest(
      ReturnRequestSchema,
      input,
      '返品明細・実際の返品日時・理由を入力してください。',
    );
    const current = generation.current;
    const result = financeValue(
      ReturnActionDtoSchema,
      await props.post('/v1/purchase-returns', input),
    );
    if (current !== generation.current) return;
    setLines([]);
    setReturnedAt('');
    setNotice(
      `物品返品を記録しました。${result.record.lines.reduce((sum, line) => sum + line.quantity, 0)}個の在庫を減らしました。`,
    );
    await load();
    await Promise.all([loadSelection('receipt'), loadSelection('invoice')]);
  }
  async function reverse() {
    if (!reverseRecord) return;
    const invoice = reverseRecord.invoiceId
      ? financeValue(
          InvoiceDtoSchema,
          await props.api(
            financePath(`/v1/purchase-invoices/${reverseRecord.invoiceId}`, props.store),
          ),
        )
      : null;
    const input = {
      storeId: props.store,
      expectedInvoiceVersion: invoice?.version ?? null,
      effectiveAt: japanInstant(reverseAt),
      reason: reverseReason,
    };
    validateFinanceRequest(
      ReturnReverseRequestSchema,
      input,
      '返品を取り消す実際の日時と理由を入力してください。',
    );
    const current = generation.current;
    financeValue(
      ReturnActionDtoSchema,
      await props.post(`/v1/purchase-returns/${reverseRecord.id}/reverse`, input),
    );
    if (current !== generation.current) return;
    setReverseRecord(null);
    setNotice('物品返品の取消記録を追加し、在庫を戻しました。');
    await load();
    await Promise.all([loadSelection('receipt'), loadSelection('invoice')]);
  }
  return (
    <section className="finance-section" aria-labelledby="returns-heading">
      <header className="finance-section-header">
        <div>
          <h2 id="returns-heading">物品返品</h2>
          <p>入荷済みの現物を仕入先へ返送した記録です。請求の減額・返金は別に記録します。</p>
        </div>
      </header>
      {error && (
        <p role="alert" className="finance-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <form
        className="finance-card finance-form"
        onSubmit={(event) => {
          event.preventDefault();
          void props.action(create);
        }}
      >
        <h3>物品返品を記録</h3>
        <div className="finance-field-grid">
          <label>
            返品する仕入先
            <select
              value={supplierId}
              onChange={(event) => {
                selectionGeneration.current++;
                setSupplierId(event.target.value);
              }}
            >
              <option value="">選択してください</option>
              {suppliers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            関連する確定請求
            <select value={invoiceId} onChange={(event) => setInvoiceId(event.target.value)}>
              <option value="">請求と未対応</option>
              {invoices.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.internalReference}
                </option>
              ))}
            </select>
          </label>
        </div>
        {supplierCursor && (
          <button type="button" onClick={() => void loadSuppliers(supplierCursor)}>
            仕入先をさらに表示
          </button>
        )}
        {invoiceCursor && (
          <button type="button" onClick={() => void loadSelection('invoice', invoiceCursor)}>
            請求候補をさらに表示
          </button>
        )}
        <div className="finance-field-grid">
          <label>
            返品する元入荷明細
            <select value={selectedKey} onChange={(event) => setSelectedKey(event.target.value)}>
              <option value="">選択してください</option>
              {candidates.map((item) => (
                <option
                  key={`${item.receiptId}:${item.receiptLineIndex}`}
                  value={`${item.receiptId}:${item.receiptLineIndex}`}
                >
                  {item.name} ・物品返品可能 {item.returnableQuantity}個 ・
                  {financeDate(item.receivedAt)}
                </option>
              ))}
            </select>
          </label>
          <label>
            今回の返品数量
            <input
              inputMode="numeric"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </label>
        </div>
        <button type="button" disabled={props.busy || lines.length >= 500} onClick={addLine}>
          返品明細に追加
        </button>
        {candidateCursor && (
          <button type="button" onClick={() => void loadSelection('receipt', candidateCursor)}>
            入荷候補をさらに表示
          </button>
        )}
        {lines.length > 0 && (
          <ul>
            {lines.map((line, index) => (
              <li key={index}>
                {candidates.find(
                  (item) =>
                    item.receiptId === line.receiptId &&
                    item.receiptLineIndex === line.receiptLineIndex,
                )?.name ?? '入荷明細'}
                ：{line.quantity}個{' '}
                <button
                  type="button"
                  onClick={() => setLines(lines.filter((_, position) => position !== index))}
                >
                  この返品明細を外す
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="finance-field-grid">
          <label>
            実際の物品返品日時（日本時間）
            <input
              required
              type="datetime-local"
              step="1"
              value={returnedAt}
              onChange={(event) => setReturnedAt(event.target.value)}
            />
          </label>
          <label>
            物品返品の理由
            <input
              required
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
        </div>
        <p className="finance-note">
          保存すると選択した在庫を減らします。仕入先の減額承認は請求の詳細画面で記録してください。
        </p>
        <button className="primary" disabled={props.busy || lines.length === 0}>
          物品返品を記録して在庫を減らす
        </button>
      </form>
      {loading && <p role="status">返品履歴を取得しています…</p>}
      <div className="finance-table-scroll">
        <table>
          <caption>物品返品の履歴</caption>
          <thead>
            <tr>
              <th>実際の日時</th>
              <th>返品明細</th>
              <th>理由</th>
              <th>状態</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.id}>
                <td>{financeDate(record.occurredAt)}</td>
                <td>{record.lines.map((item) => `${item.name} ${item.quantity}個`).join('、')}</td>
                <td>{record.reason}</td>
                <td>{record.reversalOf ? '取消記録' : record.reversedBy ? '取消済み' : '有効'}</td>
                <td>
                  {!record.reversalOf && !record.reversedBy && (
                    <button
                      disabled={props.busy}
                      onClick={() => {
                        setReverseRecord(record);
                        setReverseReason('');
                        setReverseAt('');
                      }}
                    >
                      理由を付けて取り消す
                    </button>
                  )}
                  {record.invoiceId && (
                    <button
                      onClick={() =>
                        props.navigate(
                          `/purchases/invoices/${record.invoiceId}?${new URLSearchParams({ storeId: props.store })}`,
                        )
                      }
                    >
                      関連請求
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && !error && records.length === 0 && <p>物品返品の記録はありません。</p>}
      {cursor && (
        <button disabled={loading} onClick={() => void load(cursor)}>
          次の50件を表示
        </button>
      )}
      {reverseRecord && (
        <form
          className="finance-card finance-form finance-warning"
          onSubmit={(event) => {
            event.preventDefault();
            void props.action(reverse);
          }}
        >
          <h3>物品返品を取り消し、在庫を戻す</h3>
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
            <button disabled={props.busy}>物品返品の取消を記録</button>
            <button type="button" onClick={() => setReverseRecord(null)}>
              やめる
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
