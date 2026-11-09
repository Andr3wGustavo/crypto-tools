import { prisma } from '@cortex/db';
import { logger } from '../../utils/logger';


export interface HistoricalMatch {
    name: string;
    symbol: string;
    riskScore: number | null;
    isWinner: boolean;
    isScam: boolean;
    discoveredAt: Date;
    aiAnalysis: string | null;
}

export class MemoryService {
    /**
     * Store audited token in memory
     */
    static async recordToken(tokenData: any) {
        try {
            return await prisma.token.upsert({
                where: { address: tokenData.address },
                update: {
                    price: tokenData.price,
                    liquidity: tokenData.liquidity,
                    volume24h: tokenData.volume24h,
                    riskScore: tokenData.riskScore,
                    aiAnalysis: tokenData.aiAnalysis,
                    isScam: tokenData.isScam,
                    isWinner: tokenData.isWinner
                },
                create: {
                    address: tokenData.address,
                    name: tokenData.name,
                    symbol: tokenData.symbol,
                    chainId: tokenData.chainId,
                    dexId: tokenData.dexId,
                    url: tokenData.url,
                    imageUrl: tokenData.imageUrl,
                    liquidity: tokenData.liquidity,
                    fdv: tokenData.fdv,
                    price: tokenData.price,
                    volume24h: tokenData.volume24h,
                    priceChange24h: tokenData.priceChange24h,
                    pairCreatedAt: tokenData.pairCreatedAt,
                    isHoneypot: tokenData.isHoneypot,
                    buyTax: tokenData.buyTax,
                    sellTax: tokenData.sellTax,
                    isMintable: tokenData.isMintable,
                    riskScore: tokenData.riskScore,
                    aiAnalysis: tokenData.aiAnalysis,
                    isScam: tokenData.isScam,
                    isWinner: tokenData.isWinner,
                    tags: tokenData.tags
                }
            });
        } catch (error: any) {
            logger.error(`Failed to store token memory for ${tokenData.address}:`, { message: error.message });
            return null;
        }
    }

    /**
     * Retrieve historical pattern matches (similar symbols or tokens on the same chain)
     */
    static async findHistoricalContext(symbol: string, chainId: string): Promise<HistoricalMatch[]> {
        try {
            const matches = await prisma.token.findMany({
                where: {
                    OR: [
                        { symbol: { contains: symbol } },
                        { chainId }
                    ]
                },
                orderBy: { discoveredAt: 'desc' },
                take: 5
            });

            return matches.map(m => ({
                name: m.name,
                symbol: m.symbol,
                riskScore: m.riskScore,
                isWinner: m.isWinner,
                isScam: m.isScam,
                discoveredAt: m.discoveredAt,
                aiAnalysis: m.aiAnalysis
            }));
        } catch (error: any) {
            logger.warn('Failed to retrieve historical memory context:', { message: error.message });
            return [];
        }
    }

    /**
     * Get statistics of verified gems vs scams discovered
     */
    static async getGlobalStats() {
        try {
            const [totalScanned, gems, scams] = await Promise.all([
                prisma.token.count(),
                prisma.token.count({ where: { isWinner: true } }),
                prisma.token.count({ where: { isScam: true } })
            ]);

            return { totalScanned, gems, scams };
        } catch {
            return { totalScanned: 0, gems: 0, scams: 0 };
        }
    }
}
