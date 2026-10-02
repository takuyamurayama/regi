import { PrismaClient, Prisma } from '@prisma/client';
import { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { pathToFileURL } from 'node:url';
const tables = [
  'device_events',
  'device_leases',
  'inventory',
  'audit',
  'documents',
  'operations',
  'changes',
  'change_heads',
  'forecasts',
  'ai_usage',
  'prices',
  'tax_rates',
  'products',
  'devices',
  'staff',
  'stores',
  'tenants',
];
export async function retireTenant(
  client: PrismaClient,
  tenantId: string,
  execute = false,
  bucket?: string,
) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(tenantId))
    throw new Error('Explicit tenant UUID required');
  if (execute && process.env.NODE_ENV === 'production' && !bucket)
    throw new Error('Production artifact bucket required');
  return client.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('regi.tenant',${tenantId},true),set_config('regi.all_stores','true',true)`;
      const tenant = await transaction.$queryRaw<
        any[]
      >`SELECT * FROM tenants WHERE id=${tenantId}::uuid FOR UPDATE`;
      if (!tenant.length) throw new Error('Tenant not found');
      if (Date.now() - new Date(tenant[0].ends_at).getTime() < 90 * 86400000)
        throw new Error('Contract must have ended at least 90 days ago');
      const counts: Record<string, number> = {};
      for (const table of tables) {
        const result = await transaction.$queryRaw<any[]>(
          Prisma.sql`SELECT count(*)::int AS count FROM ${Prisma.raw(table)} WHERE ${Prisma.raw(table === 'tenants' ? 'id' : 'tenant_id')}=${tenantId}::uuid`,
        );
        counts[table] = result[0].count;
      }
      if (!execute) return { tenantId, mode: 'dry-run', counts };
      const role = await transaction.$queryRaw<
        any[]
      >`SELECT current_user AS name,pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname='tenants'`;
      if (role[0].name !== role[0].owner)
        throw new Error('Dedicated schema owner maintenance connection required');
      if (bucket) {
        const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-northeast-1' });
        let keyMarker: string | undefined, versionIdMarker: string | undefined;
        do {
          const page = await s3.send(
            new ListObjectVersionsCommand({
              Bucket: bucket,
              Prefix: `${tenantId}/`,
              KeyMarker: keyMarker,
              VersionIdMarker: versionIdMarker,
            }),
          );
          const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map((item) => ({
            Key: item.Key!,
            VersionId: item.VersionId!,
          }));
          if (objects.length) {
            const result = await s3.send(
              new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: objects, Quiet: true },
              }),
            );
            if (result.Errors?.length)
              throw new Error('Artifact deletion failed; database retained');
          }
          keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
          versionIdMarker = page.NextVersionIdMarker;
        } while (keyMarker);
      }
      await transaction.$executeRawUnsafe(
        `LOCK TABLE ${tables.join(',')} IN ACCESS EXCLUSIVE MODE`,
      );
      for (const table of tables)
        await transaction.$executeRawUnsafe(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
      for (const [table, trigger] of [
        ['inventory', 'inventory_immutable'],
        ['audit', 'audit_immutable'],
        ['documents', 'sales_immutable'],
      ])
        await transaction.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      for (const table of tables)
        await transaction.$executeRaw(
          Prisma.sql`DELETE FROM ${Prisma.raw(table)} WHERE ${Prisma.raw(table === 'tenants' ? 'id' : 'tenant_id')}=${tenantId}::uuid`,
        );
      for (const [table, trigger] of [
        ['inventory', 'inventory_immutable'],
        ['audit', 'audit_immutable'],
        ['documents', 'sales_immutable'],
      ])
        await transaction.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
      for (const table of tables)
        await transaction.$executeRawUnsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      return { tenantId, mode: 'deleted', counts, backupExpiresAfterDays: 35 };
    },
    { timeout: 180000 },
  );
}
async function main() {
  const tenantId = process.argv[2],
    execute = process.argv.includes('--execute');
  if (execute && !process.argv.includes(`--confirm=${tenantId}`))
    throw new Error('Explicit --confirm=TENANT_UUID required');
  if (!process.env.MAINTENANCE_DATABASE_URL) throw new Error('MAINTENANCE_DATABASE_URL required');
  const client = new PrismaClient({ datasourceUrl: process.env.MAINTENANCE_DATABASE_URL });
  try {
    console.log(
      JSON.stringify(await retireTenant(client, tenantId, execute, process.env.ARTIFACT_BUCKET)),
    );
  } finally {
    await client.$disconnect();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
