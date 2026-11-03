import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

// Load environment variables from .env
dotenv.config();

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    DATABASE_URL: z.string().default('file:./prisma/dev.db'),

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

    // Binance Trading
    BINANCE_API_KEY: z.string().optional().default(''),
    BINANCE_SECRET: z.string().optional().default(''),
    BINANCE_TESTNET: z.coerce.boolean().default(false),
    BINANCE_BASE_URL: z.string().default('https://api.binance.com'),
    BINANCE_WS_URL: z.string().default('wss://stream.binance.com:9443/ws'),
    BINANCE_TESTNET_BASE_URL: z.string().default('https://testnet.binance.vision'),
    BINANCE_TESTNET_WS_URL: z.string().default('wss://testnet.binance.vision/ws'),

    MM_SYMBOL: z.string().default('BTCUSDT'),
    MM_MIN_ORDER_USD: z.coerce.number().default(15.0),
    MM_MAX_POSITION_USD: z.coerce.number().default(100.0),
    MM_SAFETY_MARGIN: z.coerce.number().default(0.0005),
    MM_ATR_MULTIPLIER: z.coerce.number().default(2.0),
    MM_IMBALANCE_MULTIPLIER: z.coerce.number().default(0.5),
    MM_SKEW_FACTOR: z.coerce.number().default(0.001),
    MM_INVENTORY_TARGET: z.coerce.number().default(0.5),
    MM_DAILY_STOP_LOSS: z.coerce.number().default(-0.015),
    MM_DRIFT_THRESHOLD: z.coerce.number().default(0.002),

    // Compound / Capital Management
    MM_CAPITAL_BASE: z.coerce.number().default(100.0),
    MM_REINVESTMENT_RATIO: z.coerce.number().default(0.5),
    MM_MAX_ORDER_USD: z.coerce.number().default(200.0),
    MM_DRAWDOWN_LIMIT: z.coerce.number().default(0.15),
    MM_ORDER_CAPITAL_FRACTION: z.coerce.number().default(0.2),

    // Solana DEX
    SOLANA_RPC_URL: z.string().default('https://api.mainnet-beta.solana.com'),
    SOLANA_PRIVATE_KEY: z.string().optional().default(''),
    DEX_AUTO_BUY_ENABLED: z.coerce.boolean().default(false),
    DEX_AUTO_BUY_AMOUNT_SOL: z.coerce.number().default(0.1),
    DEX_MIN_AI_SCORE: z.coerce.number().default(90),

    // Auto-Withdraw (profit skimming)
    WITHDRAW_THRESHOLD: z.coerce.number().default(0.5),
    WITHDRAW_DESTINATION: z.string().optional().default(''),
    WITHDRAW_ASSET: z.string().default('USDT'),
});

const parseEnv = () => {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
        console.error('❌ Invalid environment variables configuration:', parsed.error.format());
        throw new Error('Environment validation failed.');
    }
    return parsed.data;
};

export const env = parseEnv();
