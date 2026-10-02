import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { ExecutionContext } from '@nestjs/common';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { Auth } from '../apps/api/src/auth';
import { Database, sql, type Actor } from '../apps/api/src/db';
import { BusinessError } from '../apps/api/src/errors';
import { pinHash } from '../apps/api/src/service';

assert.ok(
  ['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname),
  'Audience regression must only connect to local PostgreSQL',
);

const database = new Database();
const tenant = randomUUID();
const staff = randomUUID();
const store = randomUUID();
const subject = `${tenant}-administrator`;
const webClient = 'audience-test-web';
const androidClient = 'audience-test-android';
const actor: Actor = {
  tenantId: tenant,
  staffId: staff,
  role: 'admin',
  stores: [store],
  mfa: true,
};
const environmentKeys = [
  'NODE_ENV',
  'REGI_DEV_AUTH',
  'COGNITO_ISSUER',
  'COGNITO_CLIENT_ID',
  'COGNITO_ANDROID_CLIENT_ID',
  'COGNITO_MFA_ENFORCED',
  'REGI_PERSONAL_SANDBOX_PASSWORD_ONLY_TENANT_ID',
] as const;
const saved = new Map(environmentKeys.map((key) => [key, process.env[key]] as const));
const server = createServer();
let issuer: string;
let auth: Auth;
let signing: Awaited<ReturnType<typeof generateKeyPair>>;

type AuthRequest = { path: string; headers: Record<string, string>; actor?: Actor };
const request = (token: string): AuthRequest => ({
  path: '/v1/settings',
  headers: { authorization: `Bearer ${token}` },
});
const activate = (input: AuthRequest) =>
  auth.canActivate({ switchToHttp: () => ({ getRequest: () => input }) } as ExecutionContext);
const token = (audience = webClient, overrides: JWTPayload = {}, key = signing.privateKey) =>
  new SignJWT({
    'custom:tenant_id': tenant,
    token_use: 'id',
    amr: ['mfa'],
    sub: subject,
    iss: issuer,
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'audience-local-rsa' })
    .sign(key);
const rejects = (input: AuthRequest, code = 'UNAUTHENTICATED', status = 401) =>
  assert.rejects(
    () => activate(input),
    (error: unknown) =>
      error instanceof BusinessError && error.code === code && error.status === status,
  );

void before(async () => {
  await database.onModuleInit();
  signing = await generateKeyPair('RS256');
  const publicKey = await exportJWK(signing.publicKey);
  server.on('request', (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        keys: [{ ...publicKey, kid: 'audience-local-rsa', alg: 'RS256', use: 'sig' }],
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  issuer = `http://127.0.0.1:${address.port}`;
  Object.assign(process.env, {
    NODE_ENV: 'production',
    REGI_DEV_AUTH: 'false',
    COGNITO_ISSUER: issuer,
    COGNITO_CLIENT_ID: webClient,
    COGNITO_ANDROID_CLIENT_ID: androidClient,
    COGNITO_MFA_ENFORCED: 'false',
  });
  delete process.env.REGI_PERSONAL_SANDBOX_PASSWORD_ONLY_TENANT_ID;
  auth = new Auth(database);
  await database.transaction(actor, async (transaction) => {
    await transaction.$executeRaw(
      sql`INSERT INTO tenants VALUES(${tenant}::uuid,'端末audience試験法人','inclusive',now()-interval '1 day',now()+interval '24 months',1)`,
    );
    await transaction.$executeRaw(
      sql`INSERT INTO stores VALUES(${store}::uuid,${tenant}::uuid,'端末audience試験店舗')`,
    );
    await transaction.$executeRaw(
      sql`INSERT INTO staff VALUES(${staff}::uuid,${tenant}::uuid,${subject},'端末audience試験管理者','admin',ARRAY[${store}::uuid],${pinHash('456789', randomUUID())},true)`,
    );
  });
});

void after(async () => {
  for (const key of environmentKeys) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.client.$disconnect();
});

void test('Cognito accepts signed Web and Android ID tokens with the same tenant staff and MFA checks', async () => {
  for (const audience of [webClient, androidClient]) {
    const authenticated = request(await token(audience));
    assert.equal(await activate(authenticated), true);
    assert.deepEqual(authenticated.actor, actor);
  }
});

void test('Android audience retains signature issuer expiry token-use tenant subject and administrator MFA boundaries', async () => {
  const other = await generateKeyPair('RS256');
  const invalid = [
    await token(androidClient, {}, other.privateKey),
    await token(androidClient, { iss: 'https://foreign.example.invalid' }),
    await token('foreign-client'),
    await token(androidClient, { exp: 1 }),
    await token(androidClient, { token_use: 'access' }),
    await token(androidClient, { 'custom:tenant_id': 'invalid-tenant' }),
    await token(androidClient, { sub: undefined }),
    await token(androidClient, { sub: `${subject}-inactive` }),
  ];
  for (const value of invalid) await rejects(request(value));
  await rejects(request(await token(androidClient, { amr: ['pwd'] })), 'MFA_REQUIRED', 403);
});

void test('Web authentication remains available before the Android client ID is configured', async () => {
  delete process.env.COGNITO_ANDROID_CLIENT_ID;
  try {
    const authenticated = request(await token());
    assert.equal(await activate(authenticated), true);
    assert.deepEqual(authenticated.actor, actor);
    await rejects(request(await token(androidClient)));
  } finally {
    process.env.COGNITO_ANDROID_CLIENT_ID = androidClient;
  }
});

void test('Android client configuration does not replace the required Web Cognito client', async () => {
  delete process.env.COGNITO_CLIENT_ID;
  try {
    await rejects(request(await token(androidClient)), 'AUTH_CONFIG', 503);
  } finally {
    process.env.COGNITO_CLIENT_ID = webClient;
  }
});
