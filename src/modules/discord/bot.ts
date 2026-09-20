import {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    TextChannel,
    ChatInputCommandInteraction
} from 'discord.js';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { DexScreenerService } from '../scout/dexscreener.service';
import { SecurityService } from '../scout/security.service';
import { FilterService } from '../scout/filter.service';
import { GeminiService } from '../ai/gemini.service';
import { MemoryService } from '../rag/memory.service';
import { MacroMarketService } from '../market/macro.service';
import { GainTrackerService } from '../tracker/gain-tracker.service';
import { DiscordEmbedFactory } from './embeds';
import { MarketMakerEngine } from '../trading/market-maker.engine';

export class DiscordBotService {
    private client: Client;
    private mmEngine: MarketMakerEngine;
    private isRadarRunning = false;

    constructor(mmEngine: MarketMakerEngine) {
        this.mmEngine = mmEngine;
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages
            ]
        });

        this.setupEventHandlers();
    }

    private setupEventHandlers() {
        this.client.once('ready', async () => {
            logger.info(`🤖 Cortex Crypto Bot online as ${this.client.user?.tag}!`);
            await this.registerSlashCommands();
            this.startAutomatedRadar();
            this.startGainTrackerLoop();
        });

        this.client.on('interactionCreate', async (interaction) => {
            if (!interaction.isChatInputCommand()) return;
            await this.handleSlashCommand(interaction);
        });
    }

    /**
     * Register slash commands with Discord API
     */
    private async registerSlashCommands() {
        if (!env.DISCORD_TOKEN || !env.DISCORD_CLIENT_ID) {
            logger.warn('DISCORD_TOKEN or DISCORD_CLIENT_ID not set. Skipping slash command registration.');
            return;
        }

        const commands = [
            new SlashCommandBuilder()
                .setName('analyze')
                .setDescription('Perform instant AI & Security audit on any token or pair address')
                .addStringOption(opt =>
                    opt.setName('address')
                        .setDescription('Token contract or Dex pair address')
                        .setRequired(true)
                ),
            new SlashCommandBuilder()
                .setName('radar')
                .setDescription('View recently discovered gems and scanned tokens'),
            new SlashCommandBuilder()
                .setName('market')
                .setDescription('Get macro market status (Fear & Greed, BTC, ETH)'),
            new SlashCommandBuilder()
                .setName('mm')
                .setDescription('Check Binance Adaptive Market Maker status')
                .addStringOption(opt =>
                    opt.setName('action')
                        .setDescription('Action to execute')
                        .setRequired(false)
                        .addChoices(
                            { name: 'Status', value: 'status' },
                            { name: 'Start', value: 'start' },
                            { name: 'Stop', value: 'stop' }
                        )
                ),
            new SlashCommandBuilder()
                .setName('gains')
                .setDescription('List actively tracked positions and trailing stops')
        ];

        try {
            const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);
            logger.info('Registering slash commands with Discord...');

            if (env.DISCORD_GUILD_ID) {
                await rest.put(
                    Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID),
                    { body: commands.map(c => c.toJSON()) }
                );
            } else {
                await rest.put(
                    Routes.applicationCommands(env.DISCORD_CLIENT_ID),
                    { body: commands.map(c => c.toJSON()) }
                );
            }

            logger.info('✅ Discord Slash Commands registered successfully!');
        } catch (error: any) {
            logger.error(`Failed to register slash commands: ${error.message}`);
        }
    }

    /**
     * Handle slash command execution
     */
    private async handleSlashCommand(interaction: ChatInputCommandInteraction) {
        const { commandName } = interaction;

        try {
            if (commandName === 'analyze') {
                await interaction.deferReply();
                const address = interaction.options.getString('address', true);

                const pair = await DexScreenerService.getPairByAddress(address);
                if (!pair) {
                    await interaction.editReply(`❌ Could not find pair or token for address: \`${address}\``);
                    return;
                }

                const security = await SecurityService.auditToken(pair.chainId, pair.baseToken.address);
                const aiReport = await GeminiService.analyzeToken(pair, security);

                // Save to memory
                await MemoryService.recordToken({
                    ...pair,
                    address: pair.pairAddress,
                    name: pair.baseToken.name,
                    symbol: pair.baseToken.symbol,
                    liquidity: pair.liquidity?.usd || 0,
                    price: parseFloat(pair.priceUsd || '0'),
                    riskScore: aiReport.score,
                    aiAnalysis: aiReport.summary,
                    isScam: aiReport.isScam,
                    isWinner: aiReport.isWinner,
                    ...security
                });

                const embed = DiscordEmbedFactory.createTokenEmbed(pair, security, aiReport);
                await interaction.editReply({ embeds: [embed] });

            } else if (commandName === 'market') {
                await interaction.deferReply();
                const macro = await MacroMarketService.getSnapshot();
                const embed = DiscordEmbedFactory.createMacroEmbed(macro);
                await interaction.editReply({ embeds: [embed] });

            } else if (commandName === 'radar') {
                await interaction.deferReply();
                const stats = await MemoryService.getGlobalStats();
                await interaction.editReply(`📊 **Radar Memory Stats**\n• Total Scanned: **${stats.totalScanned}**\n• Gems Identified: **${stats.gems}**\n• Scams Filtered: **${stats.scams}**`);

            } else if (commandName === 'mm') {
                const action = interaction.options.getString('action') || 'status';

                if (action === 'start') {
                    this.mmEngine.start();
                    await interaction.reply('🟢 Started Binance Market Maker Engine.');
                } else if (action === 'stop') {
                    this.mmEngine.stop();
                    await interaction.reply('🛑 Stopped Binance Market Maker Engine.');
                } else {
                    const status = this.mmEngine.getStatus();
                    await interaction.reply(`⚙️ **Binance MM Status [${status.symbol}]**\n• Running: **${status.isRunning ? 'YES 🟢' : 'NO 🔴'}**\n• Cycles Completed: **${status.cycleCount}**\n• Mid Price: **$${status.lastMidPrice.toFixed(2)}**\n• Book Imbalance: **${(status.lastImbalance * 100).toFixed(2)}%**\n• Volatility (Respiro): **${(status.volatilityRespiro * 100).toFixed(4)}%**`);
                }

            } else if (commandName === 'gains') {
                await interaction.deferReply();
                const positions = await GainTrackerService.getActivePositions();
                if (positions.length === 0) {
                    await interaction.editReply('No active positions currently tracked.');
                    return;
                }

                const list = positions.map(p => `• **${p.symbol}** (${p.chain}): Entry $${p.entryPrice} | Now $${p.currentPrice} | PnL: **${p.currentGainPct >= 0 ? '+' : ''}${p.currentGainPct.toFixed(1)}%** (Peak: +${p.highestGainPct.toFixed(1)}%)`).join('\n');
                await interaction.editReply(`📈 **Active Tracked Positions:**\n${list}`);
            }
        } catch (error: any) {
            logger.error(`Error executing command /${commandName}:`, { message: error.message });
            if (interaction.deferred) {
                await interaction.editReply(`⚠️ Error executing command: ${error.message}`);
            } else if (!interaction.replied) {
                await interaction.reply({ content: `⚠️ Error: ${error.message}`, ephemeral: true });
            }
        }
    }

    /**
     * Automated background radar loop for newly listed and trending tokens
     */
    private startAutomatedRadar() {
        if (this.isRadarRunning) return;
        this.isRadarRunning = true;

        logger.info(`🛰️ Starting Automated DexScreener Radar (Polling every ${env.POLL_INTERVAL_MS / 1000}s)...`);

        setInterval(async () => {
            try {
                const candidates = await DexScreenerService.getLatestCandidates();

                for (const pair of candidates) {
                    if (!pair || !pair.pairAddress) continue;

                    // 1. Audit Security Heuristics (GoPlus / RugCheck)
                    const security = await SecurityService.auditToken(pair.chainId, pair.baseToken.address);

                    // 2. Evaluate Filter thresholds
                    const filter = FilterService.evaluate(pair, security);
                    if (!filter.passed) {
                        continue;
                    }

                    // 3. AI Due Diligence
                    logger.info(`Candidate Passed Heuristics: ${pair.baseToken.name} (${pair.baseToken.symbol}) on ${pair.chainId}`);
                    const aiReport = await GeminiService.analyzeToken(pair, security);

                    // 4. Save to Memory / Prisma
                    await MemoryService.recordToken({
                        address: pair.pairAddress,
                        name: pair.baseToken.name,
                        symbol: pair.baseToken.symbol,
                        chainId: pair.chainId,
                        dexId: pair.dexId,
                        url: pair.url,
                        imageUrl: pair.info?.imageUrl,
                        liquidity: pair.liquidity?.usd || 0,
                        fdv: pair.fdv || 0,
                        price: parseFloat(pair.priceUsd || '0'),
                        volume24h: pair.volume?.h24 || 0,
                        priceChange24h: pair.priceChange?.h24 || 0,
                        pairCreatedAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : new Date(),
                        isHoneypot: security.isHoneypot,
                        buyTax: security.buyTax,
                        sellTax: security.sellTax,
                        isMintable: security.isMintable,
                        riskScore: aiReport.score,
                        aiAnalysis: aiReport.summary,
                        isScam: aiReport.isScam,
                        isWinner: aiReport.isWinner
                    });

                    // 5. Notify Discord if verified gem candidate
                    if (aiReport.score >= 80 && !aiReport.isScam) {
                        const channelId = env.DISCORD_ALERT_CHANNEL_ID;
                        if (channelId) {
                            const channel = this.client.channels.cache.get(channelId) as TextChannel;
                            if (channel) {
                                const embed = DiscordEmbedFactory.createTokenEmbed(pair, security, aiReport);
                                await channel.send({ embeds: [embed] });
                                logger.info(`📢 Gem Alert Sent for ${pair.baseToken.symbol}!`);
                            }
                        }
                    }
                }
            } catch (error: any) {
                logger.error(`Automated Radar Loop error: ${error.message}`);
            }
        }, env.POLL_INTERVAL_MS);
    }

    /**
     * Automated Gain and Trailing Stop evaluation loop
     */
    private startGainTrackerLoop() {
        setInterval(async () => {
            try {
                const alerts = await GainTrackerService.evaluatePositions();
                for (const alert of alerts) {
                    const channelId = env.DISCORD_TRADING_CHANNEL_ID || env.DISCORD_ALERT_CHANNEL_ID;
                    if (channelId) {
                        const channel = this.client.channels.cache.get(channelId) as TextChannel;
                        if (channel) {
                            const embed = DiscordEmbedFactory.createPositionAlertEmbed(alert);
                            await channel.send({ embeds: [embed] });
                        }
                    }
                }
            } catch (error: any) {
                logger.error(`Gain Tracker error: ${error.message}`);
            }
        }, 60000); // Check every minute
    }

    start() {
        if (!env.DISCORD_TOKEN) {
            logger.warn('DISCORD_TOKEN not configured. Discord bot client will not connect.');
            return;
        }
        this.client.login(env.DISCORD_TOKEN).catch(err => {
            logger.error(`Discord login failed: ${err.message}`);
        });
    }
}
