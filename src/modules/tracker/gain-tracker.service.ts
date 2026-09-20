import { PrismaClient } from '@prisma/client';
import { DexScreenerService } from '../scout/dexscreener.service';
import { logger } from '../../utils/logger';

const prisma = new PrismaClient();

export interface PositionAlert {
    type: 'TAKE_PROFIT' | 'TRAILING_STOP' | 'UPDATE';
    positionId: string;
    symbol: string;
    gainPct: number;
    currentPrice: number;
    message: string;
}

export class GainTrackerService {
    /**
     * Add a new position to track
     */
    static async addPosition(symbol: string, chain: string, tokenAddress: string, entryPrice: number, trailingStopPct = 15.0) {
        return await prisma.position.create({
            data: {
                symbol: symbol.toUpperCase(),
                chain: chain.toLowerCase(),
                tokenAddress,
                entryPrice,
                currentPrice: entryPrice,
                peakPrice: entryPrice,
                currentGainPct: 0,
                highestGainPct: 0,
                trailingStopPct,
                status: 'ACTIVE'
            }
        });
    }

    /**
     * Scan all active positions and evaluate Take-Profit & Trailing Stop triggers
     */
    static async evaluatePositions(): Promise<PositionAlert[]> {
        const alerts: PositionAlert[] = [];

        try {
            const activePositions = await prisma.position.findMany({
                where: { status: 'ACTIVE' }
            });

            for (const pos of activePositions) {
                const pair = await DexScreenerService.getPairByAddress(pos.tokenAddress);
                if (!pair || !pair.priceUsd) continue;

                const currentPrice = parseFloat(pair.priceUsd);
                const gainPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
                let peakPrice = Math.max(pos.peakPrice, currentPrice);
                let highestGainPct = Math.max(pos.highestGainPct, gainPct);

                // Check Trailing Stop Drop from Peak
                const dropFromPeakPct = ((peakPrice - currentPrice) / peakPrice) * 100;

                let status = pos.status;
                if (highestGainPct > 20 && dropFromPeakPct >= pos.trailingStopPct) {
                    status = 'STOPPED_OUT';
                    alerts.push({
                        type: 'TRAILING_STOP',
                        positionId: pos.id,
                        symbol: pos.symbol,
                        gainPct,
                        currentPrice,
                        message: `🛑 TRAILING STOP TRIGGERED for ${pos.symbol}! Dropped ${dropFromPeakPct.toFixed(1)}% from peak. Locked PnL: ${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(1)}%`
                    });
                } else if (gainPct >= 100 && pos.highestGainPct < 100) {
                    alerts.push({
                        type: 'TAKE_PROFIT',
                        positionId: pos.id,
                        symbol: pos.symbol,
                        gainPct,
                        currentPrice,
                        message: `🎯 2X MILESTONE! ${pos.symbol} reached +${gainPct.toFixed(1)}%! Consider securing initial investment.`
                    });
                }

                // Update position in database
                await prisma.position.update({
                    where: { id: pos.id },
                    data: {
                        currentPrice,
                        peakPrice,
                        currentGainPct: gainPct,
                        highestGainPct,
                        status
                    }
                });
            }
        } catch (error: any) {
            logger.error(`Error in GainTracker evaluation: ${error.message}`);
        }

        return alerts;
    }

    static async getActivePositions() {
        return await prisma.position.findMany({ where: { status: 'ACTIVE' } });
    }
}
