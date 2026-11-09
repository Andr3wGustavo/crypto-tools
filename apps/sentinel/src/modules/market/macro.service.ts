import axios from 'axios';
import { logger } from '../../utils/logger';

export interface MacroMarketData {
    fearAndGreed: {
        value: number;
        classification: string;
    };
    btcPriceUsd: number;
    ethPriceUsd: number;
    timestamp: Date;
}

export class MacroMarketService {
    /**
     * Get macro market snapshot (Fear & Greed Index, Major Assets)
     */
    static async getSnapshot(): Promise<MacroMarketData> {
        let fearAndGreed = { value: 50, classification: 'Neutral' };
        let btcPriceUsd = 0;
        let ethPriceUsd = 0;

        try {
            // 1. Fetch Alternative.me Fear & Greed Index (Public free API)
            const fngRes = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 5000 }).catch(() => null);
            if (fngRes?.data?.data?.[0]) {
                fearAndGreed = {
                    value: parseInt(fngRes.data.data[0].value, 10),
                    classification: fngRes.data.data[0].value_classification
                };
            }

            // 2. Fetch BTC & ETH prices via Binance Ticker or CoinGecko
            const pricesRes = await axios.get('https://api.binance.com/api/v3/ticker/price?symbols=["BTCUSDT","ETHUSDT"]', {
                timeout: 5000
            }).catch(() => null);

            if (Array.isArray(pricesRes?.data)) {
                for (const item of pricesRes.data) {
                    if (item.symbol === 'BTCUSDT') btcPriceUsd = parseFloat(item.price);
                    if (item.symbol === 'ETHUSDT') ethPriceUsd = parseFloat(item.price);
                }
            }
        } catch (error: any) {
            logger.warn('Failed to fetch full macro market data:', { message: error.message });
        }

        return {
            fearAndGreed,
            btcPriceUsd,
            ethPriceUsd,
            timestamp: new Date()
        };
    }
}
