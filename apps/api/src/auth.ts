import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import { Actor, Database, rows, sql } from './db';
import { requireRule } from './errors';
import { z } from 'zod';
import { hasAdministratorAuthentication } from './admin-authentication';
export function recoveryKey() {
  const secret =
    process.env.RECOVERY_SIGNING_SECRET ??
    (['development', 'test'].includes(process.env.NODE_ENV ?? '')
      ? 'regi-development-recovery-only-32-bytes'
      : '');
  requireRule(secret.length >= 32, 'RECOVERY_CONFIG', '回収経路の署名鍵が未設定です', 503);
  return new TextEncoder().encode(secret);
}
export function recoveryToken(actor: Actor, deviceId: string, leaseId: string, endsAt: Date) {
  return new SignJWT({
    tenantId: actor.tenantId,
    staffId: actor.staffId,
    stores: actor.stores,
    deviceId,
    leaseId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('regi-recovery')
    .setExpirationTime(Math.floor((endsAt.getTime() + 90 * 86400000) / 1000))
    .sign(recoveryKey());
}
@Injectable()
export class Auth implements CanActivate {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  constructor(private readonly database: Database) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    if (request.path === '/health') return true;
    if (request.path === '/v1/sync/events' && request.headers['x-recovery-token']) {
      try {
        const { payload } = await jwtVerify(request.headers['x-recovery-token'], recoveryKey(), {
          issuer: 'regi-recovery',
          algorithms: ['HS256'],
        });
        const claims = z
          .object({
            tenantId: z.uuid(),
            staffId: z.uuid(),
            stores: z.array(z.uuid()),
            deviceId: z.uuid(),
            leaseId: z.uuid(),
          })
          .parse(payload);
        request.actor = { ...claims, role: 'cashier', mfa: false };
        return true;
      } catch {
        requireRule(false, 'RECOVERY_INVALID', '回収用の端末資格情報が無効です', 401);
      }
    }
    let tenantId: string,
      subject: string,
      mfa = false;
    if (process.env.REGI_DEV_AUTH === 'true') {
      requireRule(
        process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
        'DEV_AUTH_FORBIDDEN',
        '開発認証は本番で使用できません',
        500,
      );
      tenantId = request.headers['x-tenant-id'];
      subject = request.headers['x-staff-subject'];
      mfa = true;
    } else {
      const issuer = process.env.COGNITO_ISSUER;
      requireRule(
        issuer && process.env.COGNITO_CLIENT_ID,
        'AUTH_CONFIG',
        'Cognitoが未設定です',
        503,
      );
      this.jwks ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
      const token = request.headers.authorization?.replace(/^Bearer /, '');
      requireRule(token, 'UNAUTHENTICATED', 'ログインが必要です', 401);
      try {
        const { payload } = await jwtVerify(token, this.jwks, {
          issuer,
          audience: process.env.COGNITO_CLIENT_ID,
          algorithms: ['RS256'],
        });
        requireRule(payload.token_use === 'id', 'TOKEN_USE', 'IDトークンが必要です', 401);
        tenantId = payload['custom:tenant_id'] as string;
        subject = payload.sub!;
        mfa =
          (Array.isArray(payload.amr) && payload.amr.includes('mfa')) ||
          process.env.COGNITO_MFA_ENFORCED === 'true';
      } catch {
        requireRule(false, 'UNAUTHENTICATED', '認証期限または署名を確認してください', 401);
      }
    }
    requireRule(
      z.uuid().safeParse(tenantId!).success && typeof subject! === 'string',
      'UNAUTHENTICATED',
      '法人・担当者の認証が必要です',
      401,
    );
    const bootstrap: Actor = {
      tenantId: tenantId!,
      staffId: '00000000-0000-0000-0000-000000000000',
      role: 'cashier',
      stores: [],
      mfa,
    };
    const records = await this.database.transaction(bootstrap, (transaction) =>
      rows(
        transaction,
        sql`SELECT id,role,stores FROM staff WHERE subject=${subject!} AND active=true`,
      ),
    );
    requireRule(records.length, 'UNAUTHENTICATED', '担当者が無効です', 401);
    const staff = records[0];
    request.actor = { ...bootstrap, staffId: staff.id, role: staff.role, stores: staff.stores };
    requireRule(
      staff.role !== 'admin' ||
        (await hasAdministratorAuthentication(this.database, request.actor)),
      'MFA_REQUIRED',
      '法人管理者はMFAが必要です',
      403,
    );
    if (request.headers['x-pos-staff-id']) {
      const selected = z.uuid().safeParse(request.headers['x-pos-staff-id']);
      requireRule(selected.success, 'POS_STAFF', 'POS担当者が不正です', 401);
      const [pos] = await this.database.transaction(request.actor, (transaction) =>
        rows(
          transaction,
          sql`SELECT id,role,stores FROM staff WHERE id=${selected.data}::uuid AND active`,
        ),
      );
      requireRule(pos, 'POS_STAFF', 'POS担当者が無効です', 401);
      const levels = ['cashier', 'manager', 'headquarters', 'admin'],
        role = levels[Math.min(levels.indexOf(staff.role), levels.indexOf(pos.role))];
      const stores = ['admin', 'headquarters'].includes(staff.role)
        ? pos.stores
        : pos.stores.filter((id: string) => staff.stores.includes(id));
      requireRule(
        stores.length,
        'POS_STAFF',
        'ログイン担当者とPIN担当者の店舗所属が異なります',
        403,
      );
      request.actor = { ...request.actor, staffId: pos.id, role, stores };
    }
    return true;
  }
}
