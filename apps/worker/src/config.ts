import 'dotenv/config';
import { z } from 'zod';

/** Strict boolean: only "true"/"false" (v2 used z.coerce.boolean, where "false" became true). */
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  TRADING_MODE: z.enum(['shadow', 'live']).default('shadow'),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  BOT_VENUE: z.literal('mexc').default('mexc'),
  BOT_SYMBOL: z.string().regex(/^[A-Z0-9]{4,20}$/).default('SOLUSDT'),
  BOT_REFERENCE_SYMBOL: z.string().regex(/^[A-Z0-9]{4,20}$/).default('SOLUSDT'),
  SHADOW_START_QUOTE: z.coerce.number().positive().default(15),
  SHADOW_LATENCY_MS: z.coerce.number().int().min(0).max(5_000).default(150),
  MARKET_DATA_DIR: z.string().default('./data/market'),
  PERSIST_ENABLED: bool.default('true'),
  WITHDRAW_ENABLED: bool.default('false'),
});

export type WorkerConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid worker configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  if (parsed.data.TRADING_MODE === 'live') {
    // Live execution (MexcExecutor) is phase E8 and requires the dashboard 2FA flow. Refuse loudly.
    throw new Error('TRADING_MODE=live is not enabled in this build. Shadow mode only until phase E8.');
  }
  return parsed.data;
}
