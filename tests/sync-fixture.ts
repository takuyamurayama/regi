import { randomUUID } from 'node:crypto';
import { Actor, Database, sql } from '../apps/api/src/db';
import { Business, pinHash } from '../apps/api/src/service';

const actor = (): Actor => ({
  tenantId: randomUUID(),
  staffId: randomUUID(),
  stores: [randomUUID()],
  role: 'admin',
  mfa: true,
});
export async function syncFixture() {
  const database = new Database(),
    business = new Business(database),
    admin = actor();
  const store = admin.stores[0],
    device = randomUUID(),
    product = randomUUID();
  await database.transaction(admin, async (transaction) => {
    await transaction.$executeRaw(
      sql`INSERT INTO tenants VALUES(${admin.tenantId}::uuid,'同期障害試験','inclusive',now()-interval '1 day',now()+interval '2 years',1)`,
    );
    await transaction.$executeRaw(
      sql`INSERT INTO stores VALUES(${store}::uuid,${admin.tenantId}::uuid,'同期障害試験店')`,
    );
    await transaction.$executeRaw(
      sql`INSERT INTO staff VALUES(${admin.staffId}::uuid,${admin.tenantId}::uuid,${admin.tenantId},'試験管理者','admin',ARRAY[${store}::uuid],${pinHash('1234', admin.tenantId)},true)`,
    );
    await transaction.$executeRaw(
      sql`INSERT INTO devices(id,tenant_id,store_id,name) VALUES(${device}::uuid,${admin.tenantId}::uuid,${store}::uuid,'同期障害端末')`,
    );
    await transaction.$executeRaw(
      sql`INSERT INTO products(id,tenant_id,sku,name,stock_managed,cost) VALUES(${product}::uuid,${admin.tenantId}::uuid,'SYNC-FAILURE','障害試験商品',true,50)`,
    );
    await transaction.$executeRaw(
      sql`INSERT INTO tax_rates VALUES(${randomUUID()}::uuid,${admin.tenantId}::uuid,'standard',1000,now()-interval '1 day')`,
    );
    await transaction.$executeRaw(
      sql`INSERT INTO prices VALUES(${randomUUID()}::uuid,${admin.tenantId}::uuid,${product}::uuid,101,'standard',now()-interval '1 day',50)`,
    );
  });
  const boot = (await business.bootstrap(admin, device)) as { leaseId: string };
  const shift = (await business.openShift(admin, {
    operationId: randomUUID(),
    storeId: store,
    deviceId: device,
    opening: '1000',
    pin: '1234',
  })) as { id: string };
  const sale = {
    id: randomUUID(),
    deviceId: device,
    leaseId: boot.leaseId,
    sequence: '1',
    staffId: admin.staffId,
    occurredAt: new Date().toISOString(),
    ruleVersion: 'regi-1',
    type: 'sale',
    body: {
      mode: 'inclusive',
      discount: '0',
      total: '101',
      method: 'cash',
      tendered: '200',
      shiftId: shift.id,
      lines: [
        {
          productId: product,
          name: '障害試験商品',
          quantity: 1,
          price: '101',
          discount: '0',
          rateBps: 1000,
          cost: '50',
          stockManaged: true,
        },
      ],
    },
  };
  return { database, business, admin, store, device, product, sale };
}
