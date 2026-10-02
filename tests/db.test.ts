import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { Database, Actor, rows, sql } from '../apps/api/src/db';
import { Business, pinHash } from '../apps/api/src/service';
import { Ai } from '../apps/api/src/ai';
import { Administration } from '../apps/api/src/admin';
import { Imports } from '../apps/api/src/import';
import { Recommendations } from '../apps/api/src/recommendations';
const db = new Database(),
  business = new Business(db),
  tenant = randomUUID(),
  store = randomUUID(),
  store2 = randomUUID(),
  staff = randomUUID(),
  device = randomUUID(),
  product = randomUUID();
const actor: Actor = {
  tenantId: tenant,
  staffId: staff,
  stores: [store, store2],
  role: 'admin',
  mfa: true,
};
const op = () => ({ operationId: randomUUID(), storeId: store });
after(() => db.client.$disconnect());
test('real PostgreSQL transactional acceptance', async (context) => {
  await db.transaction(actor, async (transaction) => {
    await transaction.$executeRaw(
      sql`INSERT INTO tenants VALUES(${tenant}::uuid,'試験法人','inclusive',now()-interval '1 day',now()+interval '24 months',1)`,
    );
    await transaction.$executeRaw(
      sql`INSERT INTO stores VALUES(${store}::uuid,${tenant}::uuid,'試験店舗'),(${store2}::uuid,${tenant}::uuid,'移動先')`,
    );
    await transaction.$executeRaw(
      sql`INSERT INTO staff VALUES(${staff}::uuid,${tenant}::uuid,${tenant},'管理者','admin',ARRAY[${store}::uuid,${store2}::uuid],${pinHash('1234', tenant)},true)`,
    );
    await transaction.$executeRaw(
      sql`INSERT INTO devices(id,tenant_id,store_id,name) VALUES(${device}::uuid,${tenant}::uuid,${store}::uuid,'試験端末')`,
    );
    await transaction.$executeRaw(
      sql`INSERT INTO products(id,tenant_id,sku,name,stock_managed,cost) VALUES(${product}::uuid,${tenant}::uuid,'TEST','試験商品',true,50)`,
    );
    await transaction.$executeRaw(
      sql`INSERT INTO tax_rates VALUES(${randomUUID()}::uuid,${tenant}::uuid,'standard',1000,now()-interval '1 day')`,
    );
    await transaction.$executeRaw(
      sql`INSERT INTO prices VALUES(${randomUUID()}::uuid,${tenant}::uuid,${product}::uuid,101,'standard',now()-interval '1 day',50)`,
    );
  });
  const boot = await business.bootstrap(actor, device);
  await context.test('CSV import is atomic and scheduled prices bootstrap offline', async () => {
    const importer = new Imports(business),
      request = {
        operationId: randomUUID(),
        csv: 'sku,jan,name,price,cost,taxCode,stockManaged\nCSV-OK,,"商品,試験",100,40,standard,true',
      };
    const imported = await importer.products(actor, request);
    assert.equal(imported.count, 1);
    assert.deepEqual(await importer.products(actor, request), imported);
    await assert.rejects(() =>
      importer.products(actor, {
        operationId: randomUUID(),
        csv: 'sku,jan,name,price,cost,taxCode,stockManaged\nROLLBACK,,X,100,40,standard,true\nTEST,,X,100,40,standard,true',
      }),
    );
    assert.ok(!(await business.products(actor)).some((product) => product.sku === 'ROLLBACK'));
    const effectiveAt = new Date(Date.now() + 3600000).toISOString();
    await business.saveProduct(
      actor,
      {
        operationId: randomUUID(),
        version: 1,
        sku: 'CSV-OK',
        name: '商品,試験',
        price: '120',
        cost: '45',
        taxCode: 'standard',
        stockManaged: true,
        effectiveAt,
      },
      imported.ids[0],
    );
    const snapshot = await business.bootstrap(actor, device);
    assert.ok(
      snapshot.priceSchedules.some(
        (price) => price.productId === imported.ids[0] && price.price === '120',
      ),
    );
  });
  const shift = await business.openShift(actor, {
    ...op(),
    deviceId: device,
    opening: '10000',
    pin: '1234',
  });
  const event = {
    id: randomUUID(),
    deviceId: device,
    leaseId: boot.leaseId,
    sequence: '2',
    staffId: staff,
    occurredAt: new Date().toISOString(),
    ruleVersion: 'regi-1',
    type: 'sale',
    body: {
      mode: 'inclusive',
      discount: '1',
      total: '302',
      method: 'cash',
      tendered: '500',
      shiftId: shift.id,
      lines: [
        {
          productId: product,
          name: '試験商品',
          quantity: 3,
          price: '101',
          discount: '0',
          rateBps: 1000,
          cost: '50',
          stockManaged: true,
        },
      ],
    },
  };
  await context.test('app role cannot bypass RLS; tenant and store isolation', async () => {
    const role = await db.transaction(actor, (transaction) =>
      rows(transaction, sql`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`),
    );
    assert.equal(role[0].rolsuper, false);
    assert.equal(role[0].rolbypassrls, false);
    const other: Actor = { ...actor, tenantId: randomUUID() };
    assert.equal(
      (
        await db.transaction(other, (transaction) =>
          rows(transaction, sql`SELECT * FROM products WHERE id=${product}::uuid`),
        )
      ).length,
      0,
    );
    const cashier: Actor = { ...actor, role: 'cashier', stores: [store] };
    assert.equal(
      (
        await db.transaction(cashier, (transaction) =>
          rows(transaction, sql`SELECT * FROM stores WHERE id=${store2}::uuid`),
        )
      ).length,
      0,
    );
    await assert.rejects(() => business.report(cashier, store2), /担当外/);
    await assert.rejects(
      () => business.adjust(cashier, { ...op(), productId: product, quantity: 1, reason: 'test' }),
      /権限/,
    );
  });
  await context.test('concurrent resend counts one sale and one stock reduction', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => business.events(actor, { events: [event] })),
    );
    assert.ok(results.every((result) => result.results[0].status === 'accepted'));
    const records = await business.list(actor, 'sale', store);
    assert.equal(records.length, 1);
    assert.equal((await business.inventory(actor, store))[0].quantity, '-3');
    const conflict = await business.events(actor, {
      events: [{ ...event, body: { ...event.body, total: '999' } }],
    });
    assert.equal(conflict.results[0].code, 'IDEMPOTENCY_CONFLICT');
    await assert.rejects(
      () =>
        db.transaction(actor, (transaction) =>
          transaction.$executeRaw(sql`UPDATE documents SET body='{}' WHERE id=${event.id}::uuid`),
        ),
      /immutable/,
    );
    const accepted = await db.transaction(actor, (transaction) =>
      rows<{ status: string; hash: string; body: unknown; result: unknown }>(
        transaction,
        sql`SELECT status,hash,body,result FROM device_events WHERE id=${event.id}::uuid`,
      ),
    );
    assert.equal(accepted[0].status, 'accepted');
    assert.deepEqual(accepted[0].body, event);
    // Resolve the deliberately rejected fixture before independent stocktake scenarios.
    const dismissReason = '受領済み売上と照合し、試験で意図的に改変したイベントを棄却';
    const dismissed = await db.transaction(actor, async (transaction) => {
      await transaction.$executeRaw(
        sql`UPDATE device_event_quarantine SET status='dismissed',dismissed_by=${staff}::uuid,dismiss_reason=${dismissReason} WHERE id=${event.id}::uuid AND status='review'`,
      );
      return rows<{ status: string; dismissed_by: string; dismiss_reason: string }>(
        transaction,
        sql`SELECT status,dismissed_by,dismiss_reason FROM device_event_quarantine WHERE id=${event.id}::uuid`,
      );
    });
    assert.deepEqual(dismissed, [
      { status: 'dismissed', dismissed_by: staff, dismiss_reason: dismissReason },
    ]);
    assert.deepEqual(
      await db.transaction(actor, (transaction) =>
        rows<{ status: string; hash: string; body: unknown; result: unknown }>(
          transaction,
          sql`SELECT status,hash,body,result FROM device_events WHERE id=${event.id}::uuid`,
        ),
      ),
      accepted,
    );
  });
  await context.test(
    'reorder fallback uses configured base stock and order unit rounding',
    async () => {
      const recommendations = new Recommendations(business);
      await recommendations.policy(actor, {
        ...op(),
        productId: product,
        baseStock: 10,
        safetyStock: 2,
        leadDays: 3,
        minimum: 1,
        multiple: 6,
      });
      const proposal = (await recommendations.list(actor, store)).find(
        (entry) => entry.productId === product,
      )!;
      assert.equal(proposal.method, 'base-stock');
      assert.equal(proposal.quantity, 18);
    },
  );
  let firstRefund: any;
  await context.test('reserved quantities and unknown refunds remain locked', async () => {
    firstRefund = await business.refund(actor, {
      ...op(),
      saleId: event.id,
      reason: '一個返品',
      lines: [{ index: 0, quantity: 1, restock: true }],
    });
    assert.equal(firstRefund.body.total, '101');
    await business.confirmRefund(actor, firstRefund.id, { ...op(), result: 'unknown' });
    await assert.rejects(
      () =>
        business.refund(actor, {
          ...op(),
          saleId: event.id,
          reason: '重複',
          lines: [{ index: 0, quantity: 1, restock: true }],
        }),
      /未完了/,
    );
    await business.confirmRefund(actor, firstRefund.id, {
      ...op(),
      result: 'success',
      shiftId: shift.id,
    });
  });
  await context.test(
    'partial refunds exactly exhaust original total without over-refund',
    async () => {
      const refund = await business.refund(actor, {
        ...op(),
        saleId: event.id,
        reason: '残り返品',
        lines: [{ index: 0, quantity: 2, restock: true }],
      });
      assert.equal(refund.body.total, '201');
      const request = { ...op(), result: 'success', shiftId: shift.id };
      await Promise.all(
        Array.from({ length: 5 }, () => business.confirmRefund(actor, refund.id, request)),
      );
      assert.equal((await business.inventory(actor, store))[0].quantity, '0');
      await assert.rejects(
        () =>
          business.refund(actor, {
            ...op(),
            saleId: event.id,
            reason: '過剰返品',
            lines: [{ index: 0, quantity: 1, restock: true }],
          }),
        /返品可能数量/,
      );
    },
  );
  let order: any, receipt: any;
  await context.test(
    'purchase approval, issue, partial receipts and concurrent over-receipt',
    async () => {
      order = await business.purchase(actor, {
        ...op(),
        supplier: '検証仕入先',
        expectedAt: '2026-10-02',
        lines: [{ productId: product, quantity: 10, unitCost: '50' }],
      });
      await business.purchaseAction(actor, order.id, op(), 'approve');
      await business.purchaseAction(actor, order.id, op(), 'issue');
      const request = { ...op(), lines: [{ index: 0, quantity: 4 }] };
      const results = await Promise.all(
        Array.from({ length: 5 }, () => business.receipt(actor, order.id, request)),
      );
      receipt = results[0];
      assert.ok(results.every((result) => result.id === receipt.id));
      const competing = await Promise.allSettled([
        business.receipt(actor, order.id, { ...op(), lines: [{ index: 0, quantity: 6 }] }),
        business.receipt(actor, order.id, { ...op(), lines: [{ index: 0, quantity: 6 }] }),
      ]);
      assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal((await business.inventory(actor, store))[0].quantity, '10');
      await assert.rejects(
        () =>
          business.purchaseAction(
            actor,
            order.id,
            { ...op(), quantities: [9], reason: 'test' },
            'revise',
          ),
        /入荷済み/,
      );
    },
  );
  await context.test(
    'receipt cancellation appends reversing ledger; cannot cancel twice',
    async () => {
      await business.cancelReceipt(actor, receipt.id, { ...op(), reason: '誤入荷' });
      assert.equal((await business.inventory(actor, store))[0].quantity, '6');
      await assert.rejects(
        () => business.cancelReceipt(actor, receipt.id, { ...op(), reason: '重複' }),
        /取消済み/,
      );
    },
  );
  await context.test('transfer excludes in-transit stock until receiving', async () => {
    const transfer = await business.transfer(actor, {
      ...op(),
      toStoreId: store2,
      lines: [{ productId: product, quantity: 2 }],
    });
    assert.equal((await business.inventory(actor, store))[0].quantity, '4');
    assert.equal((await business.inventory(actor, store2)).length, 0);
    const destinationManager: Actor = { ...actor, role: 'manager', stores: [store2] };
    await business.receiveTransfer(destinationManager, transfer.id, {
      operationId: randomUUID(),
      storeId: store2,
    });
    assert.equal((await business.inventory(actor, store2))[0].quantity, '2');
  });
  await context.test(
    'stocktake requires stopped synchronized devices and writes only deltas',
    async () => {
      await assert.rejects(() => business.stocktake(actor, op()), /全登録端末/);
      await business.deviceStatus(actor, device, { ...op(), pending: 0, stopped: true });
      const take = await business.stocktake(actor, op());
      await business.confirmStocktake(actor, take.id, {
        ...op(),
        counts: [{ productId: product, quantity: 8 }],
      });
      assert.equal((await business.inventory(actor, store))[0].quantity, '8');
    },
  );
  await context.test(
    'AI quota rollback on disconnected Bedrock; unauthorized stores denied',
    async () => {
      const ai = new Ai(business);
      await assert.rejects(
        () =>
          ai.query(actor, {
            ...op(),
            metric: 'sales',
            question: '売上',
            from: '2026-01-01',
            to: '2026-12-31',
          }),
        /未接続/,
      );
      const usage = await db.transaction(actor, (transaction) =>
        rows(transaction, sql`SELECT used FROM ai_usage`),
      );
      assert.equal(usage[0].used, 0);
      await db.transaction(actor, (transaction) =>
        transaction.$executeRaw(sql`UPDATE ai_usage SET used=5000`),
      );
      await assert.rejects(
        () => ai.query(actor, { ...op(), metric: 'sales', question: '売上' }),
        /上限/,
      );
    },
  );
  await context.test('offline open/sale/close recover from out-of-order delivery', async () => {
    const otherDevice = await business.enroll(actor, { ...op(), name: '通信断試験' }),
      snapshot = await business.bootstrap(actor, otherDevice.id),
      opened = randomUUID();
    const envelope = {
      deviceId: otherDevice.id,
      leaseId: snapshot.leaseId,
      staffId: staff,
      occurredAt: new Date().toISOString(),
      ruleVersion: 'regi-1',
    };
    const opening = {
      ...envelope,
      id: opened,
      sequence: '1',
      type: 'shift.open',
      body: { opening: '1000' },
    };
    const selling = {
      ...event,
      ...envelope,
      id: randomUUID(),
      sequence: '2',
      body: { ...event.body, shiftId: opened },
    };
    const closing = {
      ...envelope,
      id: randomUUID(),
      sequence: '3',
      type: 'shift.close',
      body: { shiftId: opened, actual: '1302' },
    };
    assert.equal(
      (await business.events(actor, { events: [closing, selling] })).results[0].status,
      'retry',
    );
    const accepted = await business.events(actor, { events: [opening, selling, closing] });
    assert.ok(accepted.results.every((result) => result.status === 'accepted'));
    const shifts = await business.list(actor, 'shift', store),
      closed = shifts.find((entry) => entry.id === opened);
    assert.equal(closed.body.difference, '0');
  });
  await context.test(
    'cash refund reduces the paying shift and full refund restores gross profit',
    async () => {
      const report = await business.report(actor, store);
      assert.equal(report.approximateGrossProfit, '125');
      const closed = await business.closeShift(actor, shift.id, { ...op(), actual: '10000' });
      assert.equal(closed.body.expected, '10000');
      assert.equal(closed.body.difference, '0');
    },
  );
  await context.test(
    'expired contract still accepts previously valid sales but refuses new business',
    async () => {
      await db.transaction(actor, (transaction) =>
        transaction.$executeRaw(sql`UPDATE tenants SET ends_at=now()-interval '1 second'`),
      );
      const late = {
        ...event,
        id: randomUUID(),
        sequence: '1',
        body: { ...event.body, shiftId: shift.id },
      };
      assert.equal(
        (await business.events(actor, { events: [late] })).results[0].code,
        'STOCKTAKE_RECONCILE',
      );
      assert.equal(
        (
          await business.retryReview(actor, late.id, {
            ...op(),
            reason: '期限内成立・実査に含まれた数量を照合',
            inventoryIncludedInCount: true,
          })
        ).status,
        'accepted',
      );
      await assert.rejects(
        () =>
          business.adjust(actor, { ...op(), productId: product, quantity: 1, reason: '期限後' }),
        /契約期限/,
      );
    },
  );
  await context.test('explicit annual renewal and organization limits are enforced', async () => {
    const keys = generateKeyPairSync('ed25519');
    process.env.RENEWAL_PUBLIC_KEY = keys.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const payload = Buffer.from(
      JSON.stringify({
        tenantId: tenant,
        reference: `CONTRACT-${randomUUID()}`,
        months: 12,
        priceExTax: '2400000',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      }),
    ).toString('base64url');
    const proof = `${payload}.${sign(null, Buffer.from(payload), keys.privateKey).toString('base64url')}`;
    const settings = new Administration(business),
      request = { operationId: randomUUID(), proof };
    await assert.rejects(
      () =>
        settings.execute(actor, 'renew-contract', {
          operationId: randomUUID(),
          reference: '自己申告',
        }),
      /販売者/,
    );
    await assert.rejects(
      () =>
        settings.execute(actor, 'renew-contract', {
          operationId: randomUUID(),
          proof: proof + 'x',
        }),
      /署名/,
    );
    const renewed = await settings.execute(actor, 'renew-contract', request);
    assert.equal(renewed.body.months, 12);
    assert.equal(renewed.body.priceExTax, '2400000');
    assert.equal((await settings.execute(actor, 'renew-contract', request)).id, renewed.id);
    await assert.rejects(
      () => settings.execute(actor, 'renew-contract', { ...request, operationId: randomUUID() }),
      /登録済み/,
    );
    for (let index = 0; index < 3; index++)
      await settings.execute(actor, 'store', { operationId: randomUUID(), name: `追加${index}` });
    await assert.rejects(
      () => settings.execute(actor, 'store', { operationId: randomUUID(), name: '上限超過' }),
      /最大5/,
    );
  });
  await context.test(
    'invalid raw event retains original hash, stable review and no monetary effects',
    async () => {
      const before = (await business.inventory(actor, store)).find(
        (entry) => entry.product_id === product,
      )?.quantity;
      const invalid = {
        ...event,
        id: randomUUID(),
        sequence: '99',
        extra: 'retained',
        body: { ...event.body, total: '999' },
      };
      const first = await business.events(actor, { events: [invalid] });
      const duplicate = await business.events(actor, { events: [invalid] });
      assert.deepEqual(first, duplicate);
      const changed = await business.events(actor, { events: [{ ...invalid, extra: 'changed' }] });
      assert.equal(changed.results[0].code, 'IDEMPOTENCY_CONFLICT');
      await assert.rejects(
        () =>
          business.retryReview(actor, invalid.id, {
            ...op(),
            reason: '原記録を再照合',
            inventoryIncludedInCount: true,
          }),
        /一致/,
      );
      assert.ok(
        (await business.reviews(actor, store)).some(
          (entry) => entry.id === invalid.id && entry.body.extra === 'retained',
        ),
      );
      assert.equal(
        (await business.inventory(actor, store)).find((entry) => entry.product_id === product)
          ?.quantity,
        before,
      );
    },
  );
});
