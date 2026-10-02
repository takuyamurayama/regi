import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
export type Actor = {
  tenantId: string;
  staffId: string;
  role: 'admin' | 'headquarters' | 'manager' | 'cashier';
  stores: string[];
  mfa: boolean;
  deviceId?: string;
  leaseId?: string;
};
export type Tx = Prisma.TransactionClient;
@Injectable()
export class Database implements OnModuleDestroy, OnModuleInit {
  readonly client = new PrismaClient();
  async onModuleInit() {
    const role = await this.client.$queryRaw<
      any[]
    >`SELECT rolsuper,rolbypassrls,(SELECT pg_get_userbyid(relowner)=current_user FROM pg_class WHERE relname='tenants') AS owns FROM pg_roles WHERE rolname=current_user`;
    if (role[0]?.rolsuper || role[0]?.rolbypassrls || role[0]?.owns)
      throw new Error('API database role must not own tables or bypass RLS');
  }
  async onModuleDestroy() {
    await this.client.$disconnect();
  }
  async transaction<T>(actor: Actor, callback: (transaction: Tx) => Promise<T>): Promise<T> {
    return this.client.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('regi.tenant',${actor.tenantId},true), set_config('regi.stores',${actor.stores.join(',')},true), set_config('regi.all_stores',${String(['admin', 'headquarters'].includes(actor.role))},true)`;
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actor.tenantId},0))`;
        return callback(transaction);
      },
      { timeout: 30000, maxWait: 30000 },
    );
  }
}
export async function rows<T = any>(transaction: Tx, query: Prisma.Sql): Promise<T[]> {
  return transaction.$queryRaw<T[]>(query);
}
export const sql = Prisma.sql;
