import { env } from './config/env';
import { logger } from './utils/logger';
import { MarketMakerEngine } from './modules/trading/market-maker.engine';
import { CompoundService } from './modules/trading/compound.service';
import { BinanceUserDataStreamService } from './modules/trading/binance-user-stream.service';
import { DiscordBotService } from './modules/discord/bot';

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

    // 1. Initialize Compound Service
    const compoundService = new CompoundService(env.MM_MAX_POSITION_USD, 0.5);

    // 2. Initialize Binance User Data Stream (Execution Reports)
    const userStream = new BinanceUserDataStreamService(compoundService);
    if (env.BINANCE_API_KEY) {
        await userStream.start();
    }

    // 3. Initialize Market Maker Engine
    const mmEngine = new MarketMakerEngine(env.MM_SYMBOL);
    if (env.BINANCE_API_KEY && env.BINANCE_SECRET) {
        logger.info(`Starting Binance Market Maker on ${env.MM_SYMBOL}...`);
        await mmEngine.start();
    } else {
        logger.info('Binance API Keys not set. MM Engine available on-demand.');
    }

    // 4. Initialize Discord Bot (Scout, Radar, Slash Commands, Gain Tracker)
    const discordBot = new DiscordBotService(mmEngine);
    if (env.DISCORD_TOKEN) {
        logger.info('Connecting Discord Bot Sentinel...');
        discordBot.start();
    } else {
        logger.warn('DISCORD_TOKEN not configured. Running in headless terminal mode.');
    }

    // 5. Graceful Shutdown Handlers
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
