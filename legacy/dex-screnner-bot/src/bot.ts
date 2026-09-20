import { Client, GatewayIntentBits, TextChannel, EmbedBuilder } from 'discord.js';
import { config } from './config/env';
import { logger } from './utils/logger';
import { DexScreenerService } from './services/dexscreener';
import { FilterService } from './services/filter';
import { AIService } from './services/ai';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const aiService = new AIService();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
    ]
});

client.once('ready', () => {
    logger.info(`Logged in as ${client.user?.tag}!`);
    startMonitoring();
});

async function startMonitoring() {
    logger.info("Starting Market Watcher...");

    setInterval(async () => {
        try {
            const pairs = await DexScreenerService.getLatestPairs();

            for (const pair of pairs) {
                // Check if already processed in DB
                const existing = await prisma.token.findUnique({
                    where: { address: pair.pairAddress }
                });

                if (existing) continue;

                // 1. Filter
                const filterResult = FilterService.filter(pair);
                if (!filterResult.passed) {
                    // logger.info(`Skipped ${pair.baseToken.symbol}: ${filterResult.reason}`);
                    continue;
                }

                // 2. AI Analysis
                logger.info(`Analyzing candidate: ${pair.baseToken.name} (${pair.baseToken.symbol})`);
                const aiResult = await aiService.analyzeToken(pair);

                // 3. Store in DB (RAG Ready)
                await prisma.token.create({
                    data: {
                        address: pair.pairAddress,
                        name: pair.baseToken.name,
                        symbol: pair.baseToken.symbol,
                        chainId: pair.chainId,
                        dexId: pair.dexId,
                        url: pair.url,
                        liquidity: pair.liquidity.usd,
                        fdv: pair.fdv,
                        price: parseFloat(pair.priceUsd),
                        riskScore: aiResult.score,
                        aiAnalysis: aiResult.analysis,
                        isScam: aiResult.isScam,
                        isWinner: aiResult.score > 80
                    }
                }).catch(e => logger.error(`DB Error: ${e.message}`));

                // 4. Notify Discord
                if (!aiResult.isScam) {
                    const channel = client.channels.cache.get(config.DISCORD_CHANNEL_ID) as TextChannel;
                    if (channel) {
                        const embed = new EmbedBuilder()
                            .setTitle(`🚀 New Potential Gem: ${pair.baseToken.name} (${pair.baseToken.symbol})`)
                            .setURL(pair.url)
                            .setColor(aiResult.score > 80 ? 0x00FF00 : 0xFFA500)
                            .addFields(
                                { name: 'Price', value: `$${pair.priceUsd}`, inline: true },
                                { name: 'Liquidity', value: `$${pair.liquidity.usd.toLocaleString()}`, inline: true },
                                { name: 'FDV', value: `$${pair.fdv.toLocaleString()}`, inline: true },
                                { name: 'AI Confidence', value: `${aiResult.score}/100`, inline: true },
                                { name: 'Analysis', value: aiResult.analysis.substring(0, 1024) }
                            )
                            .setFooter({ text: `DexScreener • ${pair.chainId}` })
                            .setTimestamp();

                        await channel.send({ embeds: [embed] });
                    } else {
                        logger.warn(`Channel ${config.DISCORD_CHANNEL_ID} not found`);
                    }
                }
            }
        } catch (error) {
            logger.error(`Monitoring Loop Error: ${error}`);
        }
    }, config.POLL_INTERVAL);
}

client.login(config.DISCORD_TOKEN);
