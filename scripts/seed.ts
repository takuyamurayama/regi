import { Database, Actor, sql } from '../apps/api/src/db';
import { pinHash } from '../apps/api/src/service';
export const ids = {
  tenant: '10000000-0000-4000-8000-000000000001',
  store: '20000000-0000-4000-8000-000000000001',
  store2: '20000000-0000-4000-8000-000000000002',
  admin: '30000000-0000-4000-8000-000000000001',
  cashier: '30000000-0000-4000-8000-000000000002',
  device: '40000000-0000-4000-8000-000000000001',
  product: '50000000-0000-4000-8000-000000000001',
};
export const admin: Actor = {
  tenantId: ids.tenant,
  staffId: ids.admin,
  role: 'admin',
  stores: [ids.store, ids.store2],
  mfa: true,
};
export async function seed() {
  const db = new Database();
  try {
    await db.transaction(admin, async (transaction) => {
      await transaction.$executeRaw(
        sql`INSERT INTO tenants VALUES(${ids.tenant}::uuid,'REGI 検証法人','inclusive','2026-01-01','2028-01-01',1) ON CONFLICT DO NOTHING`,
      );
      await transaction.$executeRaw(
        sql`INSERT INTO stores VALUES(${ids.store}::uuid,${ids.tenant}::uuid,'東京店'),(${ids.store2}::uuid,${ids.tenant}::uuid,'横浜店') ON CONFLICT DO NOTHING`,
      );
      await transaction.$executeRaw(
        sql`INSERT INTO staff VALUES(${ids.admin}::uuid,${ids.tenant}::uuid,'local-admin','検証管理者','admin',ARRAY[${ids.store}::uuid,${ids.store2}::uuid],${pinHash('1234', 'regi-local-admin')},true),(${ids.cashier}::uuid,${ids.tenant}::uuid,'local-cashier','検証レジ担当','cashier',ARRAY[${ids.store}::uuid],${pinHash('1234', 'regi-local-cashier')},true) ON CONFLICT DO NOTHING`,
      );
      await transaction.$executeRaw(
        sql`INSERT INTO devices(id,tenant_id,store_id,name) VALUES(${ids.device}::uuid,${ids.tenant}::uuid,${ids.store}::uuid,'開発POS') ON CONFLICT DO NOTHING`,
      );
      await transaction.$executeRaw(
        sql`INSERT INTO products(id,tenant_id,sku,jan,name,category,stock_managed,cost) VALUES(${ids.product}::uuid,${ids.tenant}::uuid,'COFFEE-001','4900000000001','コーヒー豆 200g','食品',true,350) ON CONFLICT DO NOTHING`,
      );
      await transaction.$executeRaw(
        sql`INSERT INTO tax_rates VALUES('60000000-0000-4000-8000-000000000001',${ids.tenant}::uuid,'standard',1000,'2020-01-01'),('60000000-0000-4000-8000-000000000002',${ids.tenant}::uuid,'reduced',800,'2020-01-01') ON CONFLICT DO NOTHING`,
      );
      await transaction.$executeRaw(
        sql`INSERT INTO prices VALUES('70000000-0000-4000-8000-000000000001',${ids.tenant}::uuid,${ids.product}::uuid,1080,'reduced','2020-01-01',350) ON CONFLICT DO NOTHING`,
      );
    });
    console.log('Local seed ready (development only)');
  } finally {
    await db.client.$disconnect();
  }
}
if (require.main === module) {
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? ''))
    throw new Error('Seed is development only');
  seed().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
