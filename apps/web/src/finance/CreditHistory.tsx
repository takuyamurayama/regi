import React, { useEffect, useRef, useState } from 'react';
import {
  CreditActionDtoSchema,
  FactReverseRequestSchema,
  type InvoiceDto,
  type LedgerEntryDto,
} from '@regi/core/finance';
import {
  financeDate,
  financeValue,
  financeYen,
  japanInstant,
  validateFinanceRequest,
  type FinanceProps,
} from '../finance-ui';

export function CreditHistory({
  props,
  invoice,
  reload,
}: {
  props: FinanceProps;
  invoice: InvoiceDto;
  reload: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<LedgerEntryDto | null>(null);
  const [reason, setReason] = useState('');
  const [effectiveAt, setEffectiveAt] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const entries = invoice.ledger.filter((entry) => entry.kind === 'supplier-credit');
  const canReverse = ['admin', 'headquarters'].includes(props.actorRole);
  useEffect(
    () => () => {
      generation.current++;
    },
    [props.scopeKey, invoice.id],
  );
  async function reverse() {
    if (!selected) return;
    const input = {
      storeId: props.store,
      expectedInvoiceVersion: invoice.version,
      effectiveAt: japanInstant(effectiveAt),
      reason,
      evidenceId: null,
    };
    validateFinanceRequest(
      FactReverseRequestSchema,
      input,
      '減額の取消理由と実際の取消日時を入力してください。',
    );
    const current = generation.current;
    financeValue(
      CreditActionDtoSchema,
      await props.post(`/v1/purchase-credits/${selected.factId}/reverse`, input),
    );
    if (current !== generation.current) return;
    setSelected(null);
    setReason('');
    setEffectiveAt('');
    setNotice('元の減額を保持し、取消記録を追加しました。');
    await reload();
  }
  if (entries.length === 0) return null;
  return (
    <div className="finance-credit-history">
      <div className="finance-table-scroll">
        <table>
          <caption>仕入先の減額履歴</caption>
          <thead>
            <tr>
              <th>承認日時</th>
              <th>減額</th>
              <th>理由</th>
              <th>状態</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const reversed = invoice.ledger.some((item) => item.reversalOf === entry.id);
              return (
                <tr key={entry.id}>
                  <td>{financeDate(entry.occurredAt)}</td>
                  <td>{financeYen(entry.amount)}</td>
                  <td>{entry.reason}</td>
                  <td>{reversed ? '取消済み' : '有効'}</td>
                  <td>
                    {canReverse && !reversed && (
                      <button
                        type="button"
                        disabled={props.busy}
                        onClick={() => {
                          setSelected(entry);
                          setReason('');
                          setEffectiveAt('');
                        }}
                      >
                        減額を理由付きで取り消す
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {notice && <p role="status">{notice}</p>}
      {selected && (
        <form
          className="finance-form finance-warning"
          onSubmit={(event) => {
            event.preventDefault();
            void props.action(reverse);
          }}
        >
          <h4>{financeYen(selected.amount)}の減額を取り消す</h4>
          <label>
            減額の取消理由
            <input
              required
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <label>
            減額の実際の取消日時（日本時間）
            <input
              required
              type="datetime-local"
              step="1"
              value={effectiveAt}
              onChange={(event) => setEffectiveAt(event.target.value)}
            />
          </label>
          <div className="finance-actions">
            <button disabled={props.busy}>減額の取消記録を追加</button>
            <button type="button" disabled={props.busy} onClick={() => setSelected(null)}>
              やめる
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
