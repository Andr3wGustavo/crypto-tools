import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
    DISCORD_TOKEN: z.string().min(1),
    DISCORD_CHANNEL_ID: z.string().min(1),
    GOOGLE_API_KEY: z.string().min(1),
    DATABASE_URL: z.string().default("file:./dev.db"),
    MIN_LIQUIDITY: z.string().transform(Number).default("5000"),
    MIN_VOLUME: z.string().transform(Number).default("1000"),
    POLL_INTERVAL: z.string().transform(Number).default("60000"),
});

export const config = envSchema.parse(process.env);
