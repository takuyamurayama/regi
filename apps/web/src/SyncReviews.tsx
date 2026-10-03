import { useState } from 'react';
import { z } from 'zod';
import { Table } from './Table';
import type { WebActor } from './web-context';
const reviewSchema = z.object({
  id: z.uuid(),
  source: z.enum(['main', 'quarantine']),
  status: z.enum(['pending', 'accepted', 'review', 'waiting', 'dismissed']),
  device_id: z.uuid(),
  sequence: z.union([z.string(), z.number()]),
  body: z.object({ type: z.string() }).passthrough(),
  result: z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough(),
});
const deviceSchema = z.object({
  id: z.uuid(),
  store_id: z.uuid(),
  name: z.string(),
  last_sync: z.string().nullable(),
  pending: z.number(),
  review_count: z.number(),
  stopped: z.boolean(),
});
const labels = {
  pending: '受領処理中',
  accepted: '受領済み',
  review: '要確認',
  waiting: '依存待ち',
  dismissed: '却下済み',
};
type Review = z.infer<typeof reviewSchema>;
interface Props {
  records: unknown;
  devices: unknown;
  cursor: unknown;
  store: string;
  actor?: WebActor;
  busy: boolean;
  post: (path: string, body: unknown) => Promise<unknown>;
  action: (callback: () => Promise<unknown>) => Promise<void>;
}
function ReviewItem({
  event,
  busy,
  canDismiss,
  canRetry,
  post,
  action,
}: {
  event: Review;
  busy: boolean;
  canDismiss: boolean;
  canRetry: boolean;
  post: Props['post'];
  action: Props['action'];
}) {
  const [reason, setReason] = useState(''),
    [confirm, setConfirm] = useState(false),
    [included, setIncluded] = useState(false);
  const stocktake = ['STOCKTAKE_RECONCILE', 'STOCKTAKE_ACTIVE'].includes(event.result.code ?? '');
  return (
    <article className="order sync-review" aria-label={`同期イベント ${event.source} ${event.id}`}>
      <div className="sync-review-heading">
        <b>{labels[event.status]}</b>
        <span>
          {event.source === 'main' ? '原記録' : '隔離記録'} / {event.body.type} / 連番{' '}
          {event.sequence}
        </span>
      </div>
      <code className="sync-event-id">{event.id}</code>
      <p>
        {event.result.code ?? '—'} / {event.result.message ?? '処理結果を再確認してください'}
      </p>
      {event.status === 'waiting' && (
        <p className="muted">
          先の開局・連番の到着を待っています。原記録を照合してから再検証してください。
        </p>
      )}
      <label>
        照合理由
        <input
          aria-label="照合理由"
          placeholder="決済結果・原記録照合の承認理由"
          value={reason}
          maxLength={1000}
          onChange={(change) => {
            setReason(change.target.value);
            setConfirm(false);
          }}
        />
      </label>
      {stocktake && (
        <label>
          <input
            type="checkbox"
            checked={included}
            onChange={(change) => setIncluded(change.target.checked)}
          />
          この売上の在庫減少は実査済み数量に含まれる（未チェック=含まれない）
        </label>
      )}
      <div className="row">
        {canRetry && (
          <button
            disabled={busy || !reason.trim()}
            onClick={() => {
              void action(() =>
                post(`/v1/sync/reviews/${event.id}/retry`, {
                  reason,
                  source: event.source,
                  ...(stocktake ? { inventoryIncludedInCount: included } : {}),
                }),
              );
            }}
          >
            理由付きで原記録を再検証
          </button>
        )}
        {canDismiss && (
          <button disabled={busy || !reason.trim()} onClick={() => setConfirm(true)}>
            原記録を却下して終端にする
          </button>
        )}
      </div>
      {confirm && (
        <div className="notice" role="group" aria-label="却下の確認">
          <p>
            決済・原記録の照合が済み、売上として受領しない記録です。却下すると日締めの連番完了として扱われ、原記録と理由は監査に残ります。
          </p>
          <div className="row">
            <button
              disabled={busy || !reason.trim()}
              className="danger"
              onClick={() => {
                void action(() =>
                  post(`/v1/sync/reviews/${event.id}/dismiss`, { reason, source: event.source }),
                );
              }}
            >
              却下を確定
            </button>
            <button disabled={busy} onClick={() => setConfirm(false)}>
              戻る
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
export function SyncReviews({ records, devices, cursor, store, actor, busy, post, action }: Props) {
  const parsed = z.array(reviewSchema).safeParse(records),
    deviceRows = z.array(deviceSchema).safeParse(devices);
  const canRetry = actor && ['admin', 'headquarters', 'manager'].includes(actor.role),
    canDismiss = actor && ['admin', 'headquarters'].includes(actor.role);
  return (
    <section>
      <h3>要確認イベント / 原記録の管理者再検証</h3>
      <p>
        未送信は端末がまだ送信を完了していない記録、要確認は原記録の照合が必要な記録です。依存待ちは先のイベントの到着待ちです。
      </p>
      {!canRetry ? (
        <p>原記録の照合は所属店舗の管理者・本部が行います。</p>
      ) : !parsed.success ? (
        <p role="alert">要確認記録の形式を確認できません。再取得してください。</p>
      ) : parsed.data.length === 0 ? (
        <p>この店舗の要確認・依存待ち記録はありません。</p>
      ) : (
        parsed.data.map((event) => (
          <ReviewItem
            key={`${event.source}:${event.id}`}
            event={event}
            busy={busy}
            canDismiss={Boolean(canDismiss)}
            canRetry={Boolean(canRetry)}
            post={post}
            action={action}
          />
        ))
      )}
      <h3>端末同期状態</h3>
      {deviceRows.success ? (
        <Table
          headers={['端末', '最終同期', '未送信', '要確認', '販売停止']}
          rows={deviceRows.data
            .filter((device) => device.store_id === store)
            .map((device) => [
              device.name,
              device.last_sync ?? '未同期',
              device.pending,
              device.review_count,
              device.stopped ? '停止' : '販売可',
            ])}
        />
      ) : (
        <p role="alert">端末状態の形式を確認できません。再取得してください。</p>
      )}
      <p>端末時計ではなく法人コミット順カーソルで差分を取得します。</p>
      <p>現在の同期位置: {typeof cursor === 'string' ? cursor : '—'}</p>
    </section>
  );
}
