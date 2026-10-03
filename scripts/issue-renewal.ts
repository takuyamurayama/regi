import { readFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
import { renewalSchema } from '../apps/api/src/renewal';
const [tenantId, reference, expiresAt, keyPath] = process.argv.slice(2);
const contract = renewalSchema.parse({
  tenantId,
  reference,
  expiresAt,
  months: 12,
  priceExTax: '2400000',
});
if (!keyPath)
  throw new Error('Seller-only Ed25519 private key file required; never upload to customer API');
const payload = Buffer.from(JSON.stringify(contract)).toString('base64url');
console.log(
  `${payload}.${sign(null, Buffer.from(payload), createPrivateKey(readFileSync(keyPath))).toString('base64url')}`,
);
