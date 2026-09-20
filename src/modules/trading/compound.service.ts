import { logger } from '../../utils/logger';

export class CompoundService {
    private baseCapital: number;
    private currentCapital: number;
    private reinvestmentRatio: number; // E.g. 0.5 = 50% of profits reinvested into order size

    constructor(initialCapital = 100, reinvestmentRatio = 0.5) {
        this.baseCapital = initialCapital;
        this.currentCapital = initialCapital;
        this.reinvestmentRatio = reinvestmentRatio;
    }

    /**
     * Record a realized profit and compute the new compounded order size
     */
    recordProfit(realizedProfitUsd: number, baseOrderSize: number): number {
        this.currentCapital += realizedProfitUsd;
        const totalProfit = this.currentCapital - this.baseCapital;

        if (totalProfit > 0) {
            const addedOrderAllocation = totalProfit * this.reinvestmentRatio;
            const newOrderSize = baseOrderSize + (addedOrderAllocation * 0.1); // Gradual scaling
            logger.info(`📈 Compounding applied: PnL +$${realizedProfitUsd.toFixed(4)} | New Order Size: $${newOrderSize.toFixed(2)}`);
            return newOrderSize;
        }

        return baseOrderSize;
    }

    getStats() {
        return {
            baseCapital: this.baseCapital,
            currentCapital: this.currentCapital,
            totalProfitUsd: this.currentCapital - this.baseCapital,
            growthPct: ((this.currentCapital - this.baseCapital) / this.baseCapital) * 100
        };
    }
}
