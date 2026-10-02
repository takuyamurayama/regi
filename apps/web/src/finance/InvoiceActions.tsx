import React, { useEffect, useRef, useState } from 'react';
import {
  InvoiceActionDtoSchema,
  InvoicePostRequestSchema,
  InvoiceReasonRequestSchema,
  SupplierConfirmationActionDtoSchema,
  SupplierConfirmationRequestSchema,
  type InvoiceDto,
} from '@regi/core/finance';
import {
  financeDate,
  financeValue,
  financeYen,
  japanDateTime,
  japanInstant,
  validateFinanceRequest,
  type FinanceProps,
} from '../finance-ui';

export function InvoiceActions({
  props,
  invoice,
  dirty,
  update,
}: {
  props: FinanceProps;
  invoice: InvoiceDto;
  dirty: boolean;
  update: (invoice: InvoiceDto) => void;
}) {
  const [effective, setEffective] = useState(japanDateTime);
  const [reason, setReason] = useState('');
  const [varianceReason, setVarianceReason] = useState('');
  const [varianceEvidence, setVarianceEvidence] = useState('');
  const [varianceAccepted, setVarianceAccepted] = useState(false);
  const [counterparty, setCounterparty] = useState('');
  const [confirmedAt, setConfirmedAt] = useState('');
  const [confirmationMethod, setConfirmationMethod] = useState('email');
  const [confirmationEvidence, setConfirmationEvidence] = useState('');
  const [confirmationNote, setConfirmationNote] = useState('');
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [props.scopeKey, invoice.id],
  );
  const base = { storeId: props.store, expectedInvoiceVersion: invoice.version };
  async function post() {
    const acceptance = invoice.preview.taxVarianceAcceptanceRequired
      ? {
          previewSha256: invoice.preview.previewSha256,
          reason: varianceReason,
          evidenceId: varianceEvidence,
        }
      : null;
    if (acceptance && !varianceAccepted)
      throw new Error('原税額との差と根拠資料を確認してください。');
    const input = {
      ...base,
      effectiveAt: japanInstant(effective),
      reason: reason.trim() || null,
      taxVarianceAcceptance: acceptance,
    };
    validateFinanceRequest(InvoicePostRequestSchema, input);
    const current = generation.current;
    const result = financeValue(
      InvoiceActionDtoSchema,
      await props.post(`/v1/purchase-invoices/${invoice.id}/post`, input),
    );
    if (current === generation.current) update(result.invoice);
  }
  async function reverse(action: 'cancel' | 'void') {
    const input = {
      ...base,
      reason,
      ...(action === 'void' ? { effectiveAt: japanInstant(effective) } : {}),
    };
    validateFinanceRequest(
      InvoiceReasonRequestSchema,
      input,
      '取り消す理由と実際の日時を入力してください。',
    );
    const current = generation.current;
    const result = financeValue(
      InvoiceActionDtoSchema,
      await props.post(`/v1/purchase-invoices/${invoice.id}/${action}`, input),
    );
    if (current === generation.current) update(result.invoice);
  }
  async function confirm() {
    const input = {
      ...base,
      postedSnapshotSha256: invoice.postedSnapshotSha256,
      confirmedAt: japanInstant(confirmedAt),
      counterpartyName: counterparty,
      method: confirmationMethod,
      evidenceId: confirmationEvidence,
      note: confirmationNote,
    };
    validateFinanceRequest(
      SupplierConfirmationRequestSchema,
      input,
      '仕入先の確認相手・実際の確認日時・方法・資料を入力してください。',
    );
    const current = generation.current;
    const result = financeValue(
      SupplierConfirmationActionDtoSchema,
      await props.post(`/v1/purchase-invoices/${invoice.id}/confirm-supplier`, input),
    );
    if (current === generation.current) update(result.invoice);
  }
  return (
    <>
      {(invoice.permissions.canPost ||
        invoice.permissions.canCancel ||
        invoice.permissions.canVoid) && (
        <details className="finance-card" open={invoice.state === 'draft'}>
          <summary>
            {invoice.state === 'draft' ? '買掛の確定・下書き取消' : '確定請求を理由付きで取り消す'}
          </summary>
          <h3>{invoice.state === 'draft' ? '下書きの確定・取消' : '確定請求の取消'}</h3>
          {dirty && (
            <p className="finance-warning">編集中の内容を保存してから確定・取消してください。</p>
          )}
          <div className="finance-field-grid">
            {(invoice.permissions.canPost || invoice.permissions.canVoid) && (
              <label>
                実際の債務計上・取消日時（日本時間）
                <input
                  type="datetime-local"
                  step="1"
                  value={effective}
                  onChange={(event) => setEffective(event.target.value)}
                />
              </label>
            )}
            <label>
              計上・取消の理由
              <input
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          </div>
          {invoice.permissions.canPost && invoice.preview.taxVarianceAcceptanceRequired && (
            <fieldset>
              <legend>原税額との差の確認</legend>
              <label>
                税額差を認める理由
                <input
                  maxLength={500}
                  value={varianceReason}
                  onChange={(event) => setVarianceReason(event.target.value)}
                />
              </label>
              <label>
                税額差の根拠資料
                <select
                  value={varianceEvidence}
                  onChange={(event) => setVarianceEvidence(event.target.value)}
                >
                  <option value="">選択してください</option>
                  {invoice.evidence
                    .filter((item) => ['source-invoice', 'tax-variance'].includes(item.role))
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.originalName}
                      </option>
                    ))}
                </select>
              </label>
              <label className="finance-checkbox">
                <input
                  type="checkbox"
                  checked={varianceAccepted}
                  onChange={(event) => setVarianceAccepted(event.target.checked)}
                />
                原書類・税額差・根拠資料を確認した
              </label>
            </fieldset>
          )}
          <div className="finance-actions">
            {invoice.permissions.canPost && (
              <button
                className="primary"
                disabled={props.busy || dirty || invoice.preview.postReadiness === 'incomplete'}
                onClick={() => void props.action(post)}
              >
                買掛 {financeYen(invoice.preview.acceptedGross)}を確定
              </button>
            )}
            {invoice.permissions.canCancel && (
              <button
                disabled={props.busy || dirty}
                onClick={() => void props.action(() => reverse('cancel'))}
              >
                下書きを取り消す
              </button>
            )}
            {invoice.permissions.canVoid && (
              <button
                disabled={props.busy || dirty}
                onClick={() => void props.action(() => reverse('void'))}
              >
                理由を記録して確定請求を取り消す
              </button>
            )}
          </div>
          <p className="finance-note">
            実際の日時を記録します。後着請求は債務発生日と書類受領日を分け、遡って計上する理由を残してください。
          </p>
        </details>
      )}
      {invoice.sourceKind === 'buyer-statement' && invoice.state === 'posted' && (
        <section className="finance-card">
          <h3>仕入先による明細確認</h3>
          <p>
            {invoice.supplierConfirmationStatus === 'confirmed-recorded'
              ? '仕入先の確認記録あり'
              : '仕入先の確認待ち'}
          </p>
          {invoice.confirmations.map((item) => (
            <p key={item.id}>
              {item.counterpartyName} ・{financeDate(item.confirmedAt)} ・
              {item.method === 'email'
                ? 'メール'
                : item.method === 'signed-document'
                  ? '署名書類'
                  : item.method === 'recorded-meeting'
                    ? '打合せ記録'
                    : 'その他'}
            </p>
          ))}
          {invoice.permissions.canConfirmSupplier && (
            <details>
              <summary>仕入先の確認を記録</summary>
              <form
                className="finance-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void props.action(confirm);
                }}
              >
                <div className="finance-field-grid">
                  <label>
                    確認した仕入先の相手名
                    <input
                      required
                      maxLength={200}
                      value={counterparty}
                      onChange={(event) => setCounterparty(event.target.value)}
                    />
                  </label>
                  <label>
                    実際の確認日時（日本時間）
                    <input
                      required
                      type="datetime-local"
                      step="1"
                      value={confirmedAt}
                      onChange={(event) => setConfirmedAt(event.target.value)}
                    />
                  </label>
                  <label>
                    確認方法
                    <select
                      value={confirmationMethod}
                      onChange={(event) => setConfirmationMethod(event.target.value)}
                    >
                      <option value="email">メール</option>
                      <option value="signed-document">署名書類</option>
                      <option value="recorded-meeting">打合せ記録</option>
                      <option value="other">その他</option>
                    </select>
                  </label>
                  <label>
                    仕入先確認の資料
                    <select
                      required
                      value={confirmationEvidence}
                      onChange={(event) => setConfirmationEvidence(event.target.value)}
                    >
                      <option value="">選択してください</option>
                      {invoice.evidence
                        .filter((item) => item.role === 'supplier-confirmation')
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.originalName}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                <label>
                  確認内容の補足
                  <textarea
                    maxLength={500}
                    value={confirmationNote}
                    onChange={(event) => setConfirmationNote(event.target.value)}
                  />
                </label>
                <button disabled={props.busy}>仕入先の実際の確認を記録</button>
              </form>
            </details>
          )}
        </section>
      )}
    </>
  );
}
