import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  SupplierDtoSchema,
  financePageSchema,
  PurchaseSupplierLinkDtoSchema,
  type SupplierDto,
} from '@regi/core/finance';
import { financeValue, financeMessage } from './finance-ui';
interface PickerProps {
  api: (path: string) => Promise<unknown>;
  busy: boolean;
  value: string;
  onSelect: (supplier: SupplierDto | null) => void;
}
export function PurchaseSupplierPicker({ api, busy, value, onSelect }: PickerProps) {
  const [open, setOpen] = useState(false),
    [records, setRecords] = useState<SupplierDto[]>([]),
    [search, setSearch] = useState(''),
    [next, setNext] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  async function load(cursor: string | null = null) {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ active: 'true', search, pageSize: '50' });
      if (cursor) query.set('cursor', cursor);
      const result = financeValue(
        financePageSchema(SupplierDtoSchema),
        await api(`/v1/suppliers?${query}`),
      );
      if (current !== generation.current) return;
      setRecords((prior) => (cursor ? [...prior, ...result.items] : result.items));
      setNext(result.nextCursor);
    } catch (caught: unknown) {
      if (current === generation.current) setError(financeMessage(caught));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  return (
    <div className="purchase-supplier-picker">
      <button
        disabled={busy}
        onClick={() => {
          setOpen(!open);
          if (!open) void load();
        }}
      >
        仕入先マスターを選ぶ
      </button>
      {open && (
        <div>
          <div className="row">
            <label>
              仕入先検索
              <input value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
            <button
              disabled={busy || loading}
              onClick={() => {
                void load();
              }}
            >
              仕入先を検索
            </button>
          </div>
          <label>
            仕入先マスター
            <select
              value={value}
              disabled={busy || loading}
              onChange={(event) =>
                onSelect(records.find((record) => record.id === event.target.value) ?? null)
              }
            >
              <option value="">マスターとの対応を選択</option>
              {records.map((record) => (
                <option key={record.id} value={record.id}>
                  {record.code} / {record.name}
                </option>
              ))}
            </select>
          </label>
          {loading && <p role="status">仕入先を取得しています。</p>}
          {error && <p role="alert">{error}</p>}
          {next && (
            <button
              disabled={busy || loading}
              onClick={() => {
                void load(next);
              }}
            >
              仕入先の続きを取得
            </button>
          )}
        </div>
      )}
    </div>
  );
}
const orderSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  body: z.object({ supplier: z.string() }),
  currentSupplierId: z.uuid().nullable().optional(),
});
export function purchaseLinkKey(order: unknown): string {
  const parsed = orderSchema.safeParse(order);
  return parsed.success ? `${parsed.data.id}:${parsed.data.version}` : 'unknown-order';
}
interface LinkProps {
  order: unknown;
  api: PickerProps['api'];
  post: (path: string, body: unknown) => Promise<unknown>;
  action: (callback: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}
export function PurchaseSupplierLink({ order, api, post, action, busy }: LinkProps) {
  const parsed = orderSchema.safeParse(order),
    [supplier, setSupplier] = useState<SupplierDto | null>(null),
    [reason, setReason] = useState('');
  if (!parsed.success) return <p role="alert">発注の版を確認できません。再取得してください。</p>;
  const record = parsed.data;
  return (
    <div className="purchase-supplier-link">
      <p>
        仕入先マスターとの対応: {record.currentSupplierId ? '対応済み' : '未対応'}
        。発行済みの仕入先名・発注書は変更しません。
      </p>
      <PurchaseSupplierPicker
        api={api}
        busy={busy}
        value={supplier?.id ?? ''}
        onSelect={setSupplier}
      />
      <label>
        マスター対応理由
        <input
          value={reason}
          maxLength={1000}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <button
        disabled={busy || !supplier || !reason.trim()}
        onClick={() => {
          if (!supplier) return;
          void action(async () => {
            financeValue(
              PurchaseSupplierLinkDtoSchema,
              await post(`/v1/purchase-orders/${record.id}/supplier-link`, {
                supplierId: supplier.id,
                reason,
                expectedOrderVersion: record.version,
              }),
            );
          });
        }}
      >
        仕入先マスターとの対応を記録
      </button>
    </div>
  );
}
