import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Database, Actor, sql } from '../apps/api/src/db';
import { Business, pinHash } from '../apps/api/src/service';
async function main() {
  if (process.env.NODE_ENV !== 'test') throw new Error('Local load fixture only');
  const db = new Database(),
    business = new Business(db),
    tenant = randomUUID(),
    staff = randomUUID(),
    product = randomUUID(),
    stores = Array.from({ length: 5 }, () => randomUUID()),
    actor: Actor = { tenantId: tenant, staffId: staff, stores, role: 'admin', mfa: true };
  const endpoint = process.env.REGI_LOAD_BASEURL;
  if (endpoint && !['localhost', '127.0.0.1'].includes(new URL(endpoint).hostname))
    throw new Error('Local API only');
  const clients: { device: string; lease: string; shift: string; sequence: number }[] = [];
  try {
    await db.transaction(actor, async (transaction) => {
      await transaction.$executeRaw(
        sql`INSERT INTO tenants VALUES(${tenant}::uuid,'負荷試験専用','inclusive',now()-interval '1 day',now()+interval '24 months',1)`,
      );
      for (const store of stores)
        await transaction.$executeRaw(
          sql`INSERT INTO stores VALUES(${store}::uuid,${tenant}::uuid,'負荷試験店舗')`,
        );
      await transaction.$executeRaw(
        sql`INSERT INTO staff VALUES(${staff}::uuid,${tenant}::uuid,${tenant},'負荷試験担当','admin',${`{${stores.join(',')}}`}::uuid[],${pinHash('1234', tenant)},true)`,
      );
      await transaction.$executeRaw(
        sql`INSERT INTO products(id,tenant_id,sku,name,stock_managed,cost) VALUES(${product}::uuid,${tenant}::uuid,'LOAD','負荷試験商品',true,50)`,
      );
      await transaction.$executeRaw(
        sql`INSERT INTO tax_rates VALUES(${randomUUID()}::uuid,${tenant}::uuid,'standard',1000,now()-interval '1 day')`,
      );
      await transaction.$executeRaw(
        sql`INSERT INTO prices VALUES(${randomUUID()}::uuid,${tenant}::uuid,${product}::uuid,110,'standard',now()-interval '1 day',50)`,
      );
      for (let index = 0; index < 100; index++) {
        const device = randomUUID();
        await transaction.$executeRaw(
          sql`INSERT INTO devices(id,tenant_id,store_id,name) VALUES(${device}::uuid,${tenant}::uuid,${stores[index % 5]}::uuid,'仮想負荷端末')`,
        );
        clients.push({ device, lease: '', shift: '', sequence: 0 });
      }
    });
    for (let index = 0; index < clients.length; index++) {
      const client = clients[index],
        bootstrap = await business.bootstrap(actor, client.device),
        shift = await business.openShift(actor, {
          operationId: randomUUID(),
          storeId: stores[index % 5],
          deviceId: client.device,
          opening: '0',
          pin: '1234',
        });
      client.lease = bootstrap.leaseId;
      client.shift = shift.id;
    }
    const durations: number[] = [],
      tasks: Promise<void>[] = [],
      started = performance.now();
    for (let index = 0; index < 200; index++) {
      const target = started + index * 100;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, target - performance.now())));
      const client = clients[index % 100],
        event = {
          id: randomUUID(),
          deviceId: client.device,
          leaseId: client.lease,
          sequence: String(++client.sequence),
          staffId: staff,
          occurredAt: new Date().toISOString(),
          ruleVersion: 'regi-1',
          type: 'sale',
          body: {
            mode: 'inclusive',
            discount: '0',
            total: '110',
            method: 'cash',
            tendered: '110',
            shiftId: client.shift,
            lines: [
              {
                productId: product,
                name: '負荷試験商品',
                quantity: 1,
                price: '110',
                discount: '0',
                rateBps: 1000,
                cost: '50',
                stockManaged: true,
              },
            ],
          },
        };
      tasks.push(
        (async () => {
          const start = performance.now(),
            result = endpoint
              ? ((await (
                  await fetch(`${endpoint}/v1/sync/events`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'x-tenant-id': tenant,
                      'x-staff-subject': tenant,
                    },
                    body: JSON.stringify({ events: [event] }),
                  })
                ).json()) as any)
              : await business.events(actor, { events: [event] });
          if (result.results[0].status !== 'accepted') throw new Error('Load event rejected');
          durations.push(performance.now() - start);
        })(),
      );
    }
    await Promise.all(tasks);
    durations.sort((left, right) => left - right);
    const evidence = {
      scope: endpoint
        ? 'local NestJS HTTP + PostgreSQL, not AWS'
        : 'local PostgreSQL service ingestion, no AWS/network latency',
      terminals: 100,
      ratePerSecond: 10,
      sales: durations.length,
      p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
      maximumMs: durations.at(-1),
      wallMs: performance.now() - started,
      licenseBypassedForLoadFixtureOnly: true,
      verifiedAt: new Date().toISOString(),
    };
    mkdirSync('.context', { recursive: true });
    writeFileSync('.context/load-results.json', JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
    if (evidence.p95Ms > 2000)
      throw new Error(`Ingestion p95 exceeds two seconds: ${evidence.p95Ms}ms`);
  } finally {
    await db.client.$disconnect();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
