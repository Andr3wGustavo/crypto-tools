import crypto from 'node:crypto';
import { base32Encode } from './auth/encoding';
import { otpauthUri } from './auth/totp';

/**
 * Provisioning helpers (run locally, output goes into the server's env file, never into git):
 *   npx tsx apps/api/src/provision.ts totp [account]   → API_TOTP_SECRET + otpauth URI for the app
 *   npx tsx apps/api/src/provision.ts service <name> <scope[+scope]>
 *       → a bearer token for the client, and the API_SERVICE_TOKENS entry (hash only) for the server
 */
const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'totp') {
  const secret = base32Encode(crypto.randomBytes(20));
  console.log(`API_TOTP_SECRET=${secret}`);
  console.log(`otpauth URI (paste into your authenticator, or render as a QR locally): ${otpauthUri(secret, a ?? 'operator')}`);
} else if (cmd === 'service' && a && b && /^[a-z0-9-]{2,32}$/.test(a) && /^(read|pause)(\+(read|pause))*$/.test(b)) {
  const token = crypto.randomBytes(32).toString('base64url');
  console.log(`client token (give to ${a} only): ${token}`);
  console.log(`server entry for API_SERVICE_TOKENS: ${a}:${crypto.createHash('sha256').update(token).digest('hex')}:${b}`);
} else {
  console.error('usage: provision.ts totp [account] | provision.ts service <name> <read|pause[+...]>');
  process.exit(2);
}
