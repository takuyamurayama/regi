import React, { useEffect, useRef, useState } from 'react';
import {
  SupplierCreateRequestSchema,
  SupplierUpdateRequestSchema,
  SupplierDtoSchema,
  financePageSchema,
  type SupplierDto,
} from '@regi/core/finance';
import {
  financeMessage,
  financeValue,
  validateFinanceRequest,
  type FinanceProps,
} from '../finance-ui';

const newSupplier = () => ({
  code: '',
  name: '',
  address: '',
  registered: false,
  registrationNumber: '',
  defaultDueDays: '30',
  active: true,
});

export function FinanceSuppliers(props: FinanceProps) {
  const [records, setRecords] = useState<SupplierDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState('all');
  const [selected, setSelected] = useState<SupplierDto | null>(null);
  const [form, setForm] = useState(newSupplier);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const canManage = ['admin', 'headquarters'].includes(props.actorRole);

  async function load(cursor: string | null = null) {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ active, search, pageSize: '50' });
      if (cursor) query.set('cursor', cursor);
      const response = financeValue(
        financePageSchema(SupplierDtoSchema),
        await props.api(`/v1/suppliers?${query}`),
      );
      if (current !== generation.current) return;
      setRecords((prior) => (cursor ? [...prior, ...response.items] : response.items));
      setNextCursor(response.nextCursor);
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

  function edit(record: SupplierDto) {
    setSelected(record);
    setForm({
      code: record.code,
      name: record.name,
      address: record.address,
      registered: record.registered,
      registrationNumber: record.registrationNumber ?? '',
      defaultDueDays: String(record.defaultDueDays),
      active: record.active,
    });
    setNotice('');
  }

  async function save() {
    if (!/^\d{1,3}$/.test(form.defaultDueDays))
      throw new Error('標準支払日数は0〜365の整数で入力してください。');
    const fields = {
      ...form,
      registrationNumber: form.registered ? form.registrationNumber : null,
      defaultDueDays: Number(form.defaultDueDays),
      ...(selected ? { version: selected.version } : {}),
    };
    validateFinanceRequest(
      selected ? SupplierUpdateRequestSchema : SupplierCreateRequestSchema,
      fields,
      '仕入先コード・名称・支払日数と、登録ありの場合はTから始まる13桁の番号を確認してください。',
    );
    const current = generation.current;
    const saved = financeValue(
      SupplierDtoSchema,
      await props.post(
        selected ? `/v1/suppliers/${selected.id}` : '/v1/suppliers',
        fields,
        selected ? 'PATCH' : 'POST',
      ),
    );
    if (current !== generation.current) return;
    edit(saved);
    setNotice(`「${saved.name}」を保存しました。`);
    await load();
  }

  return (
    <section className="finance-section" aria-labelledby="suppliers-heading">
      <header className="finance-section-header">
        <div>
          <h2 id="suppliers-heading">仕入先</h2>
          <p>法人共通の取引先。無効化しても、確定済み請求の精算と履歴は残ります。</p>
        </div>
        {canManage && (
          <button
            disabled={props.busy}
            onClick={() => {
              setSelected(null);
              setForm(newSupplier());
              setNotice('');
            }}
          >
            新しい仕入先
          </button>
        )}
      </header>
      <form
        className="finance-filter"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <label>
          仕入先検索
          <input
            value={search}
            maxLength={100}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label>
          利用状態
          <select value={active} onChange={(event) => setActive(event.target.value)}>
            <option value="all">すべて</option>
            <option value="true">利用中</option>
            <option value="false">無効</option>
          </select>
        </label>
        <button disabled={loading}>検索</button>
      </form>
      {error && (
        <p role="alert" className="finance-error">
          {error}
        </p>
      )}
      {loading && <p role="status">仕入先を取得しています…</p>}
      {!loading && !error && records.length === 0 && <p>条件に合う仕入先はありません。</p>}
      <div className="finance-table-scroll">
        <table>
          <caption>仕入先一覧</caption>
          <thead>
            <tr>
              <th>コード</th>
              <th>名称</th>
              <th>登録番号</th>
              <th>支払日数</th>
              <th>状態</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.id}>
                <td>{record.code}</td>
                <td>{record.name}</td>
                <td>{record.registrationNumber ?? '非登録'}</td>
                <td>{record.defaultDueDays}日</td>
                <td>{record.active ? '利用中' : '無効'}</td>
                <td>
                  <button disabled={props.busy} onClick={() => edit(record)}>
                    {canManage ? '編集' : '詳細'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextCursor && (
        <button disabled={loading} onClick={() => void load(nextCursor)}>
          次の50件を表示
        </button>
      )}
      {canManage ? (
        <form
          className="finance-card finance-form"
          onSubmit={(event) => {
            event.preventDefault();
            void props.action(save);
          }}
        >
          <h3>{selected ? '仕入先を編集' : '仕入先を登録'}</h3>
          <div className="finance-field-grid">
            <label>
              仕入先コード
              <input
                required
                maxLength={64}
                value={form.code}
                onChange={(event) => setForm({ ...form, code: event.target.value })}
              />
            </label>
            <label>
              仕入先名称
              <input
                required
                maxLength={200}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </label>
            <label>
              住所
              <input
                maxLength={300}
                value={form.address}
                onChange={(event) => setForm({ ...form, address: event.target.value })}
              />
            </label>
            <label>
              標準支払日数
              <input
                inputMode="numeric"
                value={form.defaultDueDays}
                onChange={(event) => setForm({ ...form, defaultDueDays: event.target.value })}
              />
            </label>
          </div>
          <label className="finance-checkbox">
            <input
              type="checkbox"
              checked={form.registered}
              onChange={(event) => setForm({ ...form, registered: event.target.checked })}
            />
            適格請求書発行事業者として登録あり
          </label>
          {form.registered && (
            <label>
              登録番号
              <input
                required
                value={form.registrationNumber}
                maxLength={14}
                placeholder="T1234567890123"
                onChange={(event) => setForm({ ...form, registrationNumber: event.target.value })}
              />
            </label>
          )}
          <p className="finance-note">
            登録番号は形式を確認します。実際の登録状態は原書類・国税庁の情報と照合してください。
          </p>
          <label className="finance-checkbox">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(event) => setForm({ ...form, active: event.target.checked })}
            />
            新しい取引で利用する
          </label>
          <button disabled={props.busy} className="primary">
            仕入先を保存
          </button>
          {notice && <p role="status">{notice}</p>}
        </form>
      ) : selected ? (
        <div className="finance-card">
          <h3>{selected.name}</h3>
          <p>{selected.address || '住所未登録'}</p>
          <p>{selected.registrationNumber ?? '非登録事業者'}</p>
        </div>
      ) : null}
    </section>
  );
}
