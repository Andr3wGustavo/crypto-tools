import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

const prisma = new PrismaClient();

export interface VectorMatch {
    tokenAddress: string;
    symbol: string;
    name: string;
    similarity: number;
    riskScore: number | null;
    isWinner: boolean;
    isScam: boolean;
    summary: string | null;
}

export class VectorService {
    /**
     * Generate 768-dimensional vector embedding using Google Gemini Embeddings API
     */
    static async generateEmbedding(text: string): Promise<number[] | null> {
        if (!env.GEMINI_API_KEY) {
            return null;
        }

        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${env.GEMINI_API_KEY}`;
            const res = await axios.post(
                url,
                {
                    model: 'models/text-embedding-004',
                    content: { parts: [{ text }] }
                },
                { timeout: 8000 }
            );

            const values = res.data?.embedding?.values;
            if (Array.isArray(values) && values.length > 0) {
                return values;
            }
            return null;
        } catch (error: any) {
            logger.warn(`Failed to generate vector embedding: ${error.message}`);
            return null;
        }
    }

    /**
     * Compute cosine similarity between two float vectors
     */
    static cosineSimilarity(vecA: number[], vecB: number[]): number {
        if (vecA.length !== vecB.length || vecA.length === 0) return 0;

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }

        if (normA === 0 || normB === 0) return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    /**
     * Search database for tokens with highest semantic similarity
     */
    static async searchSimilarTokens(queryText: string, topK = 3): Promise<VectorMatch[]> {
        const queryVec = await this.generateEmbedding(queryText);
        if (!queryVec) return [];

        try {
            const tokens = await prisma.token.findMany({
                where: { embedding: { not: null } },
                select: {
                    address: true,
                    symbol: true,
                    name: true,
                    riskScore: true,
                    isWinner: true,
                    isScam: true,
                    aiAnalysis: true,
                    embedding: true
                }
            });

            const scored: VectorMatch[] = [];

            for (const t of tokens) {
                if (!t.embedding) continue;
                try {
                    const tokenVec: number[] = JSON.parse(t.embedding);
                    const similarity = this.cosineSimilarity(queryVec, tokenVec);
                    scored.push({
                        tokenAddress: t.address,
                        symbol: t.symbol,
                        name: t.name,
                        similarity,
                        riskScore: t.riskScore,
                        isWinner: t.isWinner,
                        isScam: t.isScam,
                        summary: t.aiAnalysis
                    });
                } catch {
                    // Skip malformed vector JSON
                }
            }

            return scored.sort((a, b) => b.similarity - a.similarity).slice(0, topK);
        } catch (error: any) {
            logger.error(`Vector search exception: ${error.message}`);
            return [];
        }
    }

    /**
     * Attach embedding to an existing token record
     */
    static async attachEmbedding(tokenAddress: string, description: string) {
        const embedding = await this.generateEmbedding(description);
        if (embedding) {
            await prisma.token.update({
                where: { address: tokenAddress },
                data: { embedding: JSON.stringify(embedding) }
            }).catch(() => {});
        }
    }
}
