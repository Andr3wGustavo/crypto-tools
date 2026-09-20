import axios from 'axios';
import { logger } from '../utils/logger';

export interface DexToken {
    chainId: string;
    dexId: string;
    url: string;
    pairAddress: string;
    baseToken: {
        address: string;
        name: string;
        symbol: string;
    };
    quoteToken: {
        symbol: string;
    };
    priceNative: string;
    priceUsd: string;
    txns: {
        m5: { buys: number; sells: number };
        h1: { buys: number; sells: number };
        h6: { buys: number; sells: number };
        h24: { buys: number; sells: number };
    };
    volume: {
        h24: number;
        h6: number;
        h1: number;
        m5: number;
    };
    priceChange: {
        m5: number;
        h1: number;
        h6: number;
        h24: number;
    };
    liquidity: {
        usd: number;
        base: number;
        quote: number;
    };
    fdv: number;
    pairCreatedAt: number;
}

export class DexScreenerService {
    private static BASE_URL = 'https://api.dexscreener.com/latest/dex';

    static async getLatestPairs(): Promise<DexToken[]> {
        try {
            // DexScreener doesn't have a direct "new pairs" endpoint in the public free API that is always reliable for "just launched"
            // But we can query specific chains or search.
            // For this implementation, we will use the 'search' or specific chain endpoints if available.
            // However, a common strategy is to poll for recent tokens.
            // Let's assume we want to watch specific chains or just get trending/latest.
            // The /latest/dex/tokens/ endpoint might be useful if we had addresses.
            // Actually, DexScreener has a /latest/dex/search/?q= endpoint.

            // Strategy: Fetch trending or specific chain new pairs. 
            // Since the public API is limited, we might simulate "new" by checking trending and filtering by age.
            // OR we can use the /latest/dex/pairs/{chainId}/{pairAddresses} if we had them.

            // For now, let's use a broad search or trending to simulate the feed.
            // NOTE: Real "sniper" bots often use blockchain nodes directly. This is a "screener" bot.

            const response = await axios.get(`https://api.dexscreener.com/token-profiles/latest/v1`);
            // Wait, the documentation says: https://docs.dexscreener.com/api/reference/token-profiles/get-latest-token-profiles
            // This returns profiles, not necessarily market data.

            // Let's try the standard search for "solana" or "ethereum" to get a list, then filter.
            // Or better, use the `https://api.dexscreener.com/latest/dex/search?q=WETH` (example)

            // CORRECT APPROACH for "New Pairs" via API (without paid tier) is tricky.
            // We will use: https://api.dexscreener.com/latest/dex/search?q=pair-age:24h 
            // (Hypothetically, if they supported filters in search query strings like that).

            // Let's stick to fetching trending for now as a proxy for "activity", 
            // and maybe we can find a way to get new pairs.
            // Actually, let's just search for common base tokens to find pairs? No.

            // Let's use the endpoint that gives us multiple pairs.
            // https://api.dexscreener.com/latest/dex/tokens/ (requires addresses)

            // Fallback: We will fetch "Trending" which is often what users want for "good stuff happening".
            // And we can filter by `pairCreatedAt`.

            // Note: The user asked for "new coins or good things happening".

            // Let's try to fetch a boost or trending list.
            // There isn't a documented "get all new pairs" endpoint.
            // We will simulate it by searching for a generic term or using a known strategy.
            // Let's try searching for "sol" (Solana) to get many pairs.

            const responseSearch = await axios.get(`${this.BASE_URL}/search?q=sol`);
            return responseSearch.data.pairs || [];

        } catch (error) {
            logger.error(`Error fetching from DexScreener: ${error}`);
            return [];
        }
    }

    static async getPairByAddress(address: string): Promise<DexToken | null> {
        try {
            const response = await axios.get(`${this.BASE_URL}/pairs/solana/${address}`); // Defaulting to solana for now, or we need to know chain.
            // Actually the API is /latest/dex/pairs/:chainId/:pairAddresses
            // Or /latest/dex/search?q=:q

            // If we only have address, search is best.
            const search = await axios.get(`${this.BASE_URL}/search?q=${address}`);
            if (search.data.pairs && search.data.pairs.length > 0) {
                return search.data.pairs[0];
            }
            return null;
        } catch (error) {
            logger.error(`Error fetching pair ${address}: ${error}`);
            return null;
        }
    }
}
