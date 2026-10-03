import React from 'react';
import type { EvidenceDto, SupplierDto, TaxCategory } from '@regi/core/finance';
import { newInvoiceLine, selectInvoiceSupplier, type InvoiceForm } from './invoice-form';

interface Props {
  form: InvoiceForm;
  setForm: (form: InvoiceForm) => void;
  suppliers: SupplierDto[];
  supplierId: string;
  selectSupplier: (id: string) => void;
  evidence: EvidenceDto[];
  existing: boolean;
  existingSupplierName?: string;
  disabled: boolean;
}
export function InvoiceFields(props: Props) {
  const { form, setForm, disabled } = props;
  const draft = form.draft;
  const update = (fields: Partial<typeof draft>) =>
    setForm({ ...form, draft: { ...draft, ...fields } });
  return (
    <fieldset disabled={disabled} className="finance-fields">
      <legend>原請求の内容</legend>
      <div className="finance-field-grid">
        <label>
          仕入先
          <select
            required
            value={props.supplierId}
            disabled={props.existing}
            onChange={(event) => {
              const selected = props.suppliers.find((item) => item.id === event.target.value);
              props.selectSupplier(event.target.value);
              if (selected) setForm(selectInvoiceSupplier(form, selected));
            }}
          >
            <option value="">選択してください</option>
            {props.existing &&
              props.supplierId &&
              !props.suppliers.some((item) => item.id === props.supplierId) && (
                <option value={props.supplierId}>
                  {props.existingSupplierName ?? 'この請求の仕入先'}
                </option>
              )}
            {props.suppliers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.active ? '' : '（無効）'}
              </option>
            ))}
          </select>
        </label>
        <label>
          書類の種類
          <select
            value={draft.sourceKind}
            onChange={(event) =>
              update({
                sourceKind:
                  event.target.value === 'buyer-statement' ? 'buyer-statement' : 'supplier-invoice',
              })
            }
          >
            <option value="supplier-invoice">仕入先から受領した請求書</option>
            <option value="buyer-statement">当社が作成する仕入明細書</option>
          </select>
        </label>
        <label>
          原番号の有無
          <select
            value={draft.sourceIdentity?.kind ?? 'numbered'}
            onChange={(event) =>
              update({
                sourceIdentity:
                  event.target.value === 'unnumbered'
                    ? {
                        kind: 'unnumbered',
                        sourceReference: '',
                        identificationReason: '',
                        sourceEvidenceId: null,
                      }
                    : { kind: 'numbered', invoiceNumber: '' },
              })
            }
          >
            <option value="numbered">原書類に番号がある</option>
            <option value="unnumbered">原書類に番号がない</option>
          </select>
        </label>
        {draft.sourceIdentity?.kind === 'numbered' ? (
          <label>
            原請求番号
            <input
              maxLength={200}
              value={draft.sourceIdentity.invoiceNumber}
              onChange={(event) =>
                update({ sourceIdentity: { kind: 'numbered', invoiceNumber: event.target.value } })
              }
            />
          </label>
        ) : (
          <>
            <label>
              原書類の識別名
              <input
                maxLength={200}
                value={draft.sourceIdentity?.sourceReference ?? ''}
                onChange={(event) =>
                  update({
                    sourceIdentity: {
                      kind: 'unnumbered',
                      sourceReference: event.target.value,
                      identificationReason:
                        draft.sourceIdentity?.kind === 'unnumbered'
                          ? draft.sourceIdentity.identificationReason
                          : '',
                      sourceEvidenceId: draft.sourceEvidenceId,
                    },
                  })
                }
              />
            </label>
            <label>
              番号なし書類の識別根拠
              <input
                maxLength={500}
                value={
                  draft.sourceIdentity?.kind === 'unnumbered'
                    ? draft.sourceIdentity.identificationReason
                    : ''
                }
                onChange={(event) => {
                  if (draft.sourceIdentity?.kind === 'unnumbered')
                    update({
                      sourceIdentity: {
                        ...draft.sourceIdentity,
                        identificationReason: event.target.value,
                      },
                    });
                }}
              />
            </label>
          </>
        )}
        <label>
          原請求日
          <input
            type="date"
            value={draft.invoiceDate ?? ''}
            onChange={(event) => update({ invoiceDate: event.target.value || null })}
          />
        </label>
        <label>
          支払期日
          <input
            type="date"
            value={draft.dueDate ?? ''}
            onChange={(event) => update({ dueDate: event.target.value || null })}
          />
        </label>
        <label>
          原書類を受領した日
          <input
            type="date"
            value={draft.sourceReceivedDate ?? ''}
            onChange={(event) => update({ sourceReceivedDate: event.target.value || null })}
          />
        </label>
        <label>
          取引期間・開始
          <input
            type="date"
            value={draft.transactionFrom ?? ''}
            onChange={(event) => update({ transactionFrom: event.target.value || null })}
          />
        </label>
        <label>
          取引期間・終了
          <input
            type="date"
            value={draft.transactionTo ?? ''}
            onChange={(event) => update({ transactionTo: event.target.value || null })}
          />
        </label>
        <label>
          原書類の添付
          <select
            value={draft.sourceEvidenceId ?? ''}
            onChange={(event) => {
              const id = event.target.value || null;
              update({
                sourceEvidenceId: id,
                ...(draft.sourceIdentity?.kind === 'unnumbered'
                  ? { sourceIdentity: { ...draft.sourceIdentity, sourceEvidenceId: id } }
                  : {}),
              });
            }}
          >
            <option value="">未選択</option>
            {props.evidence
              .filter((item) => item.role === 'source-invoice')
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.originalName}
                </option>
              ))}
          </select>
        </label>
        <label>
          価格の記載
          <select
            value={draft.priceMode}
            onChange={(event) =>
              update({ priceMode: event.target.value === 'inclusive' ? 'inclusive' : 'exclusive' })
            }
          >
            <option value="exclusive">税抜</option>
            <option value="inclusive">税込</option>
          </select>
        </label>
        <label>
          税額の端数処理
          <select
            value={draft.rounding}
            onChange={(event) =>
              update({
                rounding:
                  event.target.value === 'ceil'
                    ? 'ceil'
                    : event.target.value === 'nearest'
                      ? 'nearest'
                      : 'floor',
              })
            }
          >
            <option value="floor">切捨て</option>
            <option value="nearest">四捨五入</option>
            <option value="ceil">切上げ</option>
          </select>
        </label>
      </div>
      <p className="finance-note">
        原書類の日付はそのまま入力してください。債務の計上日時・実際の支払日時は別に記録します。添付は下書き保存後に追加できます。
      </p>
      <div className="finance-field-grid">
        <label>
          原書類の売手名称
          <input
            maxLength={200}
            value={draft.seller?.name ?? ''}
            onChange={(event) =>
              update({
                seller: {
                  name: event.target.value,
                  address: draft.seller?.address ?? '',
                  registered: draft.seller?.registered ?? false,
                  registrationNumber: draft.seller?.registrationNumber ?? null,
                },
              })
            }
          />
        </label>
        <label>
          原書類の売手住所
          <input
            maxLength={300}
            value={draft.seller?.address ?? ''}
            onChange={(event) =>
              update({
                seller: {
                  name: draft.seller?.name ?? '',
                  address: event.target.value,
                  registered: draft.seller?.registered ?? false,
                  registrationNumber: draft.seller?.registrationNumber ?? null,
                },
              })
            }
          />
        </label>
        <label>
          原書類の買手名称
          <input
            maxLength={200}
            value={draft.buyer?.name ?? ''}
            onChange={(event) =>
              update({ buyer: { name: event.target.value, address: draft.buyer?.address ?? '' } })
            }
          />
        </label>
        <label>
          原書類の買手住所
          <input
            maxLength={300}
            value={draft.buyer?.address ?? ''}
            onChange={(event) =>
              update({ buyer: { name: draft.buyer?.name ?? '', address: event.target.value } })
            }
          />
        </label>
        <label>
          売手の登録区分
          <select
            value={draft.seller?.registered ? 'registered' : 'unregistered'}
            onChange={(event) =>
              update({
                seller: {
                  name: draft.seller?.name ?? '',
                  address: draft.seller?.address ?? '',
                  registered: event.target.value === 'registered',
                  registrationNumber: event.target.value === 'registered' ? '' : null,
                },
              })
            }
          >
            <option value="unregistered">非登録</option>
            <option value="registered">登録あり</option>
          </select>
        </label>
        {draft.seller?.registered && (
          <label>
            原書類の売手登録番号
            <input
              maxLength={14}
              value={draft.seller.registrationNumber ?? ''}
              onChange={(event) =>
                update({ seller: { ...draft.seller!, registrationNumber: event.target.value } })
              }
            />
          </label>
        )}
      </div>
      <h3>取引明細</h3>
      {form.lines.map((line, index) => (
        <div className="finance-line-card" key={index}>
          <h4>{index + 1}行目</h4>
          <div className="finance-field-grid">
            <label>
              品目名称
              <input
                maxLength={200}
                value={line.name}
                onChange={(event) =>
                  setForm({
                    ...form,
                    lines: form.lines.map((item, position) =>
                      position === index ? { ...item, name: event.target.value } : item,
                    ),
                  })
                }
              />
            </label>
            <label>
              実取引日
              <input
                type="date"
                value={line.transactionDate}
                onChange={(event) =>
                  setForm({
                    ...form,
                    lines: form.lines.map((item, position) =>
                      position === index ? { ...item, transactionDate: event.target.value } : item,
                    ),
                  })
                }
              />
            </label>
            <label>
              数量
              <input
                inputMode="numeric"
                value={line.quantity}
                onChange={(event) =>
                  setForm({
                    ...form,
                    lines: form.lines.map((item, position) =>
                      position === index ? { ...item, quantity: event.target.value } : item,
                    ),
                  })
                }
              />
            </label>
            <label>
              単価（円）
              <input
                inputMode="numeric"
                value={line.unitAmount}
                onChange={(event) =>
                  setForm({
                    ...form,
                    lines: form.lines.map((item, position) =>
                      position === index ? { ...item, unitAmount: event.target.value } : item,
                    ),
                  })
                }
              />
            </label>
            <label>
              行全体の値引（円）
              <input
                inputMode="numeric"
                value={line.discountAmount}
                onChange={(event) =>
                  setForm({
                    ...form,
                    lines: form.lines.map((item, position) =>
                      position === index ? { ...item, discountAmount: event.target.value } : item,
                    ),
                  })
                }
              />
            </label>
            <label>
              税区分
              <select
                value={line.taxCategory}
                onChange={(event) => {
                  const taxCategory: TaxCategory =
                    event.target.value === 'non-taxable'
                      ? 'non-taxable'
                      : event.target.value === 'out-of-scope'
                        ? 'out-of-scope'
                        : 'taxable';
                  setForm({
                    ...form,
                    lines: form.lines.map((item, position) =>
                      position === index
                        ? {
                            ...item,
                            taxCategory,
                            ...(taxCategory === 'taxable'
                              ? {}
                              : { ratePercent: '0', reducedTarget: false }),
                          }
                        : item,
                    ),
                  });
                }}
              >
                <option value="taxable">課税</option>
                <option value="non-taxable">非課税</option>
                <option value="out-of-scope">不課税</option>
              </select>
            </label>
            <label>
              税率（%）
              <input
                inputMode="decimal"
                disabled={line.taxCategory !== 'taxable'}
                value={line.ratePercent}
                onChange={(event) =>
                  setForm({
                    ...form,
                    lines: form.lines.map((item, position) =>
                      position === index ? { ...item, ratePercent: event.target.value } : item,
                    ),
                  })
                }
              />
            </label>
            <label className="finance-checkbox">
              <input
                type="checkbox"
                disabled={line.taxCategory !== 'taxable'}
                checked={line.reducedTarget}
                onChange={(event) =>
                  setForm({
                    ...form,
                    lines: form.lines.map((item, position) =>
                      position === index ? { ...item, reducedTarget: event.target.checked } : item,
                    ),
                  })
                }
              />
              軽減税率対象
            </label>
            <label>
              入荷記録と未照合の理由
              <input
                maxLength={500}
                value={line.unmatchedReason}
                onChange={(event) =>
                  setForm({
                    ...form,
                    lines: form.lines.map((item, position) =>
                      position === index ? { ...item, unmatchedReason: event.target.value } : item,
                    ),
                  })
                }
              />
            </label>
          </div>
          <p>
            入荷との照合：
            {line.receiptAllocations.reduce((sum, allocation) => sum + allocation.quantity, 0)}個
          </p>
          <button
            type="button"
            onClick={() =>
              setForm({ ...form, lines: form.lines.filter((_, position) => position !== index) })
            }
          >
            この明細を削除
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={form.lines.length >= 500}
        onClick={() =>
          setForm({ ...form, lines: [...form.lines, newInvoiceLine(form.lines.length + 1)] })
        }
      >
        明細を追加
      </button>
      <label>
        備考
        <textarea
          maxLength={500}
          value={draft.note}
          onChange={(event) => update({ note: event.target.value })}
        />
      </label>
    </fieldset>
  );
}
