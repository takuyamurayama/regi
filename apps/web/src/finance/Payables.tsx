import React, { useEffect, useRef, useState } from 'react';
import { PayablesPageDtoSchema, type PayablesPageDto } from '@regi/core/finance';
import {
  financeDate,
  financeMessage,
  financePath,
  financeValue,
  financeYen,
  japanInstant,
  type FinanceProps,
} from '../finance-ui';
import { FinanceExports } from './Exports';

export function FinancePayables(props: FinanceProps) {
  const [page, setPage] = useState<PayablesPageDto | null>(null);
  const [status, setStatus] = useState('all');
  const [overdue, setOverdue] = useState('all');
  const [dueFrom, setDueFrom] = useState('');
  const [dueTo, setDueTo] = useState('');
  const [asOf, setAsOf] = useState('');
  const [allStores, setAllStores] = useState(false);
  const [loadedQuery, setLoadedQuery] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  function query(): Record<string, string> {
    return {
      status,
      overdue,
      ...(dueFrom ? { dueFrom } : {}),
      ...(dueTo ? { dueTo } : {}),
      ...(asOf ? { asOf: japanInstant(asOf) } : {}),
    };
  }
  async function load(cursor: string | null = null) {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const filters = cursor ? loadedQuery : query();
      const selectedStore = allStores ? 'all' : props.store;
      const next = financeValue(
        PayablesPageDtoSchema,
        await props.api(
          financePath('/v1/payables', selectedStore, {
            ...filters,
            pageSize: '50',
            ...(cursor
              ? { cursor, asOf: page?.asOf ?? filters.asOf ?? new Date().toISOString() }
              : {}),
          }),
        ),
      );
      if (current !== generation.current) return;
      setPage((prior) =>
        cursor && prior ? { ...next, items: [...prior.items, ...next.items] } : next,
      );
      setLoadedQuery({ ...filters, storeId: selectedStore });
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
  }, [props.scopeKey]);
  return (
    <section className="finance-section" aria-labelledby="payables-heading">
      <header className="finance-section-header">
        <div>
          <h2 id="payables-heading">買掛・支払状況</h2>
          <p>請求の確定額、減額、支払、返金受領から残高を確認します。</p>
        </div>
      </header>
      <form
        className="finance-filter"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <label>
          残高の状態
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">すべて</option>
            <option value="unpaid">未払</option>
            <option value="partially-paid">一部支払済み</option>
            <option value="settled">精算済み</option>
            <option value="refund-due">返金待ち</option>
          </select>
        </label>
        <label>
          期日超過
          <select value={overdue} onChange={(event) => setOverdue(event.target.value)}>
            <option value="all">すべて</option>
            <option value="true">期日超過のみ</option>
            <option value="false">期日超過を除く</option>
          </select>
        </label>
        <label>
          支払期日・開始
          <input type="date" value={dueFrom} onChange={(event) => setDueFrom(event.target.value)} />
        </label>
        <label>
          支払期日・終了
          <input type="date" value={dueTo} onChange={(event) => setDueTo(event.target.value)} />
        </label>
        <label>
          残高の対象時点（日本時間）
          <input
            type="datetime-local"
            step="1"
            value={asOf}
            onChange={(event) => setAsOf(event.target.value)}
          />
        </label>
        {['admin', 'headquarters'].includes(props.actorRole) && (
          <label className="finance-checkbox">
            <input
              type="checkbox"
              checked={allStores}
              onChange={(event) => setAllStores(event.target.checked)}
            />
            全店舗を表示
          </label>
        )}
        <button disabled={loading}>この条件で確認</button>
      </form>
      {loading && <p role="status">買掛残高を取得しています…</p>}
      {error && (
        <p role="alert" className="finance-error">
          {error}
        </p>
      )}
      {page && (
        <>
          <p>
            対象時点：{financeDate(page.asOf)} ・記録取得：{financeDate(page.observedAt)}
          </p>
          <div className="finance-summary">
            <div>
              <span>条件全体の未払総額</span>
              <strong>{financeYen(page.totals.payableAmount)}</strong>
            </div>
            <div>
              <span>条件全体の返金待ち総額</span>
              <strong>{financeYen(page.totals.refundDueAmount)}</strong>
            </div>
            <div>
              <span>対象請求</span>
              <strong>{page.totals.invoiceCount}件</strong>
            </div>
          </div>
          <div className="finance-table-scroll">
            <table>
              <caption>買掛・支払状況一覧</caption>
              <thead>
                <tr>
                  <th>仕入先・原番号</th>
                  <th>原請求額</th>
                  <th>減額</th>
                  <th>支払</th>
                  <th>未払残高</th>
                  <th>返金待ち</th>
                  <th>支払期日</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((item) => (
                  <tr key={item.invoiceId}>
                    <td>
                      {item.supplierName}
                      <small>
                        {item.sourceIdentity.kind === 'numbered'
                          ? item.sourceIdentity.invoiceNumber
                          : item.sourceIdentity.sourceReference}
                      </small>
                    </td>
                    <td>{financeYen(item.originalGross)}</td>
                    <td>{financeYen(item.credits)}</td>
                    <td>{financeYen(item.payments)}</td>
                    <td>{financeYen(item.payableAmount)}</td>
                    <td>{financeYen(item.refundDueAmount)}</td>
                    <td>
                      {item.dueDate}
                      {item.overdue && <strong className="finance-overdue">期日超過</strong>}
                    </td>
                    <td>
                      <button
                        disabled={props.busy}
                        onClick={() =>
                          props.navigate(
                            `/purchases/invoices/${item.invoiceId}?${new URLSearchParams({ storeId: item.storeId })}`,
                          )
                        }
                      >
                        請求・支払を確認
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loading && !error && page.items.length === 0 && <p>この条件の買掛はありません。</p>}
          {page.nextCursor && (
            <button disabled={loading} onClick={() => void load(page.nextCursor)}>
              次の50件を表示
            </button>
          )}
          {loadedQuery.storeId === props.store ? (
            <section className="finance-card">
              <h3>この店舗・表示条件の買掛CSV</h3>
              <FinanceExports
                key={`${page.viewToken}:payables`}
                props={props}
                request={() => ({
                  storeId: props.store,
                  format: 'payables-csv',
                  asOf: page.asOf,
                  viewToken: page.viewToken,
                  supplierId: null,
                  status:
                    loadedQuery.status === 'unpaid' ||
                    loadedQuery.status === 'partially-paid' ||
                    loadedQuery.status === 'settled' ||
                    loadedQuery.status === 'refund-due'
                      ? loadedQuery.status
                      : 'all',
                  overdue:
                    loadedQuery.overdue === 'true'
                      ? true
                      : loadedQuery.overdue === 'false'
                        ? false
                        : null,
                  dueFrom: loadedQuery.dueFrom ?? null,
                  dueTo: loadedQuery.dueTo ?? null,
                })}
              />
            </section>
          ) : (
            <p className="finance-note">
              CSVは店舗ごとに作成します。「全店舗を表示」を外して検索してください。
            </p>
          )}
        </>
      )}
    </section>
  );
}
