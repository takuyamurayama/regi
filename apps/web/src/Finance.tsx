import React from 'react';
import type { FinanceProps } from './finance-ui';
import { FinanceInvoices } from './finance/Invoices';
import { FinancePayables } from './finance/Payables';
import { FinanceReturns } from './finance/Returns';
import { FinanceSuppliers } from './finance/Suppliers';
import './Finance.css';

export function Finance(props: FinanceProps) {
  if (!['admin', 'headquarters', 'manager'].includes(props.actorRole))
    return (
      <section className="finance-card">
        <h2>仕入・支払管理</h2>
        <p role="status">この画面は管理者・本部・店長が利用できます。</p>
      </section>
    );
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(props.store)
  )
    return <p role="status">対象店舗を選択してください。</p>;
  const content =
    props.section === 'suppliers' ? (
      <FinanceSuppliers {...props} />
    ) : props.section === 'payables' ? (
      <FinancePayables {...props} />
    ) : props.section === 'returns' ? (
      <FinanceReturns {...props} />
    ) : (
      <FinanceInvoices {...props} />
    );
  return (
    <div className="finance-workspace" key={props.scopeKey}>
      <fieldset
        className="finance-operation-scope"
        disabled={props.busy}
        aria-label="仕入・支払の操作"
      >
        {content}
      </fieldset>
    </div>
  );
}
export type { FinanceProps } from './finance-ui';
