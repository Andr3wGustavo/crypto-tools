import { BinanceAdapter } from './binance.adapter';
import { BinanceWebSocketService, BookTickerUpdate } from './binance-ws.service';
import { ExchangeInfoService, SymbolFilterRules } from './exchange-info.service';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

export class MarketMakerEngine {
    private adapter: BinanceAdapter;
    private wsService: BinanceWebSocketService;
    private symbol: string;
    private filterRules: SymbolFilterRules | null = null;
    private isRunning = false;

    // Quantitative State
    private midHistory: number[] = [];
    private maxHistoryLength = 50;
    private startCapital = 0;
    private cycleCount = 0;
    private activeCycleMid = 0;

    constructor(symbol = env.MM_SYMBOL) {
        this.symbol = symbol.toUpperCase();
        this.adapter = new BinanceAdapter();
        this.wsService = new BinanceWebSocketService(this.symbol);
    }

    async init() {
        this.filterRules = await ExchangeInfoService.getSymbolFilters(this.symbol);
        logger.info(`Initialized MM rules for ${this.symbol}: Tick=${this.filterRules.tickSize}, Step=${this.filterRules.stepSize}`);
    }

    async start() {
        if (this.isRunning) return;
        if (!env.BINANCE_API_KEY || !env.BINANCE_SECRET) {
            logger.warn('Binance API Key or Secret not configured. Market Maker engine in dry-run/read-only mode.');
            return;
        }

        await this.init();
        this.isRunning = true;
        this.wsService.start();

        // Start execution loop
        this.runLoop();
    }

    private updateMidHistory(mid: number) {
        this.midHistory.push(mid);
        if (this.midHistory.length > this.maxHistoryLength) {
            this.midHistory.shift();
        }
    }

    private calculateRespiro(): number {
        if (this.midHistory.length < 2) return 0;
        let sum = 0;
        for (let i = 1; i < this.midHistory.length; i++) {
            sum += Math.abs(this.midHistory[i] - this.midHistory[i - 1]) / this.midHistory[i - 1];
        }
        return sum / (this.midHistory.length - 1);
    }

    private async runLoop() {
        logger.info(`🚀 Starting Adaptive MM Engine on ${this.symbol}...`);

        while (this.isRunning) {
            try {
                const ticker = this.wsService.getLatestTicker();
                if (!ticker) {
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }

                this.updateMidHistory(ticker.midPrice);
                const respiro = this.calculateRespiro();

                // 1. Calculate Target Spread
                const makerFee = 0.0002; // Standard maker tier or 0 for promo pairs
                const cost = 2 * makerFee + env.MM_SAFETY_MARGIN;
                const volatilityComponent = respiro * env.MM_ATR_MULTIPLIER;
                const imbalanceComponent = Math.abs(ticker.imbalance) * env.MM_IMBALANCE_MULTIPLIER;
                const targetSpread = Math.max(cost, volatilityComponent, imbalanceComponent);

                // 2. Inventory Skew (Avellaneda-Stoikov)
                // Assume 50/50 target inventory for neutral ping-pong
                const skew = 0; // Can be enhanced with live portfolio query
                const effectiveMid = ticker.midPrice * (1 - skew);
                this.activeCycleMid = effectiveMid;

                // 3. Volatility Gate Check
                if (respiro < makerFee && this.midHistory.length >= 10) {
                    // Volatility too low to safely capture spread
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }

                // 4. Calculate Order Prices & Sizes
                const halfSpread = targetSpread / 2;
                const rawBuyPrice = effectiveMid * (1 - halfSpread);
                const rawSellPrice = effectiveMid * (1 + halfSpread);

                const buyPrice = ExchangeInfoService.formatPrice(rawBuyPrice, this.filterRules!);
                const sellPrice = ExchangeInfoService.formatPrice(rawSellPrice, this.filterRules!);

                const rawQty = env.MM_MIN_ORDER_USD / effectiveMid;
                const quantity = ExchangeInfoService.formatQuantity(rawQty, this.filterRules!);

                this.cycleCount++;
                logger.info(`[MM Cycle #${this.cycleCount}] Mid: $${effectiveMid.toFixed(2)} | Spread: ${(targetSpread * 100).toFixed(4)}% | Buy: $${buyPrice} | Sell: $${sellPrice}`);

                // 5. Cancel any lingering orders and post new Maker orders
                await this.adapter.cancelAllOrders(this.symbol).catch(() => {});

                const [buyOrder, sellOrder] = await Promise.allSettled([
                    this.adapter.placeLimitMaker(this.symbol, 'BUY', quantity, buyPrice),
                    this.adapter.placeLimitMaker(this.symbol, 'SELL', quantity, sellPrice)
                ]);

                // 6. Monitor TTL & Drift
                let dynamicTTL = Math.floor(respiro * 50 * 1000);
                if (dynamicTTL < 3000) dynamicTTL = 3000;
                if (dynamicTTL > 10000) dynamicTTL = 10000;

                const startTime = Date.now();
                while (Date.now() - startTime < dynamicTTL) {
                    await new Promise(r => setTimeout(r, 250));
                    const currentTicker = this.wsService.getLatestTicker();
                    if (currentTicker) {
                        const drift = Math.abs((currentTicker.midPrice - this.activeCycleMid) / this.activeCycleMid);
                        if (drift > env.MM_DRIFT_THRESHOLD) {
                            logger.warn(`🚨 Drift triggered (${(drift * 100).toFixed(3)}% > ${(env.MM_DRIFT_THRESHOLD * 100).toFixed(2)}%). Cancelling orders.`);
                            break;
                        }
                    }
                }

                // Cycle end: clean orders
                await this.adapter.cancelAllOrders(this.symbol).catch(() => {});
                await new Promise(r => setTimeout(r, 500));

            } catch (error: any) {
                logger.error(`MM Loop Exception: ${error.message}`);
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }

    stop() {
        this.isRunning = false;
        this.wsService.stop();
        this.adapter.cancelAllOrders(this.symbol).catch(() => {});
        logger.info('Market Maker engine stopped.');
    }

    getStatus() {
        const ticker = this.wsService.getLatestTicker();
        return {
            symbol: this.symbol,
            isRunning: this.isRunning,
            cycleCount: this.cycleCount,
            lastMidPrice: ticker?.midPrice || 0,
            lastImbalance: ticker?.imbalance || 0,
            volatilityRespiro: this.calculateRespiro()
        };
    }
}
