import React, { useEffect, useRef, useState } from 'react';
import {
  ReceiptCandidateDtoSchema,
  financePageSchema,
  type ReceiptCandidateDto,
} from '@regi/core/finance';
import { financeMessage, financePath, financeValue, type FinanceProps } from '../finance-ui';
import type { InvoiceForm } from './invoice-form';

export function ReceiptMatching({
  props,
  supplierId,
  invoiceId,
  form,
  setForm,
}: {
  props: FinanceProps;
  supplierId: string;
  invoiceId?: string;
  form: InvoiceForm;
  setForm: (form: InvoiceForm) => void;
}) {
  const [items, setItems] = useState<ReceiptCandidateDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [line, setLine] = useState('1');
  const [quantity, setQuantity] = useState('1');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  async function load(next: string | null = null) {
    if (!supplierId) return;
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const query = {
        supplierId,
        pageSize: '50',
        ...(invoiceId ? { invoiceId } : {}),
        ...(next ? { cursor: next } : {}),
      };
      const page = financeValue(
        financePageSchema(ReceiptCandidateDtoSchema),
        await props.api(financePath('/v1/purchase-receipts/available', props.store, query)),
      );
      if (current === generation.current) {
        setItems((prior) => (next ? [...prior, ...page.items] : page.items));
        setCursor(page.nextCursor);
      }
    } catch (caught: unknown) {
      if (current === generation.current) setError(financeMessage(caught));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    setItems([]);
    setCursor(null);
    void load();
    return () => {
      generation.current++;
    };
  }, [props.scopeKey, supplierId, invoiceId]);
  function match(item: ReceiptCandidateDto) {
    if (!/^[1-9][0-9]{0,4}$/.test(quantity) || Number(quantity) > 10000) {
      setError('照合数量は1〜10,000の整数で入力してください。');
      return;
    }
    const position = Number(line) - 1;
    const target = form.lines[position];
    if (!target) {
      setError('照合する請求明細を選択してください。');
      return;
    }
    const already = form.lines.reduce(
      (sum, entry) =>
        sum +
        entry.receiptAllocations
          .filter(
            (allocation) =>
              allocation.receiptId === item.receiptId &&
              allocation.receiptLineIndex === item.receiptLineIndex,
          )
          .reduce((total, allocation) => total + allocation.quantity, 0),
      0,
    );
    if (
      already + Number(quantity) >
      item.invoiceAllocatableQuantity + item.ownDraftAllocatedQuantity
    ) {
      setError('入荷の請求照合可能数量を超えています。');
      return;
    }
    if (target.productId && target.productId !== item.productId) {
      setError('異なる商品の入荷を同じ請求明細に混在できません。');
      return;
    }
    setForm({
      ...form,
      lines: form.lines.map((entry, index) =>
        index === position
          ? {
              ...entry,
              productId: item.productId,
              receiptAllocations: [
                ...entry.receiptAllocations,
                {
                  receiptId: item.receiptId,
                  receiptLineIndex: item.receiptLineIndex,
                  quantity: Number(quantity),
                },
              ],
            }
          : entry,
      ),
    });
    setError('');
  }
  return (
    <details className="finance-card">
      <summary>入荷記録と請求明細を照合</summary>
      <p className="finance-note">
        「請求照合可能」と「物品返品可能」は別の数量です。照合だけで在庫や入荷を増減しません。
      </p>
      <div className="finance-field-grid">
        <label>
          照合する請求明細
          <select value={line} onChange={(event) => setLine(event.target.value)}>
            {form.lines.map((entry, index) => (
              <option key={index} value={index + 1}>
                {index + 1}行目：{entry.name || '名称未入力'}
              </option>
            ))}
          </select>
        </label>
        <label>
          今回の照合数量
          <input
            inputMode="numeric"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </label>
      </div>
      {loading && <p role="status">入荷記録を取得しています…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && items.length === 0 && (
        <p>照合候補の入荷はありません。請求明細の未照合理由を記録できます。</p>
      )}
      <div className="finance-table-scroll">
        <table>
          <caption>入荷の照合候補</caption>
          <thead>
            <tr>
              <th>品目</th>
              <th>元入荷</th>
              <th>請求照合可能</th>
              <th>物品返品可能</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={`${item.receiptId}:${item.receiptLineIndex}`}>
                <td>{item.name}</td>
                <td>{item.originalQuantity}</td>
                <td>{item.invoiceAllocatableQuantity}</td>
                <td>{item.returnableQuantity}</td>
                <td>
                  <button disabled={props.busy} onClick={() => match(item)}>
                    この入荷を照合
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
      {form.lines.map((entry, index) =>
        entry.receiptAllocations.length ? (
          <div key={index}>
            <p>
              {index + 1}行目の照合：
              {entry.receiptAllocations.map((item) => `${item.quantity}個`).join('、')}
            </p>
            <button
              onClick={() =>
                setForm({
                  ...form,
                  lines: form.lines.map((item, position) =>
                    position === index ? { ...item, receiptAllocations: [] } : item,
                  ),
                })
              }
            >
              この明細の照合を解除
            </button>
          </div>
        ) : null,
      )}
    </details>
  );
}
