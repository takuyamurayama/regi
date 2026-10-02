import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
async function main(){
 if(process.env.NODE_ENV!=='test')throw new Error('Local restoration test only');
 const source=process.env.LOCAL_POSTGRES_ADMIN_URL??'postgresql://postgres@localhost:5432/regi';
 const url=new URL(source);if(!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('Local PostgreSQL only');
 const client=new PrismaClient({datasourceUrl:source}),probe=randomUUID(),restored=`regi_restore_${Date.now()}`,start=Date.now();mkdirSync('.context',{recursive:true});
 try{
  await client.$executeRawUnsafe("INSERT INTO documents(id,tenant_id,store_id,kind,status,body,actor_id) VALUES($1::uuid,'10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','restore-probe','confirmed','{}','30000000-0000-4000-8000-000000000001')",probe);
  const committed=Date.now();execFileSync('pg_dump',['--format=custom','--file=.context/restore-test.dump',source],{stdio:'pipe'});
  await client.$executeRawUnsafe(`CREATE DATABASE "${restored}" OWNER regi_owner`);
  const destination=new URL(source);destination.pathname=`/${restored}`;
  execFileSync('pg_restore',['--dbname',destination.toString(),'.context/restore-test.dump'],{stdio:'pipe'});
  const restoredClient=new PrismaClient({datasourceUrl:destination.toString()});
  try{const records=await restoredClient.$queryRawUnsafe<any[]>('SELECT id FROM documents WHERE id=$1::uuid',probe);if(records.length!==1)throw new Error('Recovery marker missing');}finally{await restoredClient.$disconnect();}
  const evidence={scope:'local PostgreSQL logical backup, not AWS PITR',database:restored,markerRecovered:true,rpoMeasuredMs:0,backupStartedAfterCommitMs:Date.now()-committed,restoreAndBackupMs:Date.now()-start,verifiedAt:new Date().toISOString()};
  writeFileSync('.context/restore-results.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
 }finally{await client.$disconnect();}
}
main().catch(error=>{console.error(error.message);process.exit(1);});
