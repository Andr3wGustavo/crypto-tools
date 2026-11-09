import { env } from './config/env';
import { logger } from './utils/logger';
import { DiscordBotService } from './modules/discord/bot';

/**
 * Cortex Sentinel — DEX scout, AI due diligence and Discord terminal.
 * Trading (market making, treasury, withdrawals) lives in apps/worker; Discord trading
 * commands will come back through the authenticated API (see docs/MASTER-PLAN.md).
 */
async function bootstrap(): Promise<void> {
    logger.info(`Starting Cortex Sentinel in [${env.NODE_ENV}] mode...`);

    const discordBot = new DiscordBotService();
    if (env.DISCORD_TOKEN) {
        discordBot.start();
    } else {
        logger.warn('DISCORD_TOKEN not configured. Sentinel is idle.');
    }

    const shutdown = (signal: string) => {
        logger.info(`Received ${signal}. Shutting down Cortex Sentinel.`);
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((error) => {
    logger.error('Fatal initialization error:', error);
    process.exit(1);
});
