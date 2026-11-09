import axios from 'axios';
import { DexPair } from '../scout/dexscreener.service';
import { SecurityAuditResult } from '../scout/security.service';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

export interface AIDueDiligenceReport {
    score: number; // 0-100
    isScam: boolean;
    isWinner: boolean;
    sentiment: 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'SCAM';
    summary: string;
    strengths: string[];
    risks: string[];
    recommendation: 'BUY_OPPORTUNITY' | 'WATCHLIST' | 'AVOID' | 'SCAM_DANGER';
}

export class GeminiService {
    /**
     * Run institutional due diligence using Google Gemini API
     */
    static async analyzeToken(pair: DexPair, security?: SecurityAuditResult): Promise<AIDueDiligenceReport> {
        if (!env.GEMINI_API_KEY) {
            logger.warn('GEMINI_API_KEY is not configured. Running algorithmic heuristic fallback.');
            return this.algorithmicFallback(pair, security);
        }

        const ageHours = ((Date.now() - (pair.pairCreatedAt || Date.now())) / (1000 * 60 * 60)).toFixed(1);
        const buySellRatio = pair.txns?.h24 ? ((pair.txns.h24.buys || 1) / (pair.txns.h24.sells || 1)).toFixed(2) : '1.0';

        const prompt = `
You are a Principal Quantitative Crypto Analyst and Smart Contract Auditor.
Conduct a rigorous due diligence audit of the following DEX cryptocurrency pair.

TOKEN DATA:
- Name: ${pair.baseToken.name} (${pair.baseToken.symbol})
- Pair Address: ${pair.pairAddress}
- Chain: ${pair.chainId} | DEX: ${pair.dexId}
- Current Price: $${pair.priceUsd}
- Liquidity (USD): $${pair.liquidity?.usd?.toLocaleString()}
- Fully Diluted Valuation (FDV): $${pair.fdv?.toLocaleString()}
- 24h Volume: $${pair.volume?.h24?.toLocaleString()}
- 24h Price Change: ${pair.priceChange?.h24}%
- Pair Age: ${ageHours} hours
- 24h Buy/Sell Ratio: ${buySellRatio} (Buys: ${pair.txns?.h24?.buys}, Sells: ${pair.txns?.h24?.sells})
- Security Flags: ${security?.riskFlags?.join('; ') || 'No critical flags'}
- Honeypot: ${security?.isHoneypot ? 'YES' : 'NO'} | Buy Tax: ${security?.buyTax}% | Sell Tax: ${security?.sellTax}%

TASK:
1. Detect predatory tokenomics, wash trading, or abnormal FDV/Liquidity disparity.
2. Evaluate growth potential versus dump risk.
3. Score the candidate from 0 (guaranteed scam) to 100 (high conviction gem).
4. Output STRICT JSON with this schema:
{
  "score": number,
  "isScam": boolean,
  "isWinner": boolean,
  "sentiment": "BULLISH" | "NEUTRAL" | "BEARISH" | "SCAM",
  "summary": "Concise executive overview for Discord notification",
  "strengths": ["point 1", "point 2"],
  "risks": ["risk 1", "risk 2"],
  "recommendation": "BUY_OPPORTUNITY" | "WATCHLIST" | "AVOID" | "SCAM_DANGER"
}
`;

        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
            const res = await axios.post(
                url,
                {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.2,
                        responseMimeType: "application/json"
                    }
                },
                { timeout: 15000 }
            );

            const rawText = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!rawText) throw new Error('Empty response from Gemini API');

            const parsed: AIDueDiligenceReport = JSON.parse(rawText);
            return parsed;
        } catch (error: any) {
            logger.error(`Gemini Analysis Failed: ${error.message}. Using algorithmic heuristic fallback.`);
            return this.algorithmicFallback(pair, security);
        }
    }

    /**
     * Quantitative algorithmic fallback when LLM is unavailable
     */
    private static algorithmicFallback(pair: DexPair, security?: SecurityAuditResult): AIDueDiligenceReport {
        let score = 50;
        const risks: string[] = [];
        const strengths: string[] = [];

        // Liquidity check
        const liq = pair.liquidity?.usd || 0;
        if (liq > 100000) { score += 15; strengths.push('Strong liquidity ($>100k)'); }
        else if (liq > 30000) { score += 5; strengths.push('Healthy initial liquidity'); }
        else { score -= 10; risks.push('Thin liquidity pool'); }

        // Volume check
        const vol = pair.volume?.h24 || 0;
        if (vol > 100000) { score += 15; strengths.push('High trading volume ($>100k)'); }

        // Buy/Sell txn momentum
        const buys = pair.txns?.h24?.buys || 0;
        const sells = pair.txns?.h24?.sells || 0;
        if (buys > sells * 1.5) { score += 10; strengths.push('Strong buyer demand dominance'); }
        else if (sells > buys * 2) { score -= 15; risks.push('Heavy sell pressure detected'); }

        // Security penalties
        if (security?.isHoneypot) { score = 0; risks.push('Confirmed Honeypot'); }
        if ((security?.sellTax || 0) > 5) { score -= 20; risks.push(`Tax penalty (${security?.sellTax}%)`); }

        score = Math.max(0, Math.min(100, score));

        const isScam = score < 30 || (security?.isHoneypot ?? false);
        const isWinner = score >= 80;

        return {
            score,
            isScam,
            isWinner,
            sentiment: isScam ? 'SCAM' : isWinner ? 'BULLISH' : score >= 50 ? 'NEUTRAL' : 'BEARISH',
            summary: `Automated quantitative scoring for ${pair.baseToken.name}. Score: ${score}/100.`,
            strengths,
            risks,
            recommendation: isScam ? 'SCAM_DANGER' : isWinner ? 'BUY_OPPORTUNITY' : score >= 50 ? 'WATCHLIST' : 'AVOID'
        };
    }
}
