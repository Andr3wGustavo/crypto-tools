import axios from 'axios';
import { logger } from '../../utils/logger';

export interface DexPair {
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
        address: string;
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
    info?: {
        imageUrl?: string;
        websites?: Array<{ label: string; url: string }>;
        socials?: Array<{ type: string; url: string }>;
    };
}

export interface TokenProfileItem {
    url: string;
    chainId: string;
    tokenAddress: string;
    icon?: string;
    header?: string;
    description?: string;
    links?: Array<{ type: string; label?: string; url: string }>;
}

export class DexScreenerService {
    private static BASE_URL = 'https://api.dexscreener.com';

    /**
     * Fetch latest active tokens from DexScreener token profiles and boosts
     */
    static async getLatestCandidates(): Promise<DexPair[]> {
        const candidateAddresses = new Set<string>();
        const pairsMap = new Map<string, DexPair>();

        try {
            // 1. Fetch latest token profiles (tokens with fresh verified metadata)
            const profilesRes = await axios.get<TokenProfileItem[]>(`${this.BASE_URL}/token-profiles/latest/v1`, {
                timeout: 8000
            }).catch(() => ({ data: [] }));

            if (Array.isArray(profilesRes.data)) {
                for (const item of profilesRes.data.slice(0, 30)) {
                    if (item.tokenAddress) candidateAddresses.add(item.tokenAddress);
                }
            }

            // 2. Fetch latest boosted tokens (active community and marketing)
            const boostsRes = await axios.get<any[]>(`${this.BASE_URL}/token-boosts/latest/v1`, {
                timeout: 8000
            }).catch(() => ({ data: [] }));

            if (Array.isArray(boostsRes.data)) {
                for (const item of boostsRes.data.slice(0, 30)) {
                    if (item.tokenAddress) candidateAddresses.add(item.tokenAddress);
                }
            }

            // 3. Batch query pairs for candidate addresses (max 30 addresses per call)
            const addressList = Array.from(candidateAddresses).slice(0, 30);
            if (addressList.length > 0) {
                const pairsBatchRes = await axios.get<{ pairs: DexPair[] }>(
                    `${this.BASE_URL}/latest/dex/tokens/${addressList.join(',')}`,
                    { timeout: 10000 }
                ).catch(() => ({ data: { pairs: [] } }));

                if (pairsBatchRes.data?.pairs) {
                    for (const pair of pairsBatchRes.data.pairs) {
                        if (pair && pair.pairAddress) {
                            pairsMap.set(pair.pairAddress, pair);
                        }
                    }
                }
            }

            // 4. Fallback/Augment with trending searches across popular chains if batch is small
            if (pairsMap.size < 10) {
                const popularChains = ['solana', 'base', 'ethereum', 'bsc'];
                for (const chain of popularChains) {
                    const searchRes = await axios.get<{ pairs: DexPair[] }>(
                        `${this.BASE_URL}/latest/dex/search?q=${chain}`,
                        { timeout: 8000 }
                    ).catch(() => ({ data: { pairs: [] } }));

                    if (searchRes.data?.pairs) {
                        for (const p of searchRes.data.pairs.slice(0, 10)) {
                            if (p && p.pairAddress && !pairsMap.has(p.pairAddress)) {
                                pairsMap.set(p.pairAddress, p);
                            }
                        }
                    }
                }
            }

            return Array.from(pairsMap.values());
        } catch (error: any) {
            logger.error('DexScreener API Fetch Error:', { message: error.message });
            return [];
        }
    }

    /**
     * Lookup a specific token or pair by contract address
     */
    static async getPairByAddress(address: string): Promise<DexPair | null> {
        try {
            // First attempt: check direct token pools
            const tokenRes = await axios.get<{ pairs: DexPair[] }>(`${this.BASE_URL}/latest/dex/tokens/${address}`, {
                timeout: 6000
            });
            if (tokenRes.data?.pairs && tokenRes.data.pairs.length > 0) {
                // Return the pool with highest liquidity
                return tokenRes.data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
            }

            // Second attempt: search endpoint
            const searchRes = await axios.get<{ pairs: DexPair[] }>(`${this.BASE_URL}/latest/dex/search?q=${address}`, {
                timeout: 6000
            });
            if (searchRes.data?.pairs && searchRes.data.pairs.length > 0) {
                return searchRes.data.pairs[0];
            }

            return null;
        } catch (error: any) {
            logger.error(`Error resolving pair for ${address}:`, { message: error.message });
            return null;
        }
    }
}
