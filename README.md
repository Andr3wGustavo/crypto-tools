# 🚀 Cortex Crypto Sentinel & Trading Hub (v2.0)

> **Unified Institutional Crypto Suite**: Real-time DEX Radar, Anti-Honeypot Security Audits, AI Due Diligence, Discord Alpha Terminal, Binance Adaptive Market Making, and Compound PnL Tracker.

---

## 📑 Architecture Overview

Cortex Crypto unifies multiple specialized crypto engines into a single, high-performance TypeScript modular platform:

```
                               ┌────────────────────────────────────────────────────────┐
                               │                CORTEX CRYPTO SENTINEL                  │
                               └───────────────────────────┬────────────────────────────┘
                                                           │
              ┌────────────────────────────────────────────┼────────────────────────────────────────────┐
              ▼                                            ▼                                            ▼
   [ SCOUTING & SECURITY ]                       [ AI & RAG MEMORY ]                           [ TRADING & EXECUTION ]
   • Real-Time DexScreener Ingestion              • Gemini 2.0 Flash / Pro                      • Binance Adaptive Market Maker
   • GoPlus Security API (EVM Chains)             • Structured JSON Scoring                     • Low-Latency WebSocket @bookTicker
   • RugCheck API (Solana)                        • SQLite Token History                        • Avellaneda-Stoikov Inventory Skew
   • Multi-stage Heuristic Filter                 • Similar Pattern Retrieval                   • Dynamic Precision (LOT_SIZE)
                                                                                                • Trailing Take-Profit & Stop
                                                           │
                                                           ▼
                                               [ DISCORD ALPHA TERMINAL ]
                                               • Real-time Rich Embed Alerts
                                               • Slash Commands (/analyze, /radar, /market, /mm, /gains)
```

---

## 🌟 Key Features

### 1. 🛰️ DEX Radar & Multi-Chain Scout (`modules/scout/`)
- **Real-Time Feeds**: Listens to DexScreener token profiles, trending boosts, and multi-chain pools (Solana, Base, Ethereum, BSC, Arbitrum).
- **Anti-Honeypot Verification**: Queries **GoPlus Security** and **RugCheck** to verify whether a contract allows selling, detect minting authority, blacklist functions, and tax percentages.
- **Smart Filtering**: Blocks low-liquidity scams, high-tax traps, and suspicious FDV-to-liquidity ratios before consuming AI tokens.

### 2. 🧠 Institutional AI Due Diligence (`modules/ai/` & `modules/rag/`)
- **Gemini Engine**: Analyzes tokenomics, buyer vs seller momentum, age, and security flags to assign an institutional confidence score (0-100).
- **RAG Memory**: Records every scanned token in Prisma SQLite to learn patterns and avoid alerting on recurring scams.

### 3. ⚡ Binance Adaptive Market Maker (`modules/trading/`)
- **WebSocket Streaming**: Subscribes to `@bookTicker` for sub-50ms book imbalance and price detection with **zero REST rate-limit penalties**.
- **Adaptive Volatility (Respiro)**: Dynamically expands spread based on realized price volatility and order book depth imbalance.
- **Avellaneda-Stoikov Inventory Skew**: Mitigates inventory risk by adjusting quotes to offload heavy positions and protect against adverse price swings.
- **Post-Only Maker Enforcement**: Uses `LIMIT_MAKER` orders to capture spread and avoid taker fees.
- **Dynamic Precision**: Automatically queries `exchangeInfo` on startup to adapt to exact `tickSize` and `stepSize` for any symbol.

### 4. 📈 Gain Tracker & Trailing Stop (`modules/tracker/`)
- Tracks active token positions with live DexScreener price monitoring.
- **Trailing Stop-Loss**: Alerts when a token drops significantly from its peak to lock in gains.
- **Take-Profit Milestones**: Celebrates and notifies 2x, 5x, and 10x milestones on Discord.

### 5. 🤖 Discord Alpha Bot (`modules/discord/`)
- Slash commands:
  - `/analyze <address>`: Instant AI & security audit on any contract or DEX pair.
  - `/radar`: Statistics on scanned tokens, verified gems, and blocked scams.
  - `/market`: Macro crypto sentiment (Fear & Greed Index, BTC & ETH benchmarks).
  - `/mm [status|start|stop]`: Live monitoring and control of the Binance Market Maker.
  - `/gains`: Overview of tracked positions and current PnL.

---

## 🚀 Quick Start

### 1. Prerequisites
- Node.js v20+ (Node v24 tested)
- npm or pnpm

### 2. Installation
```bash
npm install
```

### 3. Environment Configuration
Copy `.env.example` to `.env` and fill in your keys:
```bash
cp .env.example .env
```
Key variables:
- `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_ALERT_CHANNEL_ID`
- `GEMINI_API_KEY`
- `BINANCE_API_KEY`, `BINANCE_SECRET` (Read & Trade Spot permissions, NO withdrawal!)

### 4. Database Setup
Initialize the local SQLite database:
```bash
npm run db:push
```

### 5. Launch
Start the bot in development mode:
```bash
npm run dev
```

Or build and run for production:
```bash
npm run build
npm start
```

---

## 🛠️ Tech Stack
- **Language**: TypeScript 5.3+ / Node.js
- **ORM & Database**: Prisma 5 / SQLite
- **AI / LLM**: Google Gemini 2.0 Flash / Pro (`@google/genai`)
- **WebSockets**: `ws`
- **Math Precision**: `bignumber.js`
- **Validation**: `zod`
- **Logger**: Winston
- **APIs**: DexScreener, GoPlus Security, RugCheck, Alternative.me, Binance Spot API

---

## 📄 License
ISC
