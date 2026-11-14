# System Architecture and Design Specifications

## 1. Overview
The `crypto-tools` platform is designed as an event-driven, decoupled quantitative engine written in TypeScript (Node.js). It integrates multi-chain data ingestion, automated on-chain smart contract auditing, artificial intelligence due diligence, historical memory (RAG), decentralized swap routing, and high-frequency adaptive market making.

---

## 2. Layered Architecture

The system is structured into five cohesive layers:

```
+-------------------------------------------------------------------------+
|                         PRESENTATION / INTERFACE                        |
| - Discord.js v14 Client                                                 |
| - Interactive Slash Commands (/analyze, /ask, /track, /swap, /mm)       |
| - ActionRow Buttons (DexScreener Link, Track Position, Simulate Swap)   |
+------------------------------------+------------------------------------+
                                     |
+------------------------------------v------------------------------------+
|                         APPLICATION COORDINATION                        |
| - src/index.ts (Lifecycle coordinator, Graceful shutdown)               |
| - Background Autonomous Pollers (Radar Loop, Gain Tracker Loop)         |
+------------------------------------+------------------------------------+
                                     |
+------------------------------------v------------------------------------+
|                             DOMAIN ENGINES                              |
| 1. Scout & Radar (DexScreener API profiles and boosts)                  |
| 2. Security Engine (GoPlus Security & RugCheck APIs)                    |
| 3. Heuristic Filters (Liquidity, Volume, Age, FDV/Liq Ratio)            |
| 4. AI Due Diligence (Google Gemini 2.0 Flash / Pro)                     |
| 5. Vector RAG Engine (text-embedding-004 + Cosine Similarity)           |
| 6. Market Making Engine (Binance WebSockets, Respiro, Avellaneda Skew)   |
| 7. Gain & Trailing Stop Tracker (DexScreener continuous PnL monitor)    |
| 8. DEX Execution Engine (Jupiter v6 Routing & Simulation)               |
+------------------------------------+------------------------------------+
                                     |
+------------------------------------v------------------------------------+
|                       INFRASTRUCTURE & INTEGRATION                      |
| - Binance WebSocket Streams (@bookTicker & User Data listenKey)         |
| - Binance REST Client (HMAC-SHA256 Signed Orders)                       |
| - Arbitrary Precision Math Engine (bignumber.js)                        |
| - Runtime Schema Validation (zod)                                       |
| - Structured Winston Logging                                            |
+------------------------------------+------------------------------------+
                                     |
+------------------------------------v------------------------------------+
|                             DATA PERSISTENCE                            |
| - Prisma ORM 5.x                                                        |
| - SQLite Embedded Database (dev.db)                                     |
| - Models: Token, TokenLog, Trade, Position, MacroMetric                 |
+-------------------------------------------------------------------------+
```

---

## 3. Data Flow Pipelines

### 3.1. Radar Ingestion and Alert Pipeline
1. `DexScreenerService` polls `/token-profiles/latest/v1` and `/token-boosts/latest/v1` every 30 seconds.
2. Candidate addresses are deduplicated and queried in batch via `/latest/dex/tokens/{addressList}`.
3. `SecurityService` performs on-chain analysis (GoPlus for EVM, RugCheck for Solana).
4. `FilterService` verifies minimum liquidity ($10,000), minimum volume ($25,000), age ceiling (72h), and FDV/Liquidity ratio (<200:1).
5. If passed, `GeminiService` executes structured due diligence, yielding an institutional score (0-100).
6. Token data, audit findings, and risk scores are persisted to SQLite via `MemoryService`.
7. `VectorService` generates a 768-dimensional vector embedding in the background and attaches it to the database record.
8. If the candidate achieves a score >= 80 without scam indicators, an interactive Discord Embed with action buttons is dispatched to the configured alert channel.

### 3.2. Binance Market Making Pipeline
1. `ExchangeInfoService` fetches and caches symbol rules (`tickSize`, `stepSize`, `minNotional`) on boot.
2. `BinanceWebSocketService` receives continuous sub-50ms `@bookTicker` updates.
3. Mid-prices feed into a rolling window of size 50 to compute instant volatility ("Respiro").
4. Book depth imbalance is computed from top bid/ask volumes.
5. Spread and quotes are computed via Avellaneda-Stoikov inventory skewing.
6. Open orders are canceled, and new `LIMIT_MAKER` post-only bid and ask orders are submitted.
7. Orders are monitored under dynamic TTL; if mid-price drifts beyond 0.2%, orders are cancelled immediately.
8. `BinanceUserDataStreamService` captures `executionReport` events; upon order fill, trade details are logged and net profits are directed to `CompoundService` to scale future position sizes.

---

## 4. Design Patterns Utilized
* **Facade Pattern**: `DiscordBotService` coordinates multiple domain modules behind a unified interface.
* **Factory Pattern**: `DiscordEmbedFactory` encapsulates rich card generation, buttons, and embed layout logic.
* **Adapter Pattern**: `BinanceAdapter` abstracts raw HTTP signing and error mapping.
* **Observer Pattern**: WebSocket services expose event listener registration methods (`onTicker`, `onExecution`) to decouple streaming ingestion from trading strategy logic.
* **Repository Pattern**: `MemoryService` and `GainTrackerService` abstract Prisma database operations.
