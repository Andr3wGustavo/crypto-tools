import { PrismaClient } from '@prisma/client';
import { logger } from '../../utils/logger';

const prisma = new PrismaClient();

export interface FillRecord {
    symbol: string;
    orderId: string;
    side: 'BUY' | 'SELL';
    price: number;
    quantity: number;
    quoteQuantity: number;
    fee: number;
    feeAsset: string;
    isMaker: boolean;
    strategy: string;
    cycleId?: string;
}

export class FillLedgerService {
    /**
     * Record a fill from the user data stream with full details.
     */
    static async recordFill(fill: FillRecord): Promise<void> {
        try {
            await prisma.trade.upsert({
                where: { orderId: fill.orderId },
                update: {
                    price: fill.price,
                    quantity: fill.quantity,
                    quoteQuantity: fill.quoteQuantity,
                    fee: fill.fee,
                    status: 'FILLED'
                },
                create: {
                    symbol: fill.symbol,
                    orderId: fill.orderId,
                    side: fill.side,
                    price: fill.price,
                    quantity: fill.quantity,
                    quoteQuantity: fill.quoteQuantity,
                    fee: fill.fee,
                    isMaker: fill.isMaker,
                    status: 'FILLED',
                    strategy: fill.strategy
                }
            });
            logger.info(`[FillLedger] ${fill.side} ${fill.symbol} @ ${fill.price} qty=${fill.quantity} fee=${fill.fee} ${fill.feeAsset}`);
        } catch (err: any) {
            logger.error(`[FillLedger] Failed to record fill: ${err.message}`);
        }
    }

    /**
     * Compute realized PnL for a completed round-trip (buy + sell).
     * Returns PnL in quote currency and in bps.
     */
    static computeRoundTripPnL(
        buyPrice: number,
        sellPrice: number,
        quantity: number,
        buyFee: number,
        sellFee: number
    ): { pnlQuote: number; pnlBps: number } {
        const buyCost = buyPrice * quantity + buyFee;
        const sellProceeds = sellPrice * quantity - sellFee;
        const pnlQuote = sellProceeds - buyCost;
        const midPrice = (buyPrice + sellPrice) / 2;
        const pnlBps = midPrice > 0 ? (pnlQuote / (midPrice * quantity)) * 10000 : 0;
        return { pnlQuote, pnlBps };
    }

    /**
     * Get recent fills for edge estimation.
     */
    static async getRecentFills(symbol: string, limit = 100): Promise<any[]> {
        try {
            return await prisma.trade.findMany({
                where: { symbol, status: 'FILLED' },
                orderBy: { createdAt: 'desc' },
                take: limit
            });
        } catch (err: any) {
            logger.error(`[FillLedger] Failed to fetch fills: ${err.message}`);
            return [];
        }
    }

    /**
     * Get aggregate stats for a symbol.
     */
    static async getStats(symbol: string): Promise<{ totalFills: number; totalPnL: number; avgPnLBps: number }> {
        try {
            const fills = await prisma.trade.findMany({ where: { symbol, status: 'FILLED' } });
            // Pair buys and sells
            const buys = fills.filter(f => f.side === 'BUY');
            const sells = fills.filter(f => f.side === 'SELL');
            const pairs = Math.min(buys.length, sells.length);
            let totalPnL = 0;
            let totalBps = 0;
            for (let i = 0; i < pairs; i++) {
                const b = buys[i];
                const s = sells[i];
                const { pnlQuote, pnlBps } = this.computeRoundTripPnL(
                    b.price, s.price, Math.min(b.quantity, s.quantity), b.fee, s.fee
                );
                totalPnL += pnlQuote;
                totalBps += pnlBps;
            }
            return {
                totalFills: fills.length,
                totalPnL,
                avgPnLBps: pairs > 0 ? totalBps / pairs : 0
            };
        } catch (err: any) {
            logger.error(`[FillLedger] Failed to get stats: ${err.message}`);
            return { totalFills: 0, totalPnL: 0, avgPnLBps: 0 };
        }
    }
}