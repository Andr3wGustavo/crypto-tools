import WebSocket from 'ws';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

export interface BookTickerUpdate {
    symbol: string;
    bidPrice: number;
    bidQty: number;
    askPrice: number;
    askQty: number;
    midPrice: number;
    imbalance: number; // -1 to +1
    updatedAt: number;
}

export class BinanceWebSocketService {
    private ws: WebSocket | null = null;
    private symbol: string;
    private isRunning = false;
    private lastTicker: BookTickerUpdate | null = null;
    private listeners: Array<(ticker: BookTickerUpdate) => void> = [];

    constructor(symbol = env.MM_SYMBOL) {
        this.symbol = symbol.toLowerCase();
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.connect();
    }

    private connect() {
        if (!this.isRunning) return;

        const wsBase = env.BINANCE_TESTNET ? env.BINANCE_TESTNET_WS_URL : env.BINANCE_WS_URL;
        const streamUrl = `${wsBase}/${this.symbol}@bookTicker`;
        this.ws = new WebSocket(streamUrl);

        this.ws.on('open', () => {
            logger.info(`⚡ Binance WebSocket connected for ${this.symbol.toUpperCase()}@bookTicker`);
        });

        this.ws.on('message', (data: WebSocket.RawData) => {
            try {
                const msg = JSON.parse(data.toString());
                const bidPrice = parseFloat(msg.b);
                const bidQty = parseFloat(msg.B);
                const askPrice = parseFloat(msg.a);
                const askQty = parseFloat(msg.A);
                const midPrice = (bidPrice + askPrice) / 2;

                // Simple imbalance: (BidQty - AskQty) / (BidQty + AskQty)
                const totalQty = bidQty + askQty;
                const imbalance = totalQty > 0 ? (bidQty - askQty) / totalQty : 0;

                const ticker: BookTickerUpdate = {
                    symbol: msg.s,
                    bidPrice,
                    bidQty,
                    askPrice,
                    askQty,
                    midPrice,
                    imbalance,
                    updatedAt: Date.now()
                };

                this.lastTicker = ticker;
                for (const listener of this.listeners) {
                    listener(ticker);
                }
            } catch (err: any) {
                logger.error(`Error parsing WebSocket message: ${err.message}`);
            }
        });

        this.ws.on('close', () => {
            logger.warn('Binance WebSocket disconnected. Reconnecting in 3s...');
            if (this.isRunning) {
                setTimeout(() => this.connect(), 3000);
            }
        });

        this.ws.on('error', (err) => {
            logger.error(`Binance WebSocket error: ${err.message}`);
        });
    }

    onTicker(callback: (ticker: BookTickerUpdate) => void) {
        this.listeners.push(callback);
    }

    getLatestTicker(): BookTickerUpdate | null {
        return this.lastTicker;
    }

    stop() {
        this.isRunning = false;
        if (this.ws) {
            this.ws.terminate();
            this.ws = null;
        }
    }
}
