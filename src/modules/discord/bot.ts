import {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    TextChannel,
    ChatInputCommandInteraction,
    ButtonInteraction
} from 'discord.js';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { DexScreenerService } from '../scout/dexscreener.service';
import { SecurityService } from '../scout/security.service';
import { FilterService } from '../scout/filter.service';
import { GeminiService } from '../ai/gemini.service';
import { MemoryService } from '../rag/memory.service';
import { VectorService } from '../rag/vector.service';
import { MacroMarketService } from '../market/macro.service';
import { GainTrackerService } from '../tracker/gain-tracker.service';
import { JupiterService } from '../dex-trader/jupiter.service';
import { DiscordEmbedFactory } from './embeds';
import { MarketMakerEngine } from '../trading/market-maker.engine';
import { CompoundService } from '../trading/compound.service';

export class DiscordBotService {
    private client: Client;
    private mmEngine: MarketMakerEngine;
    private compoundService: CompoundService;
    private isRadarRunning = false;

    constructor(mmEngine: MarketMakerEngine, compoundService: CompoundService) {
        this.mmEngine = mmEngine;
        this.compoundService = compoundService;
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
            logger.info(`Discord Bot online as ${this.client.user?.tag}`);
            await this.registerSlashCommands();
            this.startAutomatedRadar();
            this.startGainTrackerLoop();
        });

        this.client.on('interactionCreate', async (interaction) => {
            if (interaction.isChatInputCommand()) {
                await this.handleSlashCommand(interaction);
            } else if (interaction.isButton()) {
                await this.handleButtonInteraction(interaction);
            }
        });
    }

    /**
     * Register comprehensive slash commands with Discord API
     */
    private async registerSlashCommands() {
        if (!env.DISCORD_TOKEN || !env.DISCORD_CLIENT_ID) {
            logger.warn('DISCORD_TOKEN or DISCORD_CLIENT_ID not set. Skipping slash command registration.');
            return;
        }

        const commands = [
            new SlashCommandBuilder()
                .setName('analyze')
                .setDescription('Perform instant AI and Security audit on any token or pair address')
                .addStringOption(opt =>
                    opt.setName('address')
                        .setDescription('Token contract or Dex pair address')
                        .setRequired(true)
                ),
            new SlashCommandBuilder()
                .setName('ask')
                .setDescription('Query RAG historical memory and AI for market intelligence')
                .addStringOption(opt =>
                    opt.setName('query')
                        .setDescription('Question or pattern to query')
                        .setRequired(true)
                ),
            new SlashCommandBuilder()
                .setName('track')
                .setDescription('Track a position with automated trailing stop-loss')
                .addStringOption(opt =>
                    opt.setName('address')
                        .setDescription('Token pair contract address')
                        .setRequired(true)
                )
                .addNumberOption(opt =>
                    opt.setName('entry_price')
                        .setDescription('Your entry price in USD')
                        .setRequired(true)
                )
                .addNumberOption(opt =>
                    opt.setName('trailing_stop')
                        .setDescription('Trailing stop drop percentage (default 15%)')
                        .setRequired(false)
                ),
            new SlashCommandBuilder()
                .setName('swap')
                .setDescription('Simulate DEX swap quote and price impact via Jupiter')
                .addStringOption(opt =>
                    opt.setName('mint')
                        .setDescription('Token mint address (Solana)')
                        .setRequired(true)
                )
                .addNumberOption(opt =>
                    opt.setName('amount_sol')
                        .setDescription('Amount of SOL to swap (default 0.1 SOL)')
                        .setRequired(false)
                ),
            new SlashCommandBuilder()
                .setName('radar')
                .setDescription('View database metrics on scanned tokens, verified gems, and scams'),
            new SlashCommandBuilder()
                .setName('market')
                .setDescription('Display macro market status, Fear and Greed index, BTC and ETH'),
            new SlashCommandBuilder()
                .setName('mm')
                .setDescription('Control and inspect the Binance Adaptive Market Maker')
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
                .setDescription('Display actively tracked positions and trailing stop levels'),
            new SlashCommandBuilder()
                .setName('compound')
                .setDescription('Display compound capital stats and edge estimation')
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

            logger.info('Discord Slash Commands registered successfully.');
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
                    await interaction.editReply(`Could not locate pair or token for address: \`${address}\``);
                    return;
                }

                const security = await SecurityService.auditToken(pair.chainId, pair.baseToken.address);
                const aiReport = await GeminiService.analyzeToken(pair, security);

                // Save to database memory
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

                // Attach vector embedding in background
                VectorService.attachEmbedding(
                    pair.pairAddress,
                    `${pair.baseToken.name} (${pair.baseToken.symbol}) ${pair.chainId} ${aiReport.summary}`
                ).catch(() => {});

                const embed = DiscordEmbedFactory.createTokenEmbed(pair, security, aiReport);
                const actionRow = DiscordEmbedFactory.createTokenActionRow(pair);
                await interaction.editReply({ embeds: [embed], components: [actionRow] });

            } else if (commandName === 'ask') {
                await interaction.deferReply();
                const query = interaction.options.getString('query', true);
                const similar = await VectorService.searchSimilarTokens(query, 3);

                let replyText = `**RAG Memory Query**: "${query}"\n\n`;
                if (similar.length === 0) {
                    replyText += 'No historically similar tokens found in local memory database.';
                } else {
                    replyText += '**Top Historical Matches in Memory:**\n';
                    for (const s of similar) {
                        const status = s.isWinner ? 'WINNER' : s.isScam ? 'SCAM' : 'NEUTRAL';
                        replyText += `- **${s.name} ($${s.symbol})**: Similarity ${(s.similarity * 100).toFixed(1)}% | Status: [${status}] | Score: ${s.riskScore}/100\n  *Summary: ${s.summary || 'N/A'}*\n`;
                    }
                }
                await interaction.editReply(replyText);

            } else if (commandName === 'track') {
                await interaction.deferReply();
                const address = interaction.options.getString('address', true);
                const entryPrice = interaction.options.getNumber('entry_price', true);
                const trailingStop = interaction.options.getNumber('trailing_stop') || 15.0;

                const pair = await DexScreenerService.getPairByAddress(address);
                const symbol = pair ? pair.baseToken.symbol : 'TOKEN';
                const chain = pair ? pair.chainId : 'unknown';

                await GainTrackerService.addPosition(symbol, chain, address, entryPrice, trailingStop);
                await interaction.editReply(`Now tracking **${symbol}** (${chain})\nEntry: $${entryPrice} | Trailing Stop: ${trailingStop}% drop from peak.`);

            } else if (commandName === 'swap') {
                await interaction.deferReply();
                const mint = interaction.options.getString('mint', true);
                const amountSol = interaction.options.getNumber('amount_sol') || 0.1;

                const sim = await JupiterService.simulateSwap(mint, amountSol);
                if (sim.success) {
                    await interaction.editReply(`**Jupiter Swap Route Simulation**\n${sim.summary}\nPrice Impact: **${sim.priceImpactPct.toFixed(2)}%** | Estimated Base Fee: **${sim.estimatedFeeSol} SOL**`);
                } else {
                    await interaction.editReply(`Simulation failed: ${sim.summary}`);
                }

            } else if (commandName === 'market') {
                await interaction.deferReply();
                const macro = await MacroMarketService.getSnapshot();
                const embed = DiscordEmbedFactory.createMacroEmbed(macro);
                await interaction.editReply({ embeds: [embed] });

            } else if (commandName === 'radar') {
                await interaction.deferReply();
                const stats = await MemoryService.getGlobalStats();
                await interaction.editReply(`**Radar Memory Database**\n- Total Scanned Tokens: **${stats.totalScanned}**\n- Verified Gems: **${stats.gems}**\n- Scams Blocked: **${stats.scams}**`);

            } else if (commandName === 'mm') {
                const action = interaction.options.getString('action') || 'status';

                if (action === 'start') {
                    this.mmEngine.start();
                    await interaction.reply('Started Binance Market Maker Engine.');
                } else if (action === 'stop') {
                    this.mmEngine.stop();
                    await interaction.reply('Stopped Binance Market Maker Engine.');
                } else {
                    const status = this.mmEngine.getStatus();
                    await interaction.reply(`**Binance MM Status [${status.symbol}]**\n- Active: **${status.isRunning ? 'YES' : 'NO'}**\n- Cycles Completed: **${status.cycleCount}**\n- Current Mid: **$${status.lastMidPrice.toFixed(2)}**\n- Depth Imbalance: **${(status.lastImbalance * 100).toFixed(2)}%**\n- Volatility (Respiro): **${(status.volatilityRespiro * 100).toFixed(4)}%**\n- Sigma Realized: **${(status.sigmaRealized * 100).toFixed(4)}%**\n- Order Size: **$${status.currentOrderSize.toFixed(2)}**\n- Edge: **${status.edgeProb !== undefined ? (status.edgeProb * 100).toFixed(1) + '%' : 'N/A'}**\n- Should Trade: **${status.shouldTrade}**`);
                }

            } else if (commandName === 'gains') {
                await interaction.deferReply();
                const positions = await GainTrackerService.getActivePositions();
                if (positions.length === 0) {
                    await interaction.editReply('No active positions currently tracked.');
                    return;
                }

                const list = positions.map(p => `- **${p.symbol}** (${p.chain}): Entry $${p.entryPrice} | Current $${p.currentPrice} | PnL: **${p.currentGainPct >= 0 ? '+' : ''}${p.currentGainPct.toFixed(1)}%** (Peak: +${p.highestGainPct.toFixed(1)}%)`).join('\n');
                await interaction.editReply(`**Active Tracked Positions:**\n${list}`);
            } else if (commandName === 'compound') {
                await interaction.deferReply();
                const stats = this.compoundService.getStats();
                const edge = this.mmEngine.getEdgeSummary();
                const status = this.mmEngine.getStatus();
                await interaction.editReply(
                    `**Compound Capital Stats:**\n` +
                    `- Base Capital: $${stats.baseCapital.toFixed(2)}\n` +
                    `- Current Capital: $${stats.currentCapital.toFixed(2)}\n` +
                    `- Total Profit: $${stats.totalProfitUsd.toFixed(4)} (${stats.growthPct.toFixed(2)}%)\n` +
                    `- Peak Capital: $${stats.peakCapital.toFixed(2)}\n` +
                    `- Drawdown: ${stats.drawdownPct.toFixed(2)}%\n` +
                    `- Reinvested: $${stats.reinvested.toFixed(4)}\n` +
                    `- Protected Reserve: $${stats.protectedReserve.toFixed(4)}\n` +
                    `- Halted: ${stats.halted ? 'YES' : 'NO'}\n` +
                    `- Order Size: $${status.currentOrderSize.toFixed(2)}\n` +
                    `- Edge: ${edge}\n` +
                    `- Should Trade: ${status.shouldTrade}`
                );
            }
        } catch (error: any) {
            logger.error(`Error executing /${commandName}: ${error.message}`);
            if (interaction.deferred) {
                await interaction.editReply(`Error executing command: ${error.message}`);
            } else if (!interaction.replied) {
                await interaction.reply({ content: `Error: ${error.message}`, ephemeral: true });
            }
        }
    }

    /**
     * Handle button clicks on alert embeds
     */
    private async handleButtonInteraction(interaction: ButtonInteraction) {
        const { customId } = interaction;

        try {
            if (customId.startsWith('track_')) {
                const parts = customId.split('_');
                const address = parts[1];
                const symbol = parts[2] || 'TOKEN';

                const pair = await DexScreenerService.getPairByAddress(address);
                const currentPrice = pair ? parseFloat(pair.priceUsd) : 0;

                await GainTrackerService.addPosition(symbol, pair?.chainId || 'solana', address, currentPrice, 15.0);
                await interaction.reply({ content: `Started tracking **${symbol}** with 15% trailing stop at entry $${currentPrice}.`, ephemeral: true });

            } else if (customId.startsWith('swap_')) {
                const parts = customId.split('_');
                const mint = parts[1];
                const symbol = parts[2] || 'TOKEN';

                await interaction.deferReply({ ephemeral: true });
                const sim = await JupiterService.simulateSwap(mint, 0.1);

                if (sim.success) {
                    await interaction.editReply(`**Swap Simulation for ${symbol}**\n${sim.summary}\nPrice Impact: ${sim.priceImpactPct.toFixed(2)}%`);
                } else {
                    await interaction.editReply(`Simulation unavailable for ${symbol}: ${sim.summary}`);
                }
            }
        } catch (error: any) {
            logger.error(`Button interaction error: ${error.message}`);
            if (!interaction.replied) {
                await interaction.reply({ content: `Action failed: ${error.message}`, ephemeral: true });
            }
        }
    }

    /**
     * Automated background radar loop for newly listed and trending tokens
     */
    private startAutomatedRadar() {
        if (this.isRadarRunning) return;
        this.isRadarRunning = true;

        logger.info(`Starting Automated DexScreener Radar (Interval: ${env.POLL_INTERVAL_MS / 1000}s)...`);

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

                    // 5. Generate and attach vector embedding
                    VectorService.attachEmbedding(
                        pair.pairAddress,
                        `${pair.baseToken.name} (${pair.baseToken.symbol}) ${pair.chainId} ${aiReport.summary}`
                    ).catch(() => {});

                    // 6. Notify Discord if verified gem candidate
                    if (aiReport.score >= 80 && !aiReport.isScam) {
                        const channelId = env.DISCORD_ALERT_CHANNEL_ID;
                        if (channelId) {
                            const channel = this.client.channels.cache.get(channelId) as TextChannel;
                            if (channel) {
                                const embed = DiscordEmbedFactory.createTokenEmbed(pair, security, aiReport);
                                const actionRow = DiscordEmbedFactory.createTokenActionRow(pair);
                                await channel.send({ embeds: [embed], components: [actionRow] });
                                logger.info(`Gem Alert Sent for ${pair.baseToken.symbol}`);
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
        }, 60000);
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
