import React, { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api-response';
import {
  EvidenceActionDtoSchema,
  EvidenceUploadMetadataSchema,
  type EvidenceDto,
  type EvidenceActionDto,
  type EvidenceRole,
  type InvoiceDto,
} from '@regi/core/finance';
import {
  downloadFinanceBlob,
  financeDate,
  financeMessage,
  financePath,
  financeValue,
  sha256Blob,
  type FinanceFileOptions,
  type FinanceProps,
} from '../finance-ui';

const roles: [EvidenceRole, string][] = [
  ['source-invoice', '原請求書'],
  ['source-identification', '原書類の識別資料'],
  ['tax-variance', '税額差の確認資料'],
  ['supplier-confirmation', '仕入先の確認資料'],
  ['supplier-credit', '仕入先の減額資料'],
  ['payment', '支払資料'],
  ['supplier-refund', '返金受領資料'],
  ['supporting', 'その他の補足資料'],
];
interface Upload {
  file: File;
  options: FinanceFileOptions;
  uncertain: boolean;
}
export function FinanceEvidence({
  props,
  invoice,
  reload,
}: {
  props: FinanceProps;
  invoice: InvoiceDto;
  reload: () => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [role, setRole] = useState<EvidenceRole>('source-invoice');
  const [method, setMethod] = useState('uploaded-original');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef<Upload | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [props.scopeKey, invoice.id],
  );
  async function upload() {
    if (!pending.current) {
      if (!file || file.size === 0 || file.size > 10 * 1024 * 1024)
        throw new Error('1〜10MBのPDF・PNG・JPEGを選択してください。');
      const operationId = crypto.randomUUID();
      const parsed = EvidenceUploadMetadataSchema.safeParse({
        operationId,
        storeId: props.store,
        invoiceVersion: invoice.version,
        originalName: file.name,
        mediaType: file.type,
        role,
        method,
        note,
      });
      if (!parsed.success)
        throw new Error('PDF・PNG・JPEGのファイルと添付情報を確認してください。');
      pending.current = {
        file,
        uncertain: false,
        options: {
          method: 'POST',
          body: file,
          headers: {
            'Content-Type': file.type,
            'X-Regi-Operation-Id': operationId,
            'X-Regi-Store-Id': props.store,
            'X-Regi-Invoice-Version': String(invoice.version),
            'X-Regi-Evidence-Name': encodeURIComponent(file.name),
            'X-Regi-Evidence-Role': role,
            'X-Regi-Evidence-Method': method,
            'X-Regi-Evidence-Note': encodeURIComponent(note),
          },
        },
      };
    }
    const current = generation.current;
    const intent = pending.current;
    let result: EvidenceActionDto;
    try {
      const response = await props.fileRequest(
        `/v1/purchase-invoices/${invoice.id}/evidence`,
        intent.options,
      );
      const body: unknown = await response.json();
      result = financeValue(EvidenceActionDtoSchema, body);
    } catch (caught: unknown) {
      if (!intent.uncertain && caught instanceof ApiError && !caught.uncertain)
        pending.current = null;
      else intent.uncertain = true;
      throw caught;
    }
    pending.current = null;
    if (current !== generation.current) return;
    setNotice(`「${result.evidence.originalName}」を添付しました。`);
    setFile(null);
    setError('');
    await reload();
  }
  async function download(item: EvidenceDto) {
    const current = generation.current;
    try {
      const response = await props.fileRequest(financePath(item.downloadPath, props.store));
      const blob = await response.blob();
      if (blob.size !== item.bytes || (await sha256Blob(blob)) !== item.sha256)
        throw new Error('添付ファイルの一致を確認できませんでした。再取得してください。');
      if (current === generation.current) downloadFinanceBlob(blob, item.originalName);
    } catch (caught: unknown) {
      if (current === generation.current) setError(financeMessage(caught));
    }
  }
  return (
    <section className="finance-card" aria-labelledby="invoice-evidence-heading">
      <h3 id="invoice-evidence-heading">原書類・関連資料</h3>
      <p className="finance-note">
        PDF・PNG・JPEG、1ファイル10MBまで、1請求20ファイルまで。添付済み資料は元の内容を保持します。
      </p>
      {invoice.evidence.length === 0 ? (
        <p>添付はありません。</p>
      ) : (
        <ul className="finance-evidence-list">
          {invoice.evidence.map((item) => (
            <li key={item.id}>
              <div>
                <strong>{item.originalName}</strong>
                <p>
                  {roles.find(([value]) => value === item.role)?.[1]} ・
                  {Math.ceil(item.bytes / 1024)}KB ・{financeDate(item.recordedAt)}
                </p>
              </div>
              <button disabled={props.busy} onClick={() => void download(item)}>
                原ファイルを取得
              </button>
            </li>
          ))}
        </ul>
      )}
      {invoice.evidence.length < 20 && (
        <form
          className="finance-form"
          onSubmit={(event) => {
            event.preventDefault();
            void props.action(upload);
          }}
        >
          <label>
            添付ファイル
            <input
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              disabled={props.busy || pending.current !== null}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <div className="finance-field-grid">
            <label>
              資料の用途
              <select
                value={role}
                disabled={props.busy || pending.current !== null}
                onChange={(event) => setRole(event.target.value as EvidenceRole)}
              >
                {roles.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              入手方法
              <select
                value={method}
                disabled={props.busy || pending.current !== null}
                onChange={(event) => setMethod(event.target.value)}
              >
                <option value="uploaded-original">電子原本</option>
                <option value="email-copy">メールの写し</option>
                <option value="scanned-paper">紙書類をスキャン</option>
                <option value="other">その他</option>
              </select>
            </label>
          </div>
          <label>
            資料の補足
            <textarea
              maxLength={500}
              value={note}
              disabled={props.busy || pending.current !== null}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button disabled={props.busy || (!file && !pending.current)}>
            {pending.current ? '同じ添付を再確認' : '資料を添付'}
          </button>
          {pending.current && (
            <p role="status">
              「{pending.current.file.name}
              」の送信結果を確認中です。同じファイル・同じ操作で再確認します。
            </p>
          )}
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
