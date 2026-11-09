import axios from 'axios';
import { logger } from '../../utils/logger';

export interface SwapQuote {
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    priceImpactPct: number;
    slippageBps: number;
    routePlan: string[];
    rawQuote: any;
}

export interface SwapSimulationResult {
    success: boolean;
    inputAmountSol: number;
    expectedOutputTokens: number;
    priceImpactPct: number;
    estimatedFeeSol: number;
    summary: string;
}

export class JupiterService {
    private static BASE_URL = 'https://quote-api.jup.ag/v6';
    private static SOL_MINT = 'So11111111111111111111111111111111111111112';

    /**
     * Fetch optimal DEX swap route quote via Jupiter v6
     */
    static async getQuote(
        outputMint: string,
        amountSol = 0.1,
        slippageBps = 100, // 1.0% default slippage
        inputMint = this.SOL_MINT
    ): Promise<SwapQuote | null> {
        try {
            const amountLamports = Math.floor(amountSol * 1e9);
            const url = `${this.BASE_URL}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`;

            const res = await axios.get(url, { timeout: 6000 });
            const data = res.data;

            if (!data || !data.outAmount) return null;

            const routePlan = (data.routePlan || []).map((r: any) => r.swapInfo?.label || 'DEX');

            return {
                inputMint,
                outputMint,
                inAmount: data.inAmount,
                outAmount: data.outAmount,
                priceImpactPct: parseFloat(data.priceImpactPct || '0'),
                slippageBps: data.slippageBps,
                routePlan,
                rawQuote: data
            };
        } catch (error: any) {
            logger.warn(`Jupiter quote failed for mint ${outputMint}: ${error.message}`);
            return null;
        }
    }

    /**
     * Simulate a swap for risk assessment and preview without wallet spending
     */
    static async simulateSwap(tokenMint: string, amountSol = 0.1): Promise<SwapSimulationResult> {
        const quote = await this.getQuote(tokenMint, amountSol);

        if (!quote) {
            return {
                success: false,
                inputAmountSol: amountSol,
                expectedOutputTokens: 0,
                priceImpactPct: 0,
                estimatedFeeSol: 0,
                summary: 'Unable to route swap liquidity via Jupiter.'
            };
        }

        const outTokens = parseFloat(quote.outAmount);
        const priceImpact = quote.priceImpactPct;

        return {
            success: true,
            inputAmountSol: amountSol,
            expectedOutputTokens: outTokens,
            priceImpactPct: priceImpact,
            estimatedFeeSol: 0.000005, // Standard Solana base fee
            summary: `Simulated swap of ${amountSol} SOL -> ${outTokens.toLocaleString()} tokens across [${quote.routePlan.join(' -> ')}] with ${priceImpact.toFixed(2)}% price impact.`
        };
    }
}
