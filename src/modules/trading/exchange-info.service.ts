import BigNumber from 'bignumber.js';
import axios from 'axios';
import { logger } from '../../utils/logger';
import { env } from '../../config/env';

export interface SymbolFilterRules {
    tickSize: string;
    stepSize: string;
    minQty: string;
    minNotional: string;
    pricePrecision: number;
    qtyPrecision: number;
}

export class ExchangeInfoService {
    private static cache = new Map<string, SymbolFilterRules>();

    /**
     * Fetch exact symbol filters from Binance exchangeInfo
     */
    static async getSymbolFilters(symbol: string, baseUrl = env.BINANCE_TESTNET ? env.BINANCE_TESTNET_BASE_URL : 'https://api.binance.com'): Promise<SymbolFilterRules> {
        const cached = this.cache.get(symbol);
        if (cached) return cached;

        try {
            const res = await axios.get(`${baseUrl}/api/v3/exchangeInfo?symbol=${symbol.toUpperCase()}`, {
                timeout: 8000
            });
            const symbolData = res.data?.symbols?.[0];
            if (!symbolData) throw new Error(`Symbol ${symbol} not found on Binance`);

            let tickSize = '0.01';
            let stepSize = '0.00001';
            let minQty = '0.00001';
            let minNotional = '5.0';

            for (const filter of symbolData.filters) {
                if (filter.filterType === 'PRICE_FILTER') {
                    tickSize = filter.tickSize;
                }
                if (filter.filterType === 'LOT_SIZE') {
                    stepSize = filter.stepSize;
                    minQty = filter.minQty;
                }
                if (filter.filterType === 'NOTIONAL' || filter.filterType === 'MIN_NOTIONAL') {
                    minNotional = filter.minNotional || '5.0';
                }
            }

            const pricePrecision = this.getDecimalPlaces(tickSize);
            const qtyPrecision = this.getDecimalPlaces(stepSize);

            const rules: SymbolFilterRules = {
                tickSize,
                stepSize,
                minQty,
                minNotional,
                pricePrecision,
                qtyPrecision
            };

            this.cache.set(symbol, rules);
            return rules;
        } catch (error: any) {
            logger.warn(`Failed to fetch exchangeInfo for ${symbol}. Using defaults: ${error.message}`);
            return {
                tickSize: '0.01',
                stepSize: '0.00001',
                minQty: '0.00001',
                minNotional: '5.0',
                pricePrecision: 2,
                qtyPrecision: 5
            };
        }
    }

    /**
     * Format a price according to tickSize rule
     */
    static formatPrice(price: number | string, rules: SymbolFilterRules): string {
        const bnPrice = new BigNumber(price);
        const bnTick = new BigNumber(rules.tickSize);
        // Floor to multiple of tickSize
        const steps = bnPrice.dividedBy(bnTick).integerValue(BigNumber.ROUND_FLOOR);
        return steps.multipliedBy(bnTick).toFixed(rules.pricePrecision);
    }

    /**
     * Format a quantity according to stepSize rule
     */
    static formatQuantity(quantity: number | string, rules: SymbolFilterRules): string {
        const bnQty = new BigNumber(quantity);
        const bnStep = new BigNumber(rules.stepSize);
        // Floor to multiple of stepSize
        const steps = bnQty.dividedBy(bnStep).integerValue(BigNumber.ROUND_FLOOR);
        return steps.multipliedBy(bnStep).toFixed(rules.qtyPrecision);
    }

    private static getDecimalPlaces(val: string): number {
        const parts = val.split('.');
        if (parts.length < 2) return 0;
        return parts[1].replace(/0+$/, '').length || 0;
    }
}
