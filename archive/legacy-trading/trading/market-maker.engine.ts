import { BinanceAdapter } from './binance.adapter';
import { BinanceWebSocketService, BookTickerUpdate } from './binance-ws.service';
import { ExchangeInfoService, SymbolFilterRules } from './exchange-info.service';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { FillLedgerService } from './fill-ledger.service';
import { EdgeEstimatorService } from './edge-estimator.service';

export interface PendingCycle {
    buyOrderId: string | null;
    sellOrderId: string | null;
    buyPrice: number;
    sellPrice: number;
    quantity: number;
    buyFilledQty: number;
    sellFilledQty: number;
    buyCost: number;
    sellProceeds: number;
    buyFee: number;
    sellFee: number;
    buyDone: boolean;
    sellDone: boolean;
    realized: boolean;
    createdAt: number;
}

export class MarketMakerEngine {
    private adapter: BinanceAdapter;
    private wsService: BinanceWebSocketService;
    private symbol: string;
    private filterRules: SymbolFilterRules | null = null;
    private isRunning = false;

    // Quantitative State
    private midHistory: number[] = [];
    private maxHistoryLength = 50;
    private cycleCount = 0;
    private activeCycleMid = 0;

    // Compound integration
    private currentOrderSize: number = env.MM_MIN_ORDER_USD;
    private pendingCycle: PendingCycle | null = null;

    // Avellaneda-Stoikov params
    private gamma = 0.1;          // risk aversion
    private k = 1.5;              // order book depth decay
    private A = 1.0;              // fill intensity base
    private T = 1;                // time horizon (normalized)
    private inventory = 0;        // current inventory (base asset)
    private inventoryTarget = env.MM_INVENTORY_TARGET;

    // Volatility targeting
    private sigmaTarget = 0.003;  // 0.3% per cycle
    private sigmaRealized = 0.001;
    private ewmaLambda = 0.94;

    // Edge estimator
    private edgeEstimator: EdgeEstimatorService;

    constructor(symbol = env.MM_SYMBOL) {
        this.symbol = symbol.toUpperCase();
        this.adapter = new BinanceAdapter();
        this.wsService = new BinanceWebSocketService(this.symbol);
        this.edgeEstimator = new EdgeEstimatorService(0, 1, 1, 100, 0.95);
    }

    async init() {
        this.filterRules = await ExchangeInfoService.getSymbolFilters(this.symbol);
        logger.info(`[MM] Initialized ${this.symbol}: Tick=${this.filterRules.tickSize}, Step=${this.filterRules.stepSize}, MinNotional=${this.filterRules.minNotional}`);
    }

    async start() {
        if (this.isRunning) return;
        if (!env.BINANCE_API_KEY || !env.BINANCE_SECRET) {
            logger.warn('[MM] Binance API Key or Secret not configured. Market Maker in read-only mode.');
            return;
        }
        await this.init();
        this.isRunning = true;
        this.wsService.start();
        this.runLoop();
    }

    private updateMidHistory(mid: number) {
        this.midHistory.push(mid);
        if (this.midHistory.length > this.maxHistoryLength) {
            this.midHistory.shift();
        }
        // Update EWMA volatility
        if (this.midHistory.length >= 2) {
            const lastMid = this.midHistory[this.midHistory.length - 2];
            const ret = (mid - lastMid) / lastMid;
            this.sigmaRealized = Math.sqrt(this.ewmaLambda * this.sigmaRealized * this.sigmaRealized + (1 - this.ewmaLambda) * ret * ret);
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

    private formatPrice(price: number): string {
        return ExchangeInfoService.formatPrice(price, this.filterRules!);
    }

    private formatQty(qty: number): string {
        return ExchangeInfoService.formatQuantity(qty, this.filterRules!);
    }

    async stop() {
        this.isRunning = false;
        this.wsService.stop();
        await this.adapter.cancelAllOrders(this.symbol).catch(() => {});
        logger.info('[MM] Market Maker engine stopped.');
    }

    setOrderSize(size: number) {
        this.currentOrderSize = Math.min(Math.max(size, env.MM_MIN_ORDER_USD), env.MM_MAX_ORDER_USD);
        logger.info(`[MM] Order size updated: $${this.currentOrderSize.toFixed(2)}`);
    }

    getCurrentOrderSize(): number {
        return this.currentOrderSize;
    }

    getPendingCycle(): PendingCycle | null {
        return this.pendingCycle;
    }

    clearPendingCycle() {
        this.pendingCycle = null;
    }

    updateEdge(pnlBps: number) {
        this.edgeEstimator.update(pnlBps);
    }

    getEdgeSummary(): string {
        return this.edgeEstimator.getSummary();
    }

    getStatus() {
        const ticker = this.wsService.getLatestTicker();
        return {
            symbol: this.symbol,
            isRunning: this.isRunning,
            cycleCount: this.cycleCount,
            lastMidPrice: ticker?.midPrice || 0,
            lastImbalance: ticker?.imbalance || 0,
            volatilityRespiro: this.calculateRespiro(),
            sigmaRealized: this.sigmaRealized,
            currentOrderSize: this.currentOrderSize,
            edgeProb: this.edgeEstimator.getProbPositiveEdge(),
            shouldTrade: this.edgeEstimator.shouldTrade()
        };
    }

    private async runLoop() {
        logger.info(`[MM] Starting Adaptive MM Engine on ${this.symbol}...`);

        while (this.isRunning) {
            try {
                const ticker = this.wsService.getLatestTicker();
                if (!ticker) {
                    await new Promise(r => setTimeout(r, 500));
                    continue;
                }

                this.updateMidHistory(ticker.midPrice);
                const respiro = this.calculateRespiro();

                // Discard stale pending cycle
                if (this.pendingCycle && !this.pendingCycle.realized) {
                    if (this.pendingCycle.buyDone && this.pendingCycle.sellDone && this.pendingCycle.buyFilledQty > 0 && this.pendingCycle.sellFilledQty > 0) {
                        // Compute PnL and record
                        const { pnlQuote, pnlBps } = FillLedgerService.computeRoundTripPnL(
                            this.pendingCycle.buyPrice, this.pendingCycle.sellPrice,
                            Math.min(this.pendingCycle.buyFilledQty, this.pendingCycle.sellFilledQty),
                            this.pendingCycle.buyFee, this.pendingCycle.sellFee
                        );
                        logger.info(`[MM] Stale cycle realized: PnL=$${pnlQuote.toFixed(4)} (${pnlBps.toFixed(2)} bps)`);
                        this.edgeEstimator.update(pnlBps);
                    }
                    this.pendingCycle = null;
                }

                // Avellaneda-Stoikov reservation price
                const q = this.inventory - this.inventoryTarget; // inventory deviation
                const sigma = this.sigmaRealized > 0 ? this.sigmaRealized : 0.001;
                const t = 0.5; // mid-horizon
                const reservationPrice = ticker.midPrice * (1 - q * this.gamma * sigma * sigma * t);

                // Optimal spread
                const spreadAS = this.gamma * sigma * sigma * t + (2 / this.gamma) * Math.log(1 + this.gamma / this.k);
                // Cost per fill (fee + estimated adverse selection)
                const fee = 0.0002; // maker fee
                const adverseSelection = 0.0001; // estimated
                const cost = 2 * fee + adverseSelection;
                // Optimal spread with cost
                const deltaStar = cost + 1 / this.k;
                const targetSpread = Math.max(cost, spreadAS, deltaStar);

                // Volatility gate
                if (respiro < fee && this.midHistory.length >= 10) {
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }

                // Edge gate: only trade if P(mu > 0) > 0.95
                if (this.edgeEstimator.getN() >= 5 && !this.edgeEstimator.shouldTrade()) {
                    logger.debug(`[MM] Edge gate: ${this.edgeEstimator.getSummary()}`);
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }

                // Vol-targeted sizing
                const volRatio = this.sigmaTarget / (this.sigmaRealized > 0 ? this.sigmaRealized : this.sigmaTarget);
                const volAdjustedSize = this.currentOrderSize * Math.min(volRatio, 2.0); // cap vol ratio at 2x
                const rawQty = volAdjustedSize / reservationPrice;
                const quantity = this.formatQty(rawQty);

                // Prices
                const halfSpread = targetSpread / 2;
                const rawBuyPrice = reservationPrice * (1 - halfSpread);
                const rawSellPrice = reservationPrice * (1 + halfSpread);
                const buyPrice = this.formatPrice(rawBuyPrice);
                const sellPrice = this.formatPrice(rawSellPrice);

                this.cycleCount++;
                logger.info(`[MM Cycle #${this.cycleCount}] Mid=$${ticker.midPrice.toFixed(2)} Res=$${reservationPrice.toFixed(2)} Spread=${(targetSpread * 100).toFixed(4)}% Buy=$${buyPrice} Sell=$${sellPrice} Size=$${volAdjustedSize.toFixed(2)} Qty=${quantity} Respiro=${(respiro * 100).toFixed(4)}% Imb=${(ticker.imbalance * 100).toFixed(2)}% Inv=${this.inventory.toFixed(4)} Edge=${this.edgeEstimator.getSummary()}`);

                // Cancel lingering orders and post new
                await this.adapter.cancelAllOrders(this.symbol).catch(() => {});

                const [buyOrder, sellOrder] = await Promise.allSettled([
                    this.adapter.placeLimitMaker(this.symbol, 'BUY', quantity, buyPrice),
                    this.adapter.placeLimitMaker(this.symbol, 'SELL', quantity, sellPrice)
                ]);

                const buyRes: any = buyOrder.status === 'fulfilled' ? buyOrder.value : null;
                const sellRes: any = sellOrder.status === 'fulfilled' ? sellOrder.value : null;

                this.pendingCycle = {
                    buyOrderId: buyRes?.orderId != null ? String(buyRes.orderId) : null,
                    sellOrderId: sellRes?.orderId != null ? String(sellRes.orderId) : null,
                    buyPrice: parseFloat(buyPrice),
                    sellPrice: parseFloat(sellPrice),
                    quantity: parseFloat(quantity),
                    buyFilledQty: 0,
                    sellFilledQty: 0,
                    buyCost: 0,
                    sellProceeds: 0,
                    buyFee: 0,
                    sellFee: 0,
                    buyDone: false,
                    sellDone: false,
                    realized: false,
                    createdAt: Date.now()
                };

                this.activeCycleMid = reservationPrice;

                // TTL & drift monitoring
                let dynamicTTL = Math.floor(respiro * 50 * 1000);
                if (dynamicTTL < 3000) dynamicTTL = 3000;
                if (dynamicTTL > 10000) dynamicTTL = 10000;

                const startTime = Date.now();
                while (Date.now() - startTime < dynamicTTL) {
                    await new Promise(r => setTimeout(r, 250));
                    const currentTicker = this.wsService.getLatestTicker();
                    if (currentTicker) {
                        const drift = Math.abs((currentTicker.midPrice - this.activeCycleMid) / (this.activeCycleMid || 1));
                        if (drift > env.MM_DRIFT_THRESHOLD) {
                            logger.warn(`[MM] Drift triggered (${(drift * 100).toFixed(3)}% > ${(env.MM_DRIFT_THRESHOLD * 100).toFixed(2)}%). Cancelling.`);
                            break;
                        }
                    }
                }

                await this.adapter.cancelAllOrders(this.symbol).catch(() => {});
                await new Promise(r => setTimeout(r, 500));

            } catch (error: any) {
                logger.error(`[MM] Loop Exception: ${error.message}`);
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }
}