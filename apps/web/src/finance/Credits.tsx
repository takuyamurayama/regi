import React, { useEffect, useRef, useState } from 'react';
import {
  CreditActionDtoSchema,
  CreditPreviewDtoSchema,
  CreditPreviewRequestSchema,
  CreditRequestSchema,
  ReturnDtoSchema,
  financePageSchema,
  type CreditLines,
  type CreditPreviewDto,
  type InvoiceDto,
  type ReturnDto,
} from '@regi/core/finance';
import {
  financeMessage,
  financePath,
  financeValue,
  financeYen,
  japanInstant,
  validateFinanceRequest,
  type FinanceProps,
} from '../finance-ui';
import { CreditHistory } from './CreditHistory';

export function InvoiceCredits({
  props,
  invoice,
  reload,
}: {
  props: FinanceProps;
  invoice: InvoiceDto;
  reload: () => Promise<void>;
}) {
  const [lineNo, setLineNo] = useState(String(invoice.creditAvailability[0]?.invoiceLineNo ?? 1));
  const [mode, setMode] = useState<'quantity' | 'amount'>('quantity');
  const [quantity, setQuantity] = useState('1');
  const [net, setNet] = useState('');
  const [tax, setTax] = useState('');
  const [gross, setGross] = useState('');
  const [approvedAt, setApprovedAt] = useState('');
  const [reason, setReason] = useState('');
  const [evidenceId, setEvidenceId] = useState('');
  const [returnId, setReturnId] = useState('');
  const [returns, setReturns] = useState<ReturnDto[]>([]);
  const [returnCursor, setReturnCursor] = useState<string | null>(null);
  const [preview, setPreview] = useState<CreditPreviewDto | null>(null);
  const [previewInput, setPreviewInput] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  async function loadReturns(cursor: string | null = null) {
    const current = generation.current;
    try {
      const page = financeValue(
        financePageSchema(ReturnDtoSchema),
        await props.api(
          financePath('/v1/purchase-returns', props.store, {
            invoiceId: invoice.id,
            pageSize: '50',
            ...(cursor ? { cursor } : {}),
          }),
        ),
      );
      if (current === generation.current) {
        setReturns((prior) => (cursor ? [...prior, ...page.items] : page.items));
        setReturnCursor(page.nextCursor);
      }
    } catch (caught: unknown) {
      if (current === generation.current) setError(financeMessage(caught));
    }
  }
  useEffect(() => {
    void loadReturns();
    return () => {
      generation.current++;
    };
  }, [props.scopeKey, invoice.id, invoice.version]);
  function credit(): CreditLines {
    if (mode === 'quantity') {
      if (!/^[1-9][0-9]{0,4}$/.test(quantity))
        throw new Error('減額する数量は1〜10,000の整数で入力してください。');
      return { mode, lines: [{ invoiceLineNo: Number(lineNo), quantity: Number(quantity) }] };
    }
    return { mode, lines: [{ invoiceLineNo: Number(lineNo), net, tax, gross }] };
  }
  async function calculate() {
    const input = {
      storeId: props.store,
      expectedInvoiceVersion: invoice.version,
      credit: credit(),
    };
    if (!CreditPreviewRequestSchema.safeParse(input).success)
      throw new Error('減額明細の数量・整数円の金額を確認してください。');
    const current = generation.current;
    const result = financeValue(
      CreditPreviewDtoSchema,
      await props.api(`/v1/purchase-invoices/${invoice.id}/credit-preview`, input, 'POST'),
    );
    if (current === generation.current) {
      setPreview(result);
      setPreviewInput(JSON.stringify(input));
      setError('');
    }
  }
  async function create() {
    if (
      !preview ||
      JSON.stringify({
        storeId: props.store,
        expectedInvoiceVersion: invoice.version,
        credit: credit(),
      }) !== previewInput
    )
      throw new Error('現在の明細で減額プレビューを確認してください。');
    const input = {
      storeId: props.store,
      invoiceId: invoice.id,
      expectedInvoiceVersion: invoice.version,
      approvedAt: japanInstant(approvedAt),
      reason,
      evidenceId,
      purchaseReturnId: returnId || null,
      credit: credit(),
      expectedPreviewSha256: preview.previewSha256,
    };
    validateFinanceRequest(
      CreditRequestSchema,
      input,
      '仕入先の減額承認日時・理由・根拠資料を入力してください。',
    );
    const current = generation.current;
    const result = financeValue(
      CreditActionDtoSchema,
      await props.post('/v1/purchase-credits', input),
    );
    if (current !== generation.current) return;
    setPreview(null);
    setApprovedAt('');
    setNotice(`仕入先の減額 ${financeYen(result.record.amount)}を記録しました。`);
    await reload();
  }
  return (
    <section className="finance-card">
      <h3>仕入先が承認した減額</h3>
      <p className="finance-note">
        物品返品による在庫の移動と、請求額の減額は別に記録します。仕入先が承認した内容・日時・資料を入力してください。
      </p>
      <CreditHistory props={props} invoice={invoice} reload={reload} />
      <div className="finance-table-scroll">
        <table>
          <caption>原請求から減額できる残り</caption>
          <thead>
            <tr>
              <th>明細</th>
              <th>数量</th>
              <th>税抜額</th>
              <th>税額</th>
              <th>税込額</th>
            </tr>
          </thead>
          <tbody>
            {invoice.creditAvailability.map((item) => (
              <tr key={item.invoiceLineNo}>
                <td>
                  {item.invoiceLineNo}行目：
                  {invoice.content.lines.find((line) => line.lineNo === item.invoiceLineNo)?.name}
                </td>
                <td>{item.remainingQuantity}</td>
                <td>{financeYen(item.remainingNet)}</td>
                <td>{financeYen(item.remainingTax)}</td>
                <td>{financeYen(item.remainingGross)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {invoice.permissions.canCredit && (
        <form
          className="finance-form"
          onSubmit={(event) => {
            event.preventDefault();
            void props.action(create);
          }}
        >
          <div className="finance-field-grid">
            <label>
              減額する原明細
              <select
                value={lineNo}
                onChange={(event) => {
                  setLineNo(event.target.value);
                  setPreview(null);
                }}
              >
                {invoice.creditAvailability.map((item) => (
                  <option key={item.invoiceLineNo} value={item.invoiceLineNo}>
                    {item.invoiceLineNo}行目：
                    {invoice.content.lines.find((line) => line.lineNo === item.invoiceLineNo)?.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              減額の指定
              <select
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value === 'amount' ? 'amount' : 'quantity');
                  setPreview(null);
                }}
              >
                <option value="quantity">数量を指定</option>
                <option value="amount">原書類の金額を指定</option>
              </select>
            </label>
            {mode === 'quantity' ? (
              <label>
                減額する数量
                <input
                  inputMode="numeric"
                  value={quantity}
                  onChange={(event) => {
                    setQuantity(event.target.value);
                    setPreview(null);
                  }}
                />
              </label>
            ) : (
              <>
                <label>
                  減額する税抜額（円）
                  <input
                    inputMode="numeric"
                    value={net}
                    onChange={(event) => {
                      setNet(event.target.value);
                      setPreview(null);
                    }}
                  />
                </label>
                <label>
                  減額する税額（円）
                  <input
                    inputMode="numeric"
                    value={tax}
                    onChange={(event) => {
                      setTax(event.target.value);
                      setPreview(null);
                    }}
                  />
                </label>
                <label>
                  減額する税込額（円）
                  <input
                    inputMode="numeric"
                    value={gross}
                    onChange={(event) => {
                      setGross(event.target.value);
                      setPreview(null);
                    }}
                  />
                </label>
              </>
            )}
          </div>
          <button type="button" disabled={props.busy} onClick={() => void props.action(calculate)}>
            減額と残高をプレビュー
          </button>
          {preview && (
            <div aria-live="polite">
              <p>
                今回の減額：<strong>{financeYen(preview.gross)}</strong> ・減額後の残高：
                <strong>{financeYen(preview.resultingSignedBalance)}</strong>
              </p>
              {preview.issues.length > 0 && (
                <ul>
                  {preview.issues.map((issue, index) => (
                    <li key={index}>{issue.message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="finance-field-grid">
            <label>
              実際の減額承認日時（日本時間）
              <input
                required
                type="datetime-local"
                step="1"
                value={approvedAt}
                onChange={(event) => setApprovedAt(event.target.value)}
              />
            </label>
            <label>
              減額承認の資料
              <select
                required
                value={evidenceId}
                onChange={(event) => setEvidenceId(event.target.value)}
              >
                <option value="">選択してください</option>
                {invoice.evidence
                  .filter((item) => item.role === 'supplier-credit')
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.originalName}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              関連する物品返品
              <select value={returnId} onChange={(event) => setReturnId(event.target.value)}>
                <option value="">関連する返品なし</option>
                {returns
                  .filter((item) => !item.reversedBy && !item.reversalOf)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.reason} ・{item.lines.reduce((sum, line) => sum + line.quantity, 0)}個
                    </option>
                  ))}
              </select>
            </label>
          </div>
          {returnCursor && (
            <button type="button" onClick={() => void loadReturns(returnCursor)}>
              返品候補をさらに表示
            </button>
          )}
          <label>
            減額の理由
            <input
              required
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <button
            className="primary"
            disabled={props.busy || !preview || preview.issues.length > 0}
          >
            仕入先の減額を記録
          </button>
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
