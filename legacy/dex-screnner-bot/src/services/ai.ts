import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { PromptTemplate } from "langchain/prompts";
import { config } from '../config/env';
import { DexToken } from './dexscreener';

export class AIService {
    private model: ChatGoogleGenerativeAI;

    constructor() {
        this.model = new ChatGoogleGenerativeAI({
            apiKey: config.GOOGLE_API_KEY,
            modelName: "gemini-1.5-pro",
            maxOutputTokens: 1024,
        });
    }

    async analyzeToken(token: DexToken): Promise<{ analysis: string; score: number; isScam: boolean }> {
        const template = `
      You are a Senior Crypto Analyst and Security Expert.
      Analyze the following cryptocurrency pair data from DexScreener and provide a due diligence report.
      
      Token: {name} ({symbol})
      Pair Address: {address}
      Liquidity: ${'$'}{liquidity}
      FDV: ${'$'}{fdv}
      Price Change (24h): {change24h}%
      Volume (24h): ${'$'}{volume24h}
      Pair Age (approx): {age} hours
      
      Task:
      1. Identify potential red flags (e.g., liquidity too low vs FDV, suspicious volume patterns if visible, generic names).
      2. Assess the potential for this to be a "Winner" or a "Rug Pull/Scam".
      3. Provide a Confidence Score (0-100) where 100 is a high-quality, safe project and 0 is a definite scam.
      4. Write a concise summary for a Discord notification.
      
      Output format (JSON):
      {{
        "analysis": "Detailed text summary...",
        "score": 85,
        "isScam": false,
        "recommendation": "Buy/Watch/Avoid"
      }}
    `;

        const prompt = PromptTemplate.fromTemplate(template);

        const ageHours = ((Date.now() - token.pairCreatedAt) / (1000 * 60 * 60)).toFixed(2);

        const chain = prompt.pipe(this.model);

        try {
            const result = await chain.invoke({
                name: token.baseToken.name,
                symbol: token.baseToken.symbol,
                address: token.pairAddress,
                liquidity: token.liquidity.usd,
                fdv: token.fdv,
                change24h: token.priceChange.h24,
                volume24h: token.volume.h24,
                age: ageHours
            });

            // Parse the JSON output from the LLM
            // Note: LLMs might add markdown code blocks.
            let content = result.content.toString();
            content = content.replace(/```json/g, '').replace(/```/g, '').trim();

            const parsed = JSON.parse(content);

            return {
                analysis: parsed.analysis,
                score: parsed.score,
                isScam: parsed.isScam || parsed.score < 30
            };
        } catch (error) {
            console.error("AI Analysis Failed", error);
            return {
                analysis: "AI Analysis Failed due to error.",
                score: 0,
                isScam: true // Fail safe
            };
        }
    }
}
