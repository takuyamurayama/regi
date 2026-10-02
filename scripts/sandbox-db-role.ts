import {PrismaClient} from '@prisma/client';
import {createHash,createHmac,pbkdf2Sync,randomBytes} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';

export function scramVerifier(password:string,salt=randomBytes(16)){
 const iterations=4096,salted=pbkdf2Sync(password,salt,iterations,32,'sha256');
 const clientKey=createHmac('sha256',salted).update('Client Key').digest(),storedKey=createHash('sha256').update(clientKey).digest(),serverKey=createHmac('sha256',salted).update('Server Key').digest();
 return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}
export async function bootstrapApplicationRole(owner:PrismaClient,password:string,roleName='regi_app'){
 if(!/^regi_[a-z0-9_]{1,55}$/.test(roleName)||password.length<32||password.length>200)throw new Error('SANDBOX_DB_ROLE_INPUT');
 const existing=await owner.$queryRawUnsafe<any[]>('SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=$1',roleName);
 if(existing.length){
  if(Object.values(existing[0]).some(Boolean))throw new Error('SANDBOX_EXISTING_DB_ROLE_UNSAFE');
  return {created:false};
 }
 await owner.$executeRawUnsafe(`CREATE ROLE ${roleName} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${scramVerifier(password)}'`);
 return {created:true};
}
async function main(){
 const url=new URL(process.env.MIGRATION_DATABASE_URL??'');
 if(process.env.REGI_SANDBOX_DB_BOOTSTRAP!=='sandbox-only'||process.env.REGI_SANDBOX_DB_CONFIRM!==url.pathname.slice(1)||url.username!=='regi_owner')throw new Error('SANDBOX_DB_BOOTSTRAP_CONFIRMATION');
 const path=process.env.REGI_SANDBOX_APP_PASSWORD_FILE;if(!path)throw new Error('SANDBOX_DB_PASSWORD_FILE');
 const file=statSync(path);if(!file.isFile()||(file.mode&0o077)!==0)throw new Error('SANDBOX_DB_PASSWORD_FILE_NOT_PRIVATE');
 const owner=new PrismaClient({datasourceUrl:url.toString()});
 try{
  await bootstrapApplicationRole(owner,readFileSync(path,'utf8').trim());
  await owner.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  const app=new PrismaClient({datasourceUrl:process.env.DATABASE_URL});
  try{const rows=await app.$queryRaw<any[]>`SELECT current_user`;if(rows[0]?.current_user!=='regi_app')throw new Error('SANDBOX_APP_ROLE_CONNECTION');}finally{await app.$disconnect();}
  console.log('Sandbox application DB role verified: nonowner/NOSUPERUSER/NOBYPASSRLS; no credentials logged');
 }finally{await owner.$disconnect();}
}
if(require.main===module)main().catch(()=>{console.error('Sandbox DB role bootstrap failed; no credentials logged');process.exitCode=1;});
