import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    DATABASE_URL: z.string().min(1),

    // Discord
    DISCORD_TOKEN: z.string().optional().default(''),
    DISCORD_CLIENT_ID: z.string().optional().default(''),
    DISCORD_GUILD_ID: z.string().optional().default(''),
    DISCORD_ALERT_CHANNEL_ID: z.string().optional().default(''),
    DISCORD_TRADING_CHANNEL_ID: z.string().optional().default(''),

    // AI
    GEMINI_API_KEY: z.string().optional().default(''),
    GEMINI_MODEL: z.string().default('gemini-2.0-flash'),

    // Scout / Radar
    MIN_LIQUIDITY_USD: z.coerce.number().default(10000),
    MIN_VOLUME_USD_24H: z.coerce.number().default(25000),
    MAX_AGE_HOURS: z.coerce.number().default(72),
    POLL_INTERVAL_MS: z.coerce.number().default(30000),
});

const parseEnv = () => {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
        console.error('Invalid environment configuration:', parsed.error.format());
        throw new Error('Environment validation failed.');
    }
    return parsed.data;
};

export const env = parseEnv();
