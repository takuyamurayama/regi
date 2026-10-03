import React, { useState } from 'react';
import { PurchaseSupplierPicker, PurchaseSupplierLink, purchaseLinkKey } from './PurchaseSuppliers';
import type { SupplierDto } from '@regi/core/finance';
import type { WebActor } from './web-context';
type Props = {
  api: (path: string, body?: any, method?: string) => Promise<any>;
  post: (path: string, body?: any) => Promise<any>;
  action: (callback: () => Promise<any>) => Promise<void>;
  busy: boolean;
  products: any[];
  orders?: any[];
  sales?: any[];
  refunds?: any[];
  shifts?: any[];
  settings?: any;
  store: string;
  actorRole?: WebActor['role'];
};
const yen = (value: any) => `${BigInt(String(value ?? 0)).toLocaleString('ja-JP')}円`;
export function Stocktakes({ api, post, action, busy, products, store }: Props) {
  const [records, setRecords] = useState<any[]>([]),
    [selected, setSelected] = useState(''),
    [counts, setCounts] = useState<Record<string, string>>({}),
    [search, setSearch] = useState(''),
    [reviews, setReviews] = useState<any[]>([]),
    [ack, setAck] = useState(false),
    [reason, setReason] = useState('');
  async function load() {
    if (!store) return;
    const [sessions, events] = await Promise.all([
      api(`/v1/documents/stocktake?storeId=${store}`),
      api(`/v1/sync/reviews?storeId=${store}`),
    ]);
    setRecords(sessions);
    setReviews(events);
  }
  React.useEffect(() => {
    setSelected('');
    setCounts({});
    if (!store) return;
    action(load);
  }, [store]);
  return (
    <section>
      <h3>棚卸 / 全端末販売停止・同期確認</h3>
      <p>各端末で販売停止・同期を行ってください。開始後はサーバーが開局・在庫変動を拒否します。</p>
      <button
        disabled={busy}
        onClick={() =>
          action(async () => {
            const session = await post('/v1/stocktakes');
            setSelected(session.id);
            await load();
          })
        }
      >
        棚卸開始
      </button>
      <button disabled={busy} onClick={() => action(load)}>
        棚卸・隔離記録を再取得
      </button>
      <select
        aria-label="棚卸記録"
        value={selected}
        onChange={(event) => {
          setSelected(event.target.value);
          setCounts({});
        }}
      >
        <option value="">進行中の棚卸を選択</option>
        {records
          .filter((record) => record.status === 'pending')
          .map((record) => (
            <option key={record.id} value={record.id}>
              {new Date(record.created_at).toLocaleString('ja-JP')} / {record.id.slice(0, 8)}
            </option>
          ))}
      </select>
      <input
        aria-label="棚卸商品検索"
        placeholder="SKU・商品名"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {products
        .filter((product) => `${product.name} ${product.sku}`.includes(search))
        .slice(0, 100)
        .map((product) => (
          <div className="row" key={product.id}>
            <span>{product.name}</span>
            <input
              aria-label={`実査 ${product.name}`}
              type="number"
              min="0"
              value={counts[product.id] ?? ''}
              onChange={(event) => setCounts({ ...counts, [product.id]: event.target.value })}
            />
          </div>
        ))}
      <p>
        登録済み実査明細: {Object.values(counts).filter((value) => value !== '').length}
        件（検索を切り替えても保持）
      </p>
      {reviews.length > 0 && (
        <>
          <p>
            隔離売上 {reviews.length}
            件。実査に含めたかは確定後の同期再検証で個別に指定してください。
          </p>
          <label>
            <input
              type="checkbox"
              checked={ack}
              onChange={(event) => setAck(event.target.checked)}
            />
            全隔離記録を原記録と照合しました
          </label>
          {reviews.map((review) => (
            <p key={review.id}>
              {review.id} / {review.result.code}
            </p>
          ))}
          <input
            aria-label="棚卸隔離承認理由"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </>
      )}
      <button
        disabled={
          busy ||
          !selected ||
          !Object.values(counts).some((value) => value !== '') ||
          (reviews.length > 0 && (!ack || !reason.trim()))
        }
        onClick={() =>
          action(async () => {
            await post(`/v1/stocktakes/${selected}/confirm`, {
              counts: Object.entries(counts)
                .filter(([, value]) => value !== '')
                .map(([productId, value]) => ({ productId, quantity: Number(value) })),
              reviewEventIds: ack ? reviews.map((review) => review.id) : [],
              reason,
            });
            setSelected('');
            setCounts({});
            await load();
          })
        }
      >
        実査全明細で棚卸確定
      </button>
    </section>
  );
}
export function ReceiptCorrections({ api, post, action, busy, orders = [], store }: Props) {
  const [receipts, setReceipts] = useState<any[]>([]),
    [reason, setReason] = useState(''),
    [error, setError] = useState('');
  async function load() {
    if (!store) return;
    setReceipts(await api(`/v1/documents/receipt?storeId=${store}`));
    setError('');
  }
  React.useEffect(() => {
    if (!store) return;
    load().catch((caught) => setError(caught.message));
  }, [store, orders]);
  return (
    <section>
      <h3>入荷履歴・誤入荷取消</h3>
      {error && <p role="alert">{error}</p>}
      <input
        aria-label="入荷取消理由"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      {receipts.map((receipt) => (
        <div className="order receipt-record" key={receipt.id}>
          <span>
            {orders.find((order) => order.id === receipt.body.orderId)?.body.supplier} /{' '}
            {receipt.id} / {receipt.status}
          </span>
          <span>
            {receipt.body.lines
              .map((line: any) => `明細${line.index + 1} ×${line.quantity}`)
              .join('、')}
          </span>
          {receipt.status === 'confirmed' && (
            <button
              disabled={busy || !reason.trim()}
              onClick={() =>
                action(async () => {
                  await post(`/v1/receipts/${receipt.id}/cancel`, { reason });
                  await load();
                })
              }
            >
              取消台帳を追加
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
export function Purchases({ api, post, action, busy, products, orders = [], actorRole }: Props) {
  const [supplier, setSupplier] = useState(''),
    [productId, setProductId] = useState(''),
    [quantity, setQuantity] = useState('1'),
    [cost, setCost] = useState('0'),
    [date, setDate] = useState(new Date().toISOString().slice(0, 10)),
    [cart, setCart] = useState<any[]>([]),
    [inputs, setInputs] = useState<Record<string, Record<number, string>>>({}),
    [revision, setRevision] = useState<Record<string, Record<number, string>>>({}),
    [reason, setReason] = useState(''),
    [search, setSearch] = useState('');
  const [masterSupplier, setMasterSupplier] = useState<SupplierDto | null>(null);
  const canManage =
    actorRole !== undefined && ['admin', 'headquarters', 'manager'].includes(actorRole);
  const line = () => ({ productId, quantity: Number(quantity), unitCost: cost });
  return (
    <>
      <section>
        <h3>発注下書きを作成</h3>
        {canManage && (
          <PurchaseSupplierPicker
            api={api}
            busy={busy}
            value={masterSupplier?.id ?? ''}
            onSelect={(value) => {
              setMasterSupplier(value);
              if (value) setSupplier(value.name);
            }}
          />
        )}
        <div className="row">
          <input
            aria-label="仕入先"
            placeholder="仕入先"
            value={supplier}
            onChange={(event) => {
              setSupplier(event.target.value);
              setMasterSupplier(null);
            }}
          />
          <input
            aria-label="商品検索"
            placeholder="SKU・商品名検索"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            aria-label="商品"
            value={productId}
            onChange={(event) => {
              setProductId(event.target.value);
              setCost(products.find((entry) => entry.id === event.target.value)?.cost ?? '0');
            }}
          >
            <option value="">商品を選択</option>
            {products
              .filter((entry) => `${entry.name} ${entry.sku}`.includes(search))
              .slice(0, 100)
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
          </select>
          <input
            aria-label="数量"
            type="number"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
          <input
            aria-label="仕入単価"
            value={cost}
            onChange={(event) => setCost(event.target.value)}
          />
          <input
            aria-label="入荷予定日"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          <button disabled={busy || !productId} onClick={() => setCart([...cart, line()])}>
            明細を追加
          </button>
          <button
            disabled={busy}
            onClick={() =>
              action(async () => {
                await post('/v1/purchase-orders', {
                  supplier,
                  ...(masterSupplier ? { supplierId: masterSupplier.id } : {}),
                  expectedAt: date,
                  lines: cart.length ? cart : [line()],
                });
                setCart([]);
              })
            }
          >
            下書き作成
          </button>
        </div>
        {cart.map((entry, index) => (
          <div className="row" key={index}>
            <span>
              {products.find((product) => product.id === entry.productId)?.name} ×{entry.quantity} /{' '}
              {yen(entry.unitCost)}
            </span>
            <button onClick={() => setCart(cart.filter((_, position) => position !== index))}>
              明細削除
            </button>
          </div>
        ))}
      </section>
      <section>
        <h3>承認・発行・分納・履歴付き改訂</h3>
        <input
          placeholder="改訂理由"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        {orders.map((order) => (
          <div className="order purchase-order" key={order.id}>
            <div>
              <b>
                {order.body.supplier} / {order.status}
              </b>
              <small>{order.id}</small>
              {canManage && (
                <details>
                  <summary>仕入先との対応</summary>
                  <PurchaseSupplierLink
                    key={purchaseLinkKey(order)}
                    order={order as unknown}
                    api={api}
                    post={post}
                    action={action}
                    busy={busy}
                  />
                </details>
              )}
              {order.body.lines.map((entry: any, index: number) => (
                <div className="row" key={index}>
                  <span>
                    {entry.name ?? products.find((product) => product.id === entry.productId)?.name}{' '}
                    {entry.received} / {entry.quantity} 入荷・残 {entry.quantity - entry.received}
                  </span>
                  <input
                    aria-label={`入荷数量 ${index + 1}`}
                    type="number"
                    min="0"
                    max={entry.quantity - entry.received}
                    value={
                      inputs[order.id]?.[index] ?? (order.body.lines.length === 1 ? quantity : '0')
                    }
                    onChange={(event) =>
                      setInputs({
                        ...inputs,
                        [order.id]: { ...inputs[order.id], [index]: event.target.value },
                      })
                    }
                  />
                  <input
                    aria-label={`改訂数量 ${index + 1}`}
                    type="number"
                    min={entry.received}
                    value={revision[order.id]?.[index] ?? entry.quantity}
                    onChange={(event) =>
                      setRevision({
                        ...revision,
                        [order.id]: { ...revision[order.id], [index]: event.target.value },
                      })
                    }
                  />
                </div>
              ))}
            </div>
            <div className="row">
              {order.status === 'draft' && (
                <button
                  disabled={busy}
                  onClick={() => action(() => post(`/v1/purchase-orders/${order.id}/approve`))}
                >
                  承認
                </button>
              )}
              {order.status === 'approved' && (
                <button
                  disabled={busy}
                  onClick={() => action(() => post(`/v1/purchase-orders/${order.id}/issue`))}
                >
                  発行
                </button>
              )}
              {['issued', 'partial'].includes(order.status) && (
                <button
                  disabled={busy}
                  onClick={() =>
                    action(() =>
                      post(`/v1/purchase-orders/${order.id}/receipts`, {
                        lines: order.body.lines
                          .map((_: any, index: number) => ({
                            index,
                            quantity: Number(
                              inputs[order.id]?.[index] ??
                                (order.body.lines.length === 1 ? quantity : '0'),
                            ),
                          }))
                          .filter((line: any) => line.quantity > 0),
                      }),
                    )
                  }
                >
                  指定数量を入荷
                </button>
              )}
              {['issued', 'partial', 'received'].includes(order.status) && (
                <>
                  <button
                    disabled={busy}
                    onClick={() =>
                      action(() =>
                        post(`/v1/purchase-orders/${order.id}/revise`, {
                          reason,
                          quantities: order.body.lines.map((entry: any, index: number) =>
                            Number(revision[order.id]?.[index] ?? entry.quantity),
                          ),
                        }),
                      )
                    }
                  >
                    数量改訂を記録
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      action(() =>
                        post('/v1/exports', { format: 'purchase-pdf', documentId: order.id }),
                      )
                    }
                  >
                    発注書PDF
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
export function Refunds({
  api,
  post,
  action,
  busy,
  sales = [],
  refunds = [],
  shifts = [],
  store,
}: Props) {
  const [selected, setSelected] = useState<any>(null),
    [quantities, setQuantities] = useState<Record<number, string>>({}),
    [restock, setRestock] = useState<Record<number, boolean>>({}),
    [reason, setReason] = useState(''),
    [reference, setReference] = useState(''),
    [shift, setShift] = useState(''),
    [search, setSearch] = useState(''),
    [found, setFound] = useState<any[] | null>(null);
  React.useEffect(() => {
    setFound(null);
    setSelected(null);
  }, [store]);
  return (
    <>
      <section>
        <h3>取引履歴 / 管理者返品</h3>
        <div className="row">
          <input
            aria-label="取引検索"
            placeholder="番号・商品名"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            disabled={busy}
            onClick={() =>
              action(async () =>
                setFound(
                  await api(`/v1/documents/sale?storeId=${store}&q=${encodeURIComponent(search)}`),
                ),
              )
            }
          >
            サーバー記録を検索
          </button>
          <input
            aria-label="返品理由"
            placeholder="返品理由"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        {(found ?? sales)
          .filter((sale) => JSON.stringify(sale).includes(search))
          .map((sale) => (
            <div className="order" key={sale.id}>
              <span>
                {yen(sale.body.total)} / {sale.body.method}
                <small>{sale.id}</small>
              </span>
              <button
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    setSelected(await api(`/v1/sales/${sale.id}/returnable`));
                    setQuantities({});
                    setRestock({});
                  })
                }
              >
                返品明細を選択
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  action(() => post('/v1/exports', { format: 'receipt-pdf', documentId: sale.id }))
                }
              >
                再印刷PDF
              </button>
            </div>
          ))}
        {selected && (
          <section className="return-lines">
            <h3>元取引 {selected.sale.id}</h3>
            {selected.lines.map((line: any) => (
              <div className="row" key={line.index}>
                <span>
                  {line.name} / 販売 {line.quantity}・返品可能 {line.remaining}
                </span>
                <input
                  aria-label={`返品数量 ${line.index + 1}`}
                  type="number"
                  min="0"
                  max={line.remaining}
                  value={quantities[line.index] ?? '0'}
                  onChange={(event) =>
                    setQuantities({ ...quantities, [line.index]: event.target.value })
                  }
                />
                <label>
                  <input
                    type="checkbox"
                    checked={restock[line.index] ?? true}
                    onChange={(event) =>
                      setRestock({ ...restock, [line.index]: event.target.checked })
                    }
                  />
                  再入庫可能
                </label>
              </div>
            ))}
            <button
              disabled={busy || selected.pending}
              onClick={() =>
                action(async () => {
                  await post('/v1/refunds', {
                    saleId: selected.sale.id,
                    reason,
                    lines: selected.lines
                      .map((line: any) => ({
                        index: line.index,
                        quantity: Number(quantities[line.index] ?? '0'),
                        restock: restock[line.index] ?? true,
                      }))
                      .filter((line: any) => line.quantity > 0),
                  });
                  setSelected(null);
                })
              }
            >
              選択明細を返品予約
            </button>
          </section>
        )}
      </section>
      <section>
        <h3>返品・返金確認</h3>
        <div className="row">
          <input
            aria-label="外部返金確認番号"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            placeholder="外部返金成功確認番号"
          />
          <select
            aria-label="現金返金の開局"
            value={shift}
            onChange={(event) => setShift(event.target.value)}
          >
            <option value="">支出した営業中開局を選択</option>
            {shifts
              .filter((entry) => entry.status === 'open')
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.body.deviceId} / 準備金 {entry.body.opening}
                </option>
              ))}
          </select>
        </div>
        {refunds.map((refund) => (
          <div className="order" key={refund.id}>
            <span>
              {yen(refund.body.total)} / {refund.status}
              <small>{refund.id}</small>
            </span>
            {refund.status === 'pending' && (
              <div className="row">
                {['unknown', 'success', 'failed'].map((result) => (
                  <button
                    key={result}
                    disabled={busy}
                    onClick={() =>
                      action(() =>
                        post(`/v1/refunds/${refund.id}/confirm`, {
                          result,
                          reference,
                          ...(shift ? { shiftId: shift } : {}),
                        }),
                      )
                    }
                  >
                    {result === 'success'
                      ? '返金成功を記録'
                      : result === 'unknown'
                        ? '確認待ちを維持'
                        : '返金失敗を記録'}
                  </button>
                ))}
              </div>
            )}
            {refund.status === 'confirmed' && (
              <button
                disabled={busy}
                onClick={() =>
                  action(() => post('/v1/exports', { format: 'refund-pdf', documentId: refund.id }))
                }
              >
                返還伝票PDF
              </button>
            )}
          </div>
        ))}
      </section>
    </>
  );
}
export function Management({ post, action, busy, settings, store }: Props) {
  const [name, setName] = useState(''),
    [subject, setSubject] = useState(''),
    [pin, setPin] = useState(''),
    [role, setRole] = useState('cashier'),
    [code, setCode] = useState('standard'),
    [rate, setRate] = useState('1000'),
    [effective, setEffective] = useState(''),
    [proof, setProof] = useState(''),
    [address, setAddress] = useState(''),
    [registration, setRegistration] = useState(''),
    [buyer, setBuyer] = useState(false);
  return (
    <>
      <section>
        <h3>スタッフ・端末・税率履歴</h3>
        <div className="row">
          <input
            aria-label="担当者名"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="スタッフ / 端末の表示名"
          />
          <input
            aria-label="Cognito subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="Cognito subject"
          />
          <input
            aria-label="登録PIN"
            type="password"
            value={pin}
            onChange={(event) => setPin(event.target.value)}
          />
          <select value={role} onChange={(event) => setRole(event.target.value)}>
            {['cashier', 'manager', 'headquarters', 'admin'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <button
            disabled={busy}
            onClick={() =>
              action(() =>
                post('/v1/settings/staff', { name, subject, pin, role, stores: [store] }),
              )
            }
          >
            選択店舗の担当者を登録
          </button>
          <button
            disabled={busy}
            onClick={() => action(() => post('/v1/devices/enroll', { name }))}
          >
            選択店舗の端末を登録
          </button>
        </div>
        <div className="row">
          <input
            aria-label="税区分コード"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <input
            aria-label="税率 basis points"
            value={rate}
            onChange={(event) => setRate(event.target.value)}
          />
          <input
            aria-label="税率適用開始"
            type="datetime-local"
            value={effective}
            onChange={(event) => setEffective(event.target.value)}
          />
          <button
            disabled={busy || !effective}
            onClick={() =>
              action(() =>
                post('/v1/settings/tax-rate', {
                  code,
                  rateBps: Number(rate),
                  effectiveAt: new Date(effective).toISOString(),
                }),
              )
            }
          >
            将来税率を登録
          </button>
        </div>
        <p>契約満了 {settings?.tenant.ends_at}。更新は販売者が署名した12か月契約のみ。</p>
        <div className="row">
          <textarea
            aria-label="署名付き更新契約"
            value={proof}
            onChange={(event) => setProof(event.target.value)}
          />
          <button
            disabled={busy}
            onClick={() => action(() => post('/v1/settings/renew-contract', { proof }))}
          >
            署名を検証して契約更新
          </button>
        </div>
      </section>
      <section>
        <h3>売り手・帳票設定</h3>
        <div className="row">
          <input
            aria-label="売り手名"
            placeholder="売り手名"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <input
            aria-label="帳票住所"
            placeholder="住所"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
          <input
            aria-label="登録番号"
            placeholder="登録事業者のみ T + 13桁"
            value={registration}
            onChange={(event) => setRegistration(event.target.value)}
          />
          <label>
            <input
              type="checkbox"
              checked={buyer}
              onChange={(event) => setBuyer(event.target.checked)}
            />
            購入者宛名を必須にする
          </label>
          <button
            disabled={busy}
            onClick={() =>
              action(() =>
                post('/v1/settings/receipt-profile', {
                  sellerName: name,
                  storeName: settings?.stores.find((entry: any) => entry.id === store)?.name,
                  address,
                  registered: registration.length > 0,
                  registrationNumber: registration,
                  buyerRequired: buyer,
                }),
              )
            }
          >
            帳票設定を履歴保存
          </button>
        </div>
        <p>登録番号は利用者が実登録を確認して設定します。既存売上の帳票は変わりません。</p>
      </section>
    </>
  );
}
