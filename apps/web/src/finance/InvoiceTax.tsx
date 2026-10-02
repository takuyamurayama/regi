import React from 'react';
import type { EvidenceDto, InvoicePreviewDto, TaxAmounts } from '@regi/core/finance';
import { financeYen } from '../finance-ui';
import type { InvoiceForm } from './invoice-form';

export function InvoiceTax({
  form,
  setForm,
  preview,
  evidence,
  disabled,
}: {
  form: InvoiceForm;
  setForm: (form: InvoiceForm) => void;
  preview: InvoicePreviewDto | null;
  evidence: EvidenceDto[];
  disabled: boolean;
}) {
  const treatment = form.draft.taxTreatment;
  function updateGroup(index: number, field: keyof TaxAmounts, value: string) {
    if (treatment.mode !== 'supplier-stated') return;
    setForm({
      ...form,
      draft: {
        ...form.draft,
        taxTreatment: {
          ...treatment,
          groups: treatment.groups.map((group, position) =>
            position === index ? { ...group, [field]: value } : group,
          ),
        },
      },
    });
  }
  return (
    <section className="finance-card">
      <h3>税額と原書類の確認</h3>
      <label>
        税額の根拠
        <select
          disabled={disabled}
          value={treatment.mode}
          onChange={(event) => {
            if (event.target.value === 'computed')
              setForm({ ...form, draft: { ...form.draft, taxTreatment: { mode: 'computed' } } });
            else
              setForm({
                ...form,
                draft: {
                  ...form.draft,
                  taxTreatment: {
                    mode: 'supplier-stated',
                    groups: (preview?.taxGroups ?? []).map((group) => ({
                      groupKey: group.groupKey,
                      net: '',
                      tax: '',
                      gross: '',
                    })),
                    evidenceId: null,
                    reason: null,
                  },
                },
              });
          }}
        >
          <option value="computed">明細から計算</option>
          <option value="supplier-stated">仕入先の原書類から転記</option>
        </select>
      </label>
      <p className="finance-note">
        仕入先から受領した請求書は、税率ごとに原書類の金額を転記します。まず明細の計算プレビューで税区分を確認してください。
      </p>
      {treatment.mode === 'supplier-stated' && (
        <fieldset disabled={disabled}>
          <legend>原書類に記載された金額</legend>
          {treatment.groups.map((group, index) => (
            <div className="finance-field-grid" key={index}>
              <label>
                税区分
                <select
                  value={group.groupKey}
                  onChange={(event) => updateGroup(index, 'groupKey', event.target.value)}
                >
                  <option value={group.groupKey}>
                    {group.groupKey.startsWith('taxable:')
                      ? `課税 ${Number(group.groupKey.slice(8)) / 100}%`
                      : group.groupKey === 'non-taxable'
                        ? '非課税'
                        : '不課税'}
                  </option>
                </select>
              </label>
              <label>
                原書類の税抜額（円）
                <input
                  inputMode="numeric"
                  value={group.net}
                  onChange={(event) => updateGroup(index, 'net', event.target.value)}
                />
              </label>
              <label>
                原書類の税額（円）
                <input
                  inputMode="numeric"
                  value={group.tax}
                  onChange={(event) => updateGroup(index, 'tax', event.target.value)}
                />
              </label>
              <label>
                原書類の税込額（円）
                <input
                  inputMode="numeric"
                  value={group.gross}
                  onChange={(event) => updateGroup(index, 'gross', event.target.value)}
                />
              </label>
            </div>
          ))}
          {treatment.groups.length === 0 && (
            <p role="alert">
              税区分が未設定です。「明細から計算」でプレビュー後、原書類からの転記に切り替えてください。
            </p>
          )}
          <label>
            原税額を確認できる資料
            <select
              value={treatment.evidenceId ?? ''}
              onChange={(event) =>
                setForm({
                  ...form,
                  draft: {
                    ...form.draft,
                    taxTreatment: { ...treatment, evidenceId: event.target.value || null },
                  },
                })
              }
            >
              <option value="">未選択</option>
              {evidence
                .filter((item) => ['source-invoice', 'tax-variance'].includes(item.role))
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.originalName}
                  </option>
                ))}
            </select>
          </label>
          <label>
            原税額についての補足
            <input
              maxLength={500}
              value={treatment.reason ?? ''}
              onChange={(event) =>
                setForm({
                  ...form,
                  draft: {
                    ...form.draft,
                    taxTreatment: { ...treatment, reason: event.target.value || null },
                  },
                })
              }
            />
          </label>
        </fieldset>
      )}
      {preview && (
        <div aria-live="polite">
          <div className="finance-summary">
            <div>
              <span>明細からの計算額</span>
              <strong>{financeYen(preview.computedGross)}</strong>
            </div>
            <div>
              <span>原書類の記載額</span>
              <strong>{financeYen(preview.statedGross)}</strong>
            </div>
            <div>
              <span>確定候補額</span>
              <strong>{financeYen(preview.acceptedGross)}</strong>
            </div>
          </div>
          <div className="finance-table-scroll">
            <table>
              <caption>税区分ごとの確認</caption>
              <thead>
                <tr>
                  <th>税区分</th>
                  <th>計算税額</th>
                  <th>原税額</th>
                  <th>税額差</th>
                  <th>確認</th>
                </tr>
              </thead>
              <tbody>
                {preview.taxGroups.map((group) => (
                  <tr key={group.groupKey}>
                    <td>
                      {group.taxCategory === 'taxable'
                        ? `課税 ${group.rateBps / 100}%`
                        : group.taxCategory === 'non-taxable'
                          ? '非課税'
                          : '不課税'}
                    </td>
                    <td>{financeYen(group.computed.tax)}</td>
                    <td>{financeYen(group.supplierStated?.tax ?? null)}</td>
                    <td>{financeYen(group.deltaTax)}</td>
                    <td>{group.withinLimit ? '許容範囲' : '原書類・明細を確認'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.completionIssues.length > 0 && (
            <div className="finance-warning" role="status">
              <h4>確定前に確認する項目</h4>
              <ul>
                {preview.completionIssues.map((issue, index) => (
                  <li key={`${issue.code}:${index}`}>{issue.message}</li>
                ))}
              </ul>
            </div>
          )}
          {preview.taxVarianceAcceptanceRequired && (
            <p className="finance-warning">
              原税額と計算税額に端数差があります。確定時に管理者が理由と根拠資料を記録してください。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
