import React, { useEffect, useRef, useState } from 'react';
import {
  InvoiceCreateRequestSchema,
  InvoiceDtoSchema,
  InvoiceEditRequestSchema,
  InvoicePreviewDtoSchema,
  InvoicePreviewRequestSchema,
  SupplierDtoSchema,
  financePageSchema,
  type InvoiceDto,
  type InvoicePreviewDto,
  type SupplierDto,
} from '@regi/core/finance';
import {
  financeDate,
  financeMessage,
  financePath,
  financeValue,
  financeYen,
  validateFinanceRequest,
  type FinanceProps,
} from '../finance-ui';
import { InvoiceFields } from './InvoiceFields';
import { InvoiceTax } from './InvoiceTax';
import { ReceiptMatching } from './ReceiptMatching';
import { FinanceEvidence } from './Evidence';
import { InvoiceActions } from './InvoiceActions';
import { InvoiceCorrection } from './Correction';
import { InvoiceSettlements } from './Settlements';
import { InvoiceCredits } from './Credits';
import { FinanceExports } from './Exports';
import { invoiceDraft, invoiceForm, type InvoiceForm } from './invoice-form';

export function FinanceInvoiceEditor({ props, close }: { props: FinanceProps; close: () => void }) {
  const [invoice, setInvoice] = useState<InvoiceDto | null>(null);
  const [form, setForm] = useState<InvoiceForm>(invoiceForm);
  const [supplierId, setSupplierId] = useState('');
  const [suppliers, setSuppliers] = useState<SupplierDto[]>([]);
  const [supplierCursor, setSupplierCursor] = useState<string | null>(null);
  const [preview, setPreview] = useState<InvoicePreviewDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [exportFormat, setExportFormat] = useState<
    'purchase-invoice-pdf' | 'purchase-finance-bundle'
  >('purchase-invoice-pdf');
  const generation = useRef(0);
  const existingId = props.invoiceId;
  const dirty =
    invoice !== null && JSON.stringify(form) !== JSON.stringify(invoiceForm(invoice.content));
  const editable = invoice ? invoice.permissions.canEdit : true;
  function update(result: InvoiceDto) {
    setInvoice(result);
    setSupplierId(result.supplierId);
    setForm(invoiceForm(result.content));
    setPreview(result.preview);
  }
  async function load(keepForm = true) {
    if (!existingId) {
      setLoading(false);
      return;
    }
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const result = financeValue(
        InvoiceDtoSchema,
        await props.api(financePath(`/v1/purchase-invoices/${existingId}`, props.store)),
      );
      if (current !== generation.current) return;
      if (keepForm) {
        setInvoice(result);
        setSupplierId(result.supplierId);
        if (!dirty) {
          setForm(invoiceForm(result.content));
          setPreview(result.preview);
        }
      } else update(result);
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
          `/v1/suppliers?${new URLSearchParams({ active: existingId ? 'all' : 'true', pageSize: '50', ...(cursor ? { cursor } : {}) })}`,
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
  useEffect(() => {
    void load(false);
    void loadSuppliers();
    return () => {
      generation.current++;
    };
  }, [props.scopeKey, existingId]);
  function change(next: InvoiceForm) {
    setForm(next);
    setPreview(null);
    setNotice('');
  }
  async function save() {
    const draft = invoiceDraft(form);
    const input = invoice
      ? { storeId: props.store, version: invoice.version, draft }
      : { storeId: props.store, supplierId, predecessorInvoiceId: null, draft };
    validateFinanceRequest(invoice ? InvoiceEditRequestSchema : InvoiceCreateRequestSchema, input);
    const current = generation.current;
    const result = financeValue(
      InvoiceDtoSchema,
      await props.post(
        invoice ? `/v1/purchase-invoices/${invoice.id}` : '/v1/purchase-invoices',
        input,
        invoice ? 'PATCH' : 'POST',
      ),
    );
    if (current !== generation.current) return;
    update(result);
    setNotice('下書きを保存しました。買掛はまだ確定していません。');
    if (!existingId)
      props.navigate(
        `/purchases/invoices/${result.id}?${new URLSearchParams({ storeId: props.store })}`,
      );
  }
  async function calculate() {
    const input = {
      storeId: props.store,
      supplierId,
      invoiceId: invoice?.id ?? null,
      version: invoice?.version ?? null,
      draft: invoiceDraft(form),
    };
    if (!InvoicePreviewRequestSchema.safeParse(input).success)
      throw new Error('仕入先と明細の入力を確認してください。');
    const current = generation.current;
    const result = financeValue(
      InvoicePreviewDtoSchema,
      await props.api('/v1/purchase-invoices/preview', input, 'POST'),
    );
    if (current === generation.current) {
      setPreview(result);
      setError('');
    }
  }
  if (loading && !invoice) return <p role="status">請求を取得しています…</p>;
  if (existingId && !invoice)
    return (
      <div className="finance-card">
        <p role="alert">{error || '請求を確認できませんでした。'}</p>
        <button onClick={() => void load(false)}>再取得</button>
        <button onClick={close}>一覧へ戻る</button>
      </div>
    );
  return (
    <section className="finance-section" aria-labelledby="invoice-detail-heading">
      <header className="finance-section-header">
        <div>
          <h2 id="invoice-detail-heading">{invoice ? '仕入請求の詳細' : '仕入請求の下書き'}</h2>
          {invoice && (
            <>
              <p>
                {invoice.supplierName} ・
                {invoice.state === 'draft'
                  ? '下書き'
                  : invoice.state === 'posted'
                    ? '確定済み'
                    : invoice.state === 'voided'
                      ? '確定取消済み'
                      : '下書き取消済み'}{' '}
                ・版 {invoice.revision}
              </p>
              <p className="finance-reference">
                {invoice.sourceIdentity?.kind === 'numbered'
                  ? `原請求番号：${invoice.sourceIdentity.invoiceNumber}`
                  : invoice.sourceIdentity?.kind === 'unnumbered'
                    ? `原書類の識別：${invoice.sourceIdentity.sourceReference}`
                    : '原請求の識別は未入力'}
                <small>管理番号：{invoice.internalReference}</small>
              </p>
            </>
          )}
        </div>
        <button disabled={props.busy} onClick={close}>
          請求一覧へ
        </button>
      </header>
      {error && (
        <p role="alert" className="finance-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {invoice && (
        <div className="finance-summary">
          <div>
            <span>原請求額</span>
            <strong>{financeYen(invoice.balance.originalGross)}</strong>
          </div>
          <div>
            <span>未払残高</span>
            <strong>{financeYen(invoice.balance.payableAmount)}</strong>
          </div>
          <div>
            <span>返金待ち</span>
            <strong>{financeYen(invoice.balance.refundDueAmount)}</strong>
          </div>
          <div>
            <span>支払期日</span>
            <strong>{invoice.dueDate ?? '未入力'}</strong>
          </div>
        </div>
      )}
      {invoice?.state === 'draft' && invoice.completionIssues.length > 0 && (
        <div className="finance-warning">
          <h3>確定前に確認する項目</h3>
          <ul>
            {invoice.completionIssues.map((issue, index) => (
              <li key={index}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}
      <details className="finance-snapshot" open={editable}>
        <summary>
          {editable
            ? '原請求と取引明細を入力'
            : `確定済みの原請求・税額を確認（${invoice?.content.lines.length ?? 0}明細）`}
        </summary>
        <form
          className="finance-form"
          onSubmit={(event) => {
            event.preventDefault();
            void props.action(save);
          }}
        >
          <InvoiceFields
            form={form}
            setForm={change}
            suppliers={suppliers}
            supplierId={supplierId}
            selectSupplier={setSupplierId}
            evidence={invoice?.evidence ?? []}
            existing={invoice !== null}
            existingSupplierName={invoice?.supplierName}
            disabled={props.busy || !editable}
          />
          {supplierCursor && editable && (
            <button type="button" onClick={() => void loadSuppliers(supplierCursor)}>
              仕入先をさらに読み込む
            </button>
          )}
          {editable && (
            <div className="finance-actions">
              <button
                type="button"
                disabled={props.busy}
                onClick={() => void props.action(calculate)}
              >
                明細・税額をプレビュー
              </button>
              <button className="primary" disabled={props.busy}>
                下書きを保存
              </button>
            </div>
          )}
        </form>
        {editable && supplierId && (
          <ReceiptMatching
            props={props}
            supplierId={supplierId}
            invoiceId={invoice?.id}
            form={form}
            setForm={change}
          />
        )}
        <InvoiceTax
          form={form}
          setForm={change}
          preview={preview}
          evidence={invoice?.evidence ?? []}
          disabled={props.busy || !editable}
        />
      </details>
      {invoice && (
        <>
          <details className="finance-snapshot" open={invoice.state === 'draft'}>
            <summary>原書類・関連資料（{invoice.evidence.length}件）</summary>
            <FinanceEvidence props={props} invoice={invoice} reload={load} />
          </details>
          <InvoiceActions props={props} invoice={invoice} dirty={dirty} update={update} />
          <InvoiceCorrection props={props} invoice={invoice} />
          {invoice.state === 'posted' && (
            <>
              <InvoiceSettlements props={props} invoice={invoice} reload={load} kind="payment" />
              <details className="finance-snapshot">
                <summary>仕入先承認済みの減額を記録・確認</summary>
                <InvoiceCredits props={props} invoice={invoice} reload={load} />
              </details>
              {(BigInt(invoice.balance.refundDueAmount) > 0n ||
                invoice.ledger.some((entry) =>
                  ['supplier-refund', 'refund-reversal'].includes(entry.kind),
                )) && (
                <InvoiceSettlements props={props} invoice={invoice} reload={load} kind="refund" />
              )}
            </>
          )}
          <section className="finance-card">
            <h3>残高の履歴</h3>
            <div className="finance-table-scroll">
              <table>
                <caption>請求・支払・減額・返金の記録</caption>
                <thead>
                  <tr>
                    <th>種類</th>
                    <th>実際の日時</th>
                    <th>記録日時</th>
                    <th>増減額</th>
                    <th>理由</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.ledger.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        {
                          {
                            'invoice-debit': '買掛確定',
                            'invoice-void': '請求取消',
                            'supplier-credit': '仕入先減額',
                            'credit-reversal': '減額取消',
                            payment: '支払',
                            'payment-reversal': '支払取消',
                            'supplier-refund': '返金受領',
                            'refund-reversal': '返金受領取消',
                          }[entry.kind]
                        }
                      </td>
                      <td>{financeDate(entry.occurredAt)}</td>
                      <td>{financeDate(entry.recordedAt)}</td>
                      <td>{financeYen(entry.signedAmount)}</td>
                      <td>{entry.reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="finance-card">
            <h3>請求書・関連記録の出力</h3>
            <p className="finance-note">
              この請求の記録を取得時点で固定します。関連資料の一括出力が上限を超える場合、原ファイルを個別に取得してください。
            </p>
            <label>
              出力内容
              <select
                value={exportFormat}
                onChange={(event) =>
                  setExportFormat(
                    event.target.value === 'purchase-finance-bundle'
                      ? 'purchase-finance-bundle'
                      : 'purchase-invoice-pdf',
                  )
                }
              >
                <option value="purchase-invoice-pdf">請求・仕入明細のPDF</option>
                <option value="purchase-finance-bundle">請求と関連資料の一括出力</option>
              </select>
            </label>
            <FinanceExports
              key={`${invoice.id}:${exportFormat}`}
              props={props}
              request={() => ({
                storeId: props.store,
                format: exportFormat,
                invoiceId: invoice.id,
                asOf: new Date().toISOString(),
                viewToken: null,
              })}
            />
          </section>
        </>
      )}
    </section>
  );
}
