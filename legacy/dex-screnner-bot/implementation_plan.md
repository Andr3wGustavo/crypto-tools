# DexScreener AI Sentinel - Implementation Plan

## 1. Overview
This project aims to build a sophisticated Discord bot that monitors DexScreener for high-potential cryptocurrency pairs. It leverages AI to perform due diligence, filtering out scams and rug pulls, and provides detailed, actionable intelligence to the user via Discord. The system is designed with a "RAG-ready" architecture, ensuring data is structured for future Retrieval-Augmented Generation capabilities.

## 2. Architecture

### 2.1. Core Components
1.  **Market Watcher (The Eye)**:
    *   Polls DexScreener API for `New Pairs` and `Trending` pairs.
    *   Implements rate limiting and efficient polling strategies.
2.  **Heuristic Filter (The Shield)**:
    *   First line of defense.
    *   Filters based on hard metrics: Liquidity > $X, Volume > $Y, Pair Age, FDV.
    *   Basic security checks (HoneyPot check integration if feasible, or liquidity lock status).
3.  **AI Analyst (The Brain)**:
    *   Receives pre-filtered candidates.
    *   Analyzes metadata (Token Name, Ticker, Social Links availability).
    *   *Future Expansion*: Scrapes project website/Twitter for sentiment and keyword analysis.
    *   Generates a "Confidence Score" and "Risk Assessment".
4.  **Data Layer (The Vault - RAG Ready)**:
    *   Database: SQLite (via Prisma or Better-SQLite3) for local, fast storage.
    *   Schema designed to store:
        *   Raw Token Data (JSON)
        *   AI Analysis/Summary (Text)
        *   Embeddings (Placeholder columns for vector data).
5.  **Discord Interface (The Commander)**:
    *   Sends rich Embeds with color-coded risk levels.
    *   Commands: `/analyze <token_address>`, `/stats`, `/config`.

## 3. Tech Stack
*   **Language**: TypeScript (Node.js)
*   **Bot Framework**: Discord.js
*   **AI/LLM Integration**: LangChain (flexible provider, defaults to Gemini/OpenAI)
*   **Database**: SQLite (with Prisma ORM for type safety)
*   **External APIs**: DexScreener API

## 4. Step-by-Step Implementation

### Phase 1: Foundation & Infrastructure
- [ ] Initialize TypeScript project structure.
- [ ] Set up Discord.js client and event handlers.
- [ ] Configure Prisma with SQLite.
- [ ] Create `Logger` utility for robust logging.

### Phase 2: Data Ingestion & Filtering
- [ ] Implement `DexScreenerService` to fetch new pairs.
- [ ] Implement `FilterService` for basic heuristic checks (Liquidity, Volume).

### Phase 3: AI Integration
- [ ] Set up LLM client (LangChain).
- [ ] Create prompt templates for "Due Diligence" analysis.
- [ ] Implement `AnalysisService` to process tokens through the LLM.

### Phase 4: Discord Reporting
- [ ] Design rich Embed layouts (Green for Gem, Red for Scam, Yellow for Caution).
- [ ] Implement notification logic.

### Phase 5: RAG Preparation
- [ ] Ensure all analysis and raw data are persisted with timestamps.
- [ ] Create a structured export or query interface for future context retrieval.

## 5. Configuration
The bot will be configurable via `.env`:
- `DISCORD_TOKEN`
- `LLM_API_KEY`
- `MIN_LIQUIDITY`
- `MIN_VOLUME`
