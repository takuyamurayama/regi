import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {exportJWK,generateKeyPair,SignJWT} from 'jose';
import {Actor,Database,rows,sql} from '../apps/api/src/db';
import {Auth} from '../apps/api/src/auth';
import {Business,pinHash} from '../apps/api/src/service';
import {Administration} from '../apps/api/src/admin';

const database=new Database(),business=new Business(database),administration=new Administration(business);
assert.ok(['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL??'').hostname),'MFA regression must never connect to AWS');
const tenant=randomUUID(),foreign=randomUUID(),real=randomUUID(),admin=randomUUID(),cashier=randomUUID(),store=randomUUID(),marker=randomUUID();
const actor:Actor={tenantId:tenant,staffId:admin,role:'admin',stores:[store],mfa:false};
const keys=['NODE_ENV','REGI_DEV_AUTH','COGNITO_ISSUER','COGNITO_CLIENT_ID','COGNITO_MFA_ENFORCED','REGI_PERSONAL_SANDBOX_PASSWORD_ONLY_TENANT_ID'];
const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
let issuer:string,auth:Auth,signing:Awaited<ReturnType<typeof generateKeyPair>>;
const server=createServer();
const subject=(tenantId:string,role:string)=>tenantId+'-'+role;
async function token(tenantId=tenant,role='admin',overrides:Record<string,unknown>={}){
 return new SignJWT({'custom:tenant_id':tenantId,token_use:'id',...overrides}).setProtectedHeader({alg:'RS256',kid:'sandbox-local-rsa'}).setSubject(subject(tenantId,role)).setIssuer(typeof overrides.iss==='string'?overrides.iss:issuer).setAudience(typeof overrides.aud==='string'?overrides.aud:'sandbox-test-client').setExpirationTime('5m').sign(signing.privateKey);
}
const request=(authorization?:string,headers:Record<string,string>={})=>({path:'/v1/settings',headers:{...(authorization?{authorization:'Bearer '+authorization}:{}),...headers},actor:undefined as Actor|undefined});
const activate=(input:ReturnType<typeof request>)=>auth.canActivate({switchToHttp:()=>({getRequest:()=>input})} as any);
const rejects=(operation:()=>Promise<unknown>,code:string)=>assert.rejects(operation,(error:any)=>error.code===code);
before(async()=>{
 await database.onModuleInit();signing=await generateKeyPair('RS256');const publicKey=await exportJWK(signing.publicKey);
 server.on('request',(_request,response)=>{response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({keys:[{...publicKey,kid:'sandbox-local-rsa',alg:'RS256',use:'sig'}]}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');issuer='http://127.0.0.1:'+String((server.address() as any).port);
 Object.assign(process.env,{NODE_ENV:'production',REGI_DEV_AUTH:'false',COGNITO_ISSUER:issuer,COGNITO_CLIENT_ID:'sandbox-test-client',COGNITO_MFA_ENFORCED:'false'});delete process.env.REGI_PERSONAL_SANDBOX_PASSWORD_ONLY_TENANT_ID;
 auth=new Auth(database);
 for(const tenantId of [tenant,foreign,real])await database.transaction({...actor,tenantId},async transaction=>{
  const staffId=tenantId===tenant?admin:randomUUID(),storeId=tenantId===tenant?store:randomUUID();
  await transaction.$executeRaw(sql`INSERT INTO tenants VALUES(${tenantId}::uuid,'MFA境界試験法人','inclusive',now()-interval '1 day',now()+interval '24 months',1)`);
  await transaction.$executeRaw(sql`INSERT INTO stores VALUES(${storeId}::uuid,${tenantId}::uuid,'境界試験店舗')`);
  await transaction.$executeRaw(sql`INSERT INTO staff VALUES(${staffId}::uuid,${tenantId}::uuid,${subject(tenantId,'admin')},'試験管理者','admin',ARRAY[${storeId}::uuid],${pinHash('456789',randomUUID())},true)`);
  if(tenantId!==real)await business.createDocument(transaction,{...actor,tenantId,staffId},'demo-seed','completed',{version:'regi-synthetic-v1',synthetic:true},null,tenantId===tenant?marker:randomUUID());
  if(tenantId===tenant)await transaction.$executeRaw(sql`INSERT INTO staff VALUES(${cashier}::uuid,${tenantId}::uuid,${subject(tenantId,'cashier')},'試験レジ担当','cashier',ARRAY[${store}::uuid],${pinHash('456789',randomUUID())},true)`);
 });
});
after(async()=>{
 for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
 server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await database.client.$disconnect();
});

test('default production requires administrator MFA even when Cognito attestation is false',async()=>{
 await rejects(()=>activate(request('not-a-signed-token')),'UNAUTHENTICATED');
 await rejects(async()=>activate(request(await token())),'MFA_REQUIRED');
 await rejects(()=>administration.execute(actor,'store',{operationId:randomUUID(),name:'拒否される店舗'}),'ADMIN_REQUIRED');
 const verified=request(await token(tenant,'admin',{amr:['mfa']}));await activate(verified);assert.equal(verified.actor!.mfa,true);
 assert.ok((await administration.execute(verified.actor!,'store',{operationId:randomUUID(),name:'MFA認証店舗'})).id);
});

test('explicit synthetic sandbox accepts signed password-only admin, preserving actor.mfa=false and real administration',async()=>{
 process.env.REGI_PERSONAL_SANDBOX_PASSWORD_ONLY_TENANT_ID=tenant;
 const authenticated=request(await token());await activate(authenticated);assert.equal(authenticated.actor!.mfa,false);assert.equal(authenticated.actor!.role,'admin');
 const result=await administration.execute(authenticated.actor!,'store',{operationId:randomUUID(),name:'パスワード認証のデモ店舗'});
 assert.equal(authenticated.actor!.mfa,false);
 const records=await database.transaction(actor,transaction=>rows(transaction,sql`SELECT name FROM stores WHERE id=${result.id}::uuid`));assert.equal(records[0].name,'パスワード認証のデモ店舗');
 const register=request(await token(tenant,'cashier',{role:'admin'}));await activate(register);assert.equal(register.actor!.role,'cashier');assert.equal(register.actor!.mfa,false);
 await rejects(()=>administration.execute(register.actor!,'store',{operationId:randomUUID(),name:'昇格不可'}),'ADMIN_REQUIRED');
 const switched=request(await token(),{'x-pos-staff-id':cashier});await activate(switched);assert.equal(switched.actor!.role,'cashier');assert.equal(switched.actor!.mfa,false);
 await rejects(()=>administration.execute(switched.actor!,'store',{operationId:randomUUID(),name:'PIN昇格不可'}),'ADMIN_REQUIRED');
});
test('password-only exemption is tenant-bound and requires a completed genuine synthetic marker',async()=>{
 await rejects(async()=>activate(request(await token(foreign))),'MFA_REQUIRED');
 process.env.REGI_PERSONAL_SANDBOX_PASSWORD_ONLY_TENANT_ID=real;
 await rejects(async()=>activate(request(await token(real))),'MFA_REQUIRED');
 process.env.REGI_PERSONAL_SANDBOX_PASSWORD_ONLY_TENANT_ID=tenant;
 for(const [status,body] of [['pending',{version:'regi-synthetic-v1',synthetic:true}],['completed',{version:'other-version',synthetic:true}],['completed',{version:'regi-synthetic-v1',synthetic:false}]] as const){
  await database.transaction(actor,transaction=>transaction.$executeRaw(sql`UPDATE documents SET status=${status},body=${JSON.stringify(body)}::jsonb WHERE id=${marker}::uuid`));
  await rejects(async()=>activate(request(await token())),'MFA_REQUIRED');
  await rejects(()=>administration.execute(actor,'store',{operationId:randomUUID(),name:'拒否店舗'}),'ADMIN_REQUIRED');
 }
 await database.transaction(actor,transaction=>transaction.$executeRaw(sql`UPDATE documents SET status='completed',body='{"version":"regi-synthetic-v1","synthetic":true}'::jsonb WHERE id=${marker}::uuid`));
});
test('sandbox still rejects unsigned/wrong-key/expired/wrong-issuer/audience/type tokens and development headers',async()=>{
 const unsigned=Buffer.from(JSON.stringify({alg:'none'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:subject(tenant,'admin'),'custom:tenant_id':tenant})).toString('base64url')+'.';
 const other=await generateKeyPair('RS256');
 const invalid=[unsigned,await new SignJWT({'custom:tenant_id':tenant,token_use:'id'}).setProtectedHeader({alg:'RS256',kid:'sandbox-local-rsa'}).setIssuer(issuer).setAudience('sandbox-test-client').setSubject(subject(tenant,'admin')).setExpirationTime('5m').sign(other.privateKey),await new SignJWT({'custom:tenant_id':tenant,token_use:'id'}).setProtectedHeader({alg:'RS256',kid:'sandbox-local-rsa'}).setIssuer(issuer).setAudience('sandbox-test-client').setSubject(subject(tenant,'admin')).setExpirationTime(1).sign(signing.privateKey),await token(tenant,'admin',{iss:'https://wrong.example.invalid'}),await token(tenant,'admin',{aud:'wrong-client'}),await token(tenant,'admin',{token_use:'access'})];
 for(const value of invalid)await rejects(()=>activate(request(value)),'UNAUTHENTICATED');
 await rejects(()=>activate(request(undefined,{'x-tenant-id':tenant,'x-staff-subject':subject(tenant,'admin')})),'UNAUTHENTICATED');
});
