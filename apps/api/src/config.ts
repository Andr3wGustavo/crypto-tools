import { z } from 'zod';
import { base32Decode, solanaPublicKey } from './auth/encoding';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** One service token: `name:sha256hex:scope+scope` (the token itself never sits in config). */
const serviceToken = z.string().regex(/^[a-z0-9-]{2,32}:[0-9a-f]{64}:(read|pause)(\+(read|pause))*$/, 'API_SERVICE_TOKENS entry must be name:sha256hex:scope[+scope]');

export const ApiConfigSchema = z
  .object({
    API_HOST: z.string().default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    /** Exact browser origin of the dashboard, e.g. https://cortex-tokyo.tailnet.ts.net */
    API_ORIGIN: z.string().url(),
    API_ALLOWED_WALLETS: z.string().min(32),
    API_TOTP_SECRET: z.string().min(1),
    API_SERVICE_TOKENS: z.string().default(''),
    API_SESSION_TTL_HOURS: z.coerce.number().positive().max(72).default(12),
    API_COOKIE_SECURE: bool.default('true'),
    API_TRUST_PROXY: bool.default('false'),
    REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  })
  .transform((c, ctx) => {
    const origin = new URL(c.API_ORIGIN);
    if (origin.origin !== c.API_ORIGIN) ctx.addIssue({ code: 'custom', message: 'API_ORIGIN must be a bare origin (scheme://host[:port])' });
    const wallets = c.API_ALLOWED_WALLETS.split(',').map((w) => w.trim()).filter(Boolean);
    for (const w of wallets) {
      try {
        solanaPublicKey(w);
      } catch {
        ctx.addIssue({ code: 'custom', message: `API_ALLOWED_WALLETS: invalid Solana address ${w}` });
      }
    }
    let totpKey: Buffer = Buffer.alloc(0);
    try {
      totpKey = base32Decode(c.API_TOTP_SECRET);
    } catch {
      /* reported below */
    }
    if (totpKey.length < 16) ctx.addIssue({ code: 'custom', message: 'API_TOTP_SECRET must be base32 of ≥ 16 bytes (generate with: npm run api:totp)' });
    const services = c.API_SERVICE_TOKENS.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const r = serviceToken.safeParse(s);
      if (!r.success) ctx.addIssue({ code: 'custom', message: r.error.issues[0]!.message });
      const [name, hash, scopes] = s.split(':') as [string, string, string];
      return { name, hash, scopes: new Set(scopes?.split('+') ?? []) };
    });
    return {
      host: c.API_HOST,
      port: c.API_PORT,
      origin: origin.origin,
      domain: origin.host,
      allowlist: new Set(wallets),
      totpKey,
      services,
      sessionTtlMs: c.API_SESSION_TTL_HOURS * 3_600_000,
      cookieSecure: c.API_COOKIE_SECURE,
      trustProxy: c.API_TRUST_PROXY,
      redisUrl: c.REDIS_URL,
    };
  });

export type ApiConfig = z.output<typeof ApiConfigSchema>;

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const r = ApiConfigSchema.safeParse(env);
  if (!r.success) throw new Error(`invalid API config:\n${r.error.issues.map((i) => `  - ${i.path.join('.') || 'config'}: ${i.message}`).join('\n')}`);
  return r.data;
}
