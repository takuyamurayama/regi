import React, { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api-response';
import {
  FinanceExportDtoSchema,
  FinanceExportRequestSchema,
  type FinanceExportDto,
  type FinanceExportRequest,
} from '@regi/core/finance';
import {
  downloadFinanceBlob,
  financeDate,
  financeMessage,
  financePath,
  financeValue,
  sha256Blob,
  validateFinanceRequest,
  type FinanceProps,
} from '../finance-ui';

type ExportInput = {
  [Format in FinanceExportRequest['format']]: Omit<
    Extract<FinanceExportRequest, { format: Format }>,
    'operationId'
  >;
}[FinanceExportRequest['format']];
export function FinanceExports({
  props,
  request,
}: {
  props: FinanceProps;
  request: () => ExportInput;
}) {
  const [job, setJob] = useState<FinanceExportDto | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const pending = useRef<{ input: ExportInput; uncertain: boolean } | null>(null);
  const latestJob = useRef(job);
  latestJob.current = job;
  useEffect(() => {
    return () => {
      generation.current++;
    };
  }, [props.scopeKey]);
  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return;
    const current = generation.current;
    const timer = setTimeout(() => {
      if (current === generation.current) void refreshJob();
    }, 1000);
    return () => clearTimeout(timer);
  }, [job, props.scopeKey]);
  async function refreshJob() {
    const current = generation.current,
      id = job?.id;
    if (!id) return;
    setLoading(true);
    try {
      const next = financeValue(
        FinanceExportDtoSchema,
        await props.api(financePath(`/v1/purchase-exports/${id}`, props.store)),
      );
      if (current === generation.current && latestJob.current?.id === id) {
        setJob(next);
        setError('');
      }
    } catch (caught: unknown) {
      if (current === generation.current && latestJob.current?.id === id)
        setError(financeMessage(caught));
    } finally {
      if (current === generation.current && latestJob.current?.id === id) setLoading(false);
    }
  }
  async function create() {
    const input = pending.current?.input ?? request();
    validateFinanceRequest(FinanceExportRequestSchema, input);
    pending.current ??= { input, uncertain: false };
    const intent = pending.current;
    const current = generation.current;
    let result: FinanceExportDto;
    try {
      result = financeValue(FinanceExportDtoSchema, await props.post('/v1/exports', input));
    } catch (caught: unknown) {
      if (!intent.uncertain && caught instanceof ApiError && !caught.uncertain)
        pending.current = null;
      else intent.uncertain = true;
      throw caught;
    }
    pending.current = null;
    if (current === generation.current) {
      setJob(result);
      setError('');
    }
  }
  async function download() {
    if (!job?.downloadPath || !job.filename || !job.fileSha256 || job.status !== 'completed')
      return;
    const current = generation.current;
    setLoading(true);
    try {
      const response = await props.fileRequest(financePath(job.downloadPath, props.store));
      const blob = await response.blob();
      if (blob.size !== job.bytes || (await sha256Blob(blob)) !== job.fileSha256)
        throw new Error('出力ファイルの一致を確認できませんでした。再取得してください。');
      if (current === generation.current) downloadFinanceBlob(blob, job.filename);
    } catch (caught: unknown) {
      if (current === generation.current) setError(financeMessage(caught));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  return (
    <div className="finance-export">
      <button
        disabled={props.busy || loading || ['queued', 'running'].includes(job?.status ?? '')}
        onClick={() => void props.action(create)}
      >
        {pending.current ? '同じ条件で出力を再確認' : 'この条件で出力を作成'}
      </button>
      {job && (
        <div aria-live="polite">
          <p>
            {job.status === 'completed'
              ? '出力完了'
              : job.status === 'failed'
                ? '出力失敗'
                : '出力を作成中'}{' '}
            ・対象時点 {financeDate(job.asOf)}
          </p>
          <p className="finance-note">記録取得日時：{financeDate(job.observedAt)}</p>
          {job.status === 'completed' && (
            <button disabled={loading} onClick={() => void download()}>
              ファイルをダウンロード
            </button>
          )}
          {job.status === 'failed' && (
            <p role="alert">
              {job.error?.message ?? '出力を作成できませんでした。'} {job.error?.nextAction ?? ''}
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {error && (
            <button disabled={loading || props.busy} onClick={() => void refreshJob()}>
              出力状況を再取得
            </button>
          )}
        </div>
      )}
    </div>
  );
}
