import { env } from './config/env';
import { logger } from './utils/logger';
import { MarketMakerEngine } from './modules/trading/market-maker.engine';
import { CompoundService } from './modules/trading/compound.service';
import { BinanceUserDataStreamService } from './modules/trading/binance-user-stream.service';
import { DiscordBotService } from './modules/discord/bot';
import { ReconcilerService } from './modules/trading/reconciler.service';
import { BinanceAdapter } from './modules/trading/binance.adapter';

async function bootstrap() {
    console.log(`
====================================================================
   ██████╗ ██████╗ ██████╗ ████████╗███████╗██╗  ██╗   ██████╗
  ██╔════╝██╔═══██╗██╔══██╗╚══██╔══╝██╔════╝╚██╗██╔╝  ██╔════╝
  ██║     ██║   ██║██████╔╝   ██║   █████╗   ╚███╔╝   ██║     
  ██║     ██║   ██║██╔══██╗   ██║   ██╔══╝   ██╔██╗   ██║     
  ╚██████╗╚██████╔╝██║  ██║   ██║   ███████╗██╔╝ ██╗  ╚██████╗
   ╚═════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝   ╚═════╝
         UNIFIED CRYPTO SENTINEL & TRADING PLATFORM v2.0
====================================================================
    `);

    logger.info(`Starting Cortex Crypto in [${env.NODE_ENV}] mode...`);
    logger.info(`Binance Testnet: ${env.BINANCE_TESTNET}`);

    // 1. Initialize Compound Service
    const compoundService = new CompoundService(
        env.MM_CAPITAL_BASE,
        env.MM_REINVESTMENT_RATIO,
        env.MM_MAX_ORDER_USD,
        env.MM_DRAWDOWN_LIMIT,
        env.MM_ORDER_CAPITAL_FRACTION
    );
    await compoundService.init();

    // 2. Initialize Market Maker Engine
    const mmEngine = new MarketMakerEngine(env.MM_SYMBOL);

    // 3. Reconcile state with exchange on boot
    const adapter = new BinanceAdapter();
    if (env.BINANCE_API_KEY) {
        await ReconcilerService.reconcile(adapter, env.MM_SYMBOL);
    }

    // 4. Initialize Binance User Data Stream (Execution Reports + Compound)
    const userStream = new BinanceUserDataStreamService(compoundService);
    // Pass mmEngine reference for order size updates
    (userStream as any).mmEngine = mmEngine;
    if (env.BINANCE_API_KEY) {
        await userStream.start();
    }

    // 5. Initialize Market Maker Engine
    if (env.BINANCE_API_KEY && env.BINANCE_SECRET) {
        logger.info(`Starting Binance Market Maker on ${env.MM_SYMBOL}...`);
        await mmEngine.start();
    } else {
        logger.info('Binance API Keys not set. MM Engine available on-demand.');
    }

    // 6. Initialize Discord Bot (Scout, Radar, Slash Commands, Gain Tracker)
    const discordBot = new DiscordBotService(mmEngine, compoundService);
    if (env.DISCORD_TOKEN) {
        logger.info('Connecting Discord Bot Sentinel...');
        discordBot.start();
    } else {
        logger.warn('DISCORD_TOKEN not configured. Running in headless terminal mode.');
    }

    // 7. Graceful Shutdown Handlers
    const shutdown = () => {
        logger.info('Shutting down Cortex Crypto gracefully...');
        mmEngine.stop();
        userStream.stop();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

bootstrap().catch((error) => {
    logger.error('Fatal initialization error:', error);
    process.exit(1);
});