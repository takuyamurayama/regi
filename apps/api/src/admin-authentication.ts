import {Actor,Database,rows,sql} from './db';
import {z} from 'zod';

export async function hasAdministratorAuthentication(database:Database,actor:Actor){
 if(actor.role!=='admin')return false;
 if(actor.mfa)return true;
 const tenant=process.env.REGI_PERSONAL_SANDBOX_PASSWORD_ONLY_TENANT_ID;
 if(process.env.COGNITO_MFA_ENFORCED!=='false'||process.env.REGI_DEV_AUTH==='true'||!z.uuid().safeParse(tenant).success||tenant!==actor.tenantId)return false;
 const [marker]=await database.transaction(actor,transaction=>rows(transaction,sql`SELECT id FROM documents WHERE kind='demo-seed' AND status='completed' AND body @> '{"synthetic":true,"version":"regi-synthetic-v1"}'::jsonb LIMIT 1`));
 return Boolean(marker);
}
