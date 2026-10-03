import { useEffect, useRef, useState } from 'react';
import {
  InvoiceCreateRequestSchema,
  InvoiceDtoSchema,
  type InvoiceDto,
  type InvoiceDraftFields,
} from '@regi/core/finance';
import {
  financeMessage,
  financeValue,
  validateFinanceRequest,
  type FinanceProps,
} from '../finance-ui';

function correctionDraft(content: InvoiceDraftFields): InvoiceDraftFields {
  const draft = structuredClone(content);
  draft.sourceEvidenceId = null;
  if (draft.sourceIdentity?.kind === 'unnumbered') draft.sourceIdentity.sourceEvidenceId = null;
  if (draft.taxTreatment.mode === 'supplier-stated') draft.taxTreatment.evidenceId = null;
  return draft;
}

export function InvoiceCorrection({
  props,
  invoice,
}: {
  props: FinanceProps;
  invoice: InvoiceDto;
}) {
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    setError('');
    return () => {
      generation.current++;
    };
  }, [props.scopeKey, invoice.id]);
  const canCreate =
    ['admin', 'headquarters'].includes(props.actorRole) &&
    invoice.state === 'voided' &&
    invoice.replacementInvoiceId === null &&
    invoice.storeId === props.store;

  function open(id: string) {
    props.navigate(`/purchases/invoices/${id}?${new URLSearchParams({ storeId: props.store })}`);
  }
  async function create() {
    if (!canCreate) throw new Error('取消済み原請求と訂正先を再確認してください。');
    const current = generation.current;
    const input = {
      storeId: props.store,
      supplierId: invoice.supplierId,
      predecessorInvoiceId: invoice.id,
      draft: correctionDraft(invoice.content),
    };
    validateFinanceRequest(InvoiceCreateRequestSchema, input);
    setError('');
    try {
      const result = financeValue(
        InvoiceDtoSchema,
        await props.post('/v1/purchase-invoices', input),
      );
      if (
        result.predecessorInvoiceId !== invoice.id ||
        result.storeId !== props.store ||
        result.supplierId !== invoice.supplierId
      )
        throw new Error('訂正先と原請求の対応を確認できません。原記録を再取得してください。');
      if (current === generation.current) open(result.id);
    } catch (caught: unknown) {
      if (current === generation.current) setError(financeMessage(caught));
      throw caught;
    }
  }
  if (!canCreate && !invoice.predecessorInvoiceId && !invoice.replacementInvoiceId) return null;
  return (
    <section className="finance-card" aria-labelledby="invoice-correction-heading">
      <h3 id="invoice-correction-heading">訂正請求</h3>
      {invoice.predecessorInvoiceId && (
        <p>
          この請求は取消済み原請求の訂正です。
          <button disabled={props.busy} onClick={() => open(invoice.predecessorInvoiceId!)}>
            元の取消済み請求を開く
          </button>
        </p>
      )}
      {invoice.replacementInvoiceId && (
        <p>
          訂正先の請求があります。原請求と取消記録は保存しています。
          <button disabled={props.busy} onClick={() => open(invoice.replacementInvoiceId!)}>
            訂正先の請求を開く
          </button>
        </p>
      )}
      {canCreate && (
        <>
          <p>
            元の請求を保持し、原請求番号と明細を別の下書きへ引き継ぎます。原書類の証拠は新しい請求へ添付し、再確認してください。
          </p>
          <p>下書きの作成だけでは買掛を確定しません。</p>
          <button
            className="primary"
            disabled={props.busy}
            onClick={() => void props.action(create)}
          >
            訂正下書きを作成
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
