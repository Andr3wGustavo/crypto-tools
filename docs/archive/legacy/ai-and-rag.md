# Artificial Intelligence Due Diligence and Vector RAG Memory

## 1. AI Due Diligence Engine (`src/modules/ai/gemini.service.ts`)

### 1.1. Model Configuration
* Model Family: Google Gemini (`gemini-2.0-flash` / `gemini-1.5-pro`)
* Temperature: `0.2` (Configured for deterministic, analytical evaluation)
* Output Format: `application/json` (Strictly enforced via API generation config)

### 1.2. Prompt Structure and Evaluation Criteria
The system prompt establishes the persona of a Principal Quantitative Crypto Analyst and Smart Contract Auditor:
* **Tokenomics Inspection**: Evaluates FDV vs. liquidity depth, token circulation distribution, and market capitalization realism.
* **Transaction Momentum**: Computes the 24-hour buy/sell ratio:
  $$\text{BuySellRatio} = \frac{\text{Txns}_{\text{buys}}}{\max(1, \text{Txns}_{\text{sells}})}$$
* **Red Flag Detection**: Cross-references on-chain security audit findings with trading volume patterns.

### 1.3. Output Contract
The response must adhere to this JSON interface:
```json
{
  "score": 85,
  "isScam": false,
  "isWinner": true,
  "sentiment": "BULLISH",
  "summary": "Verified organic liquidity with high buyer demand and revoked contract authorities.",
  "strengths": [
    "Locked liquidity exceeds $120,000 USD",
    "Buy transaction count outnumbers sells 3:1"
  ],
  "risks": [
    "High volatility expected due to sub-24h age"
  ],
  "recommendation": "BUY_OPPORTUNITY"
}
```

### 1.4. Algorithmic Quantitative Fallback
If the Gemini API is unreachable, offline, or lacks API credentials, `GeminiService.algorithmicFallback` engages autonomously:
* Initial Score: Base $50$ points.
* Liquidity adjustment: $+15$ for $> \$100\text{k}$, $+5$ for $> \$30\text{k}$, $-10$ for $< \$30\text{k}$.
* Volume adjustment: $+15$ for $> \$100\text{k}$.
* Momentum adjustment: $+10$ if $\text{buys} > 1.5 \times \text{sells}$, $-15$ if $\text{sells} > 2 \times \text{buys}$.
* Security penalties: Score set to $0$ if honeypot is verified; $-20$ points if transfer taxes exceed $5\%$.

---

## 2. Vector RAG Engine (`src/modules/rag/vector.service.ts`)

### 2.1. Vector Embedding Generation
* Model: `models/text-embedding-004`
* Dimensionality: 768-dimensional floating-point array.
* Input text: Token Name, Symbol, Network, Security Summary, and AI Evaluation Text.

### 2.2. Vector Similarity Search (Cosine Similarity)
When a user executes `/ask <query>` or when comparative intelligence is required, the query string is converted to a vector $\mathbf{A}$, and evaluated against stored token vectors $\mathbf{B}$ in SQLite:

$$\text{Similarity}(\mathbf{A}, \mathbf{B}) = \frac{\sum_{i=1}^{768} A_i B_i}{\sqrt{\sum_{i=1}^{768} A_i^2} \sqrt{\sum_{i=1}^{768} B_i^2}}$$

### 2.3. Use Cases
1. **Scam Pattern Matching**: Compares newly launched tokens against historical scams that had similar marketing narratives or contract configurations.
2. **Historical Context Retrieval**: Informs whether tokens with similar tokenomics on the same chain succeeded or experienced liquidity depletion.
