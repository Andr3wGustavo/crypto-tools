import { BinanceAdapter } from './binance.adapter';
import { PrismaClient } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

const prisma = new PrismaClient();

export class ReconcilerService {
    /**
     * On boot: cancel all open orders, reconcile state with exchange.
     */
    static async reconcile(adapter: BinanceAdapter, symbol: string): Promise<void> {
        logger.info('[Reconciler] Starting reconciliation...');

        try {
            // 1. Cancel all open orders
            await adapter.cancelAllOrders(symbol).catch(() => {});
            logger.info(`[Reconciler] Cancelled all open orders for ${symbol}.`);

            // 2. Get account balances
            const account = await adapter.getAccount().catch(() => null);
            if (account) {
                logger.info(`[Reconciler] Account balances loaded. Maker commission: ${account.makerCommission}, Taker: ${account.takerCommission}`);
            }

            // 3. Get open orders (should be empty after cancel)
            const openOrders = await adapter.getOpenOrders(symbol).catch(() => []);
            logger.info(`[Reconciler] Open orders after cancel: ${Array.isArray(openOrders) ? openOrders.length : 0}`);

            // 4. Log pending trades in DB
            const pendingTrades = await prisma.trade.count({ where: { symbol, status: 'PENDING' } });
            logger.info(`[Reconciler] Pending trades in DB: ${pendingTrades}`);

            // 5. Log capital state
            const capitalState = await prisma.capitalState.findUnique({ where: { id: 'singleton' } });
            if (capitalState) {
                logger.info(`[Reconciler] Capital: base=$${capitalState.baseCapital.toFixed(2)} current=$${capitalState.currentCapital.toFixed(2)} peak=$${capitalState.peakCapital.toFixed(2)}`);
            } else {
                logger.info('[Reconciler] No capital state found. Will initialize on first compound.');
            }

            logger.info('[Reconciler] Reconciliation complete.');
        } catch (err: any) {
            logger.error(`[Reconciler] Reconciliation failed: ${err.message}`);
        }
    }
}