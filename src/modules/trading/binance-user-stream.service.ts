import WebSocket from 'ws';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { CompoundService } from './compound.service';

const prisma = new PrismaClient();

export interface ExecutionReportEvent {
    symbol: string;
    orderId: string;
    side: 'BUY' | 'SELL';
    orderType: string;
    orderStatus: string;
    price: number;
    quantity: number;
    executedQty: number;
    cumulativeQuoteQty: number;
    commission: number;
    commissionAsset: string;
    time: number;
}

export class BinanceUserDataStreamService {
    private ws: WebSocket | null = null;
    private listenKey = '';
    private keepAliveTimer: NodeJS.Timeout | null = null;
    private isRunning = false;
    private compoundService: CompoundService;
    private listeners: Array<(event: ExecutionReportEvent) => void> = [];

    constructor(compoundService: CompoundService) {
        this.compoundService = compoundService;
    }

    async start() {
        if (this.isRunning) return;
        if (!env.BINANCE_API_KEY) {
            logger.warn('BINANCE_API_KEY not set. Binance User Data Stream will not start.');
            return;
        }

        try {
            // 1. Create listenKey via REST API
            const res = await axios.post(
                `${env.BINANCE_BASE_URL}/api/v3/userDataStream`,
                {},
                { headers: { 'X-MBX-APIKEY': env.BINANCE_API_KEY }, timeout: 5000 }
            );

            this.listenKey = res.data.listenKey;
            logger.info('🔑 Acquired Binance UserDataStream listenKey.');

            this.isRunning = true;
            this.connectWebSocket();
            this.startKeepAlive();
        } catch (error: any) {
            logger.error(`Failed to initiate Binance User Data Stream: ${error.message}`);
        }
    }

    private connectWebSocket() {
        if (!this.isRunning || !this.listenKey) return;

        const streamUrl = `${env.BINANCE_WS_URL}/${this.listenKey}`;
        this.ws = new WebSocket(streamUrl);

        this.ws.on('open', () => {
            logger.info('⚡ Connected to Binance User Data WebSocket (Execution Reports active)');
        });

        this.ws.on('message', async (data: WebSocket.RawData) => {
            try {
                const msg = JSON.parse(data.toString());

                if (msg.e === 'executionReport') {
                    const event: ExecutionReportEvent = {
                        symbol: msg.s,
                        orderId: msg.i.toString(),
                        side: msg.S,
                        orderType: msg.o,
                        orderStatus: msg.X, // NEW, FILLED, PARTIALLY_FILLED, CANCELED
                        price: parseFloat(msg.p || msg.L || '0'),
                        quantity: parseFloat(msg.q || '0'),
                        executedQty: parseFloat(msg.z || '0'),
                        cumulativeQuoteQty: parseFloat(msg.Z || '0'),
                        commission: parseFloat(msg.n || '0'),
                        commissionAsset: msg.N || 'USDT',
                        time: msg.E
                    };

                    logger.info(`[Binance Execution] ${event.symbol} ${event.side} ${event.orderStatus} @ $${event.price} (Qty: ${event.executedQty})`);

                    // Persist filled trades to SQLite
                    if (event.orderStatus === 'FILLED') {
                        await prisma.trade.upsert({
                            where: { orderId: event.orderId },
                            update: {
                                status: 'FILLED',
                                price: event.price,
                                quantity: event.executedQty,
                                quoteQuantity: event.cumulativeQuoteQty,
                                fee: event.commission
                            },
                            create: {
                                symbol: event.symbol,
                                orderId: event.orderId,
                                side: event.side,
                                price: event.price,
                                quantity: event.executedQty,
                                quoteQuantity: event.cumulativeQuoteQty,
                                fee: event.commission,
                                isMaker: true,
                                status: 'FILLED',
                                strategy: 'MARKET_MAKER'
                            }
                        }).catch(() => {});

                        // Compound profit tracking
                        if (event.side === 'SELL') {
                            const approxProfit = event.cumulativeQuoteQty * 0.001; // ~0.1% spread capture
                            this.compoundService.recordProfit(approxProfit, env.MM_MIN_ORDER_USD);
                        }
                    }

                    for (const listener of this.listeners) {
                        listener(event);
                    }
                }
            } catch (err: any) {
                logger.error(`Error parsing user data stream: ${err.message}`);
            }
        });

        this.ws.on('close', () => {
            logger.warn('Binance User Data Stream closed. Reconnecting in 5s...');
            if (this.isRunning) {
                setTimeout(() => this.connectWebSocket(), 5000);
            }
        });

        this.ws.on('error', (err) => {
            logger.error(`Binance User Data Stream error: ${err.message}`);
        });
    }

    private startKeepAlive() {
        // Keep listenKey alive every 30 minutes (Binance requirement)
        this.keepAliveTimer = setInterval(async () => {
            if (!this.listenKey || !this.isRunning) return;
            try {
                await axios.put(
                    `${env.BINANCE_BASE_URL}/api/v3/userDataStream?listenKey=${this.listenKey}`,
                    {},
                    { headers: { 'X-MBX-APIKEY': env.BINANCE_API_KEY }, timeout: 5000 }
                );
                logger.info('Renewed Binance UserDataStream listenKey.');
            } catch (err: any) {
                logger.warn(`Failed to renew listenKey: ${err.message}`);
            }
        }, 1000 * 60 * 30);
    }

    onExecution(callback: (event: ExecutionReportEvent) => void) {
        this.listeners.push(callback);
    }

    stop() {
        this.isRunning = false;
        if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
        if (this.ws) {
            this.ws.terminate();
            this.ws = null;
        }
    }
}
