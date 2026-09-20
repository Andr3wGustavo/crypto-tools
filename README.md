# crypto-tools: Enterprise Crypto Intelligence and Trading Infrastructure

Modular TypeScript engine integrating decentralized exchange (DEX) token discovery, automated on-chain anti-honeypot auditing, artificial intelligence due diligence, historical memory (RAG-ready), centralized exchange (CEX) adaptive market making with low-latency WebSockets, position gain tracking, and an interactive Discord terminal interface.

---

## 1. System Architecture

The repository consolidates multiple quantitative and security engines into a modular, decoupled architecture:

```
+-----------------------------------------------------------------------------+
|                               CRYPTO-TOOLS                                  |
+-----------------------------------------------------------------------------+
                                       |
        +------------------------------+------------------------------+
        |                                                             |
        v                                                             v
+-----------------------------+                               +-----------------------------+
|     SCOUTING & SECURITY     |                               |     TRADING & EXECUTION     |
+-----------------------------+                               +-----------------------------+
| - DexScreener Live Ingestion|                               | - Binance Adaptive MM Engine|
| - GoPlus EVM Security Audit |                               | - Low-Latency WS @bookTicker|
| - RugCheck Solana Audit     |                               | - Avellaneda-Stoikov Skew   |
| - Multi-Stage Filters       |                               | - Dynamic Filter Rules      |
+--------------+--------------+                               | - Compound Reinvestment     |
               |                                              +--------------+--------------+
               v                                                             |
+-----------------------------+                                              v
|    AI & PERSISTENCE LAYER   |                               +-----------------------------+
+-----------------------------+                               |     GAIN & PNL TRACKER      |
| - Gemini 2.0 Due Diligence  |                               +-----------------------------+
| - Strict JSON Schema        |                               | - Real-Time Position Monitor|
| - Algorithmic Fallback      |                               | - Dynamic Trailing Stop     |
| - Prisma ORM + SQLite       |                               | - Milestone Alerts (2x/5x)  |
| - Historical Memory (RAG)   |                               +--------------+--------------+
+--------------+--------------+                                              |
               |                                                             |
               +------------------------------+------------------------------+
                                              |
                                              v
                              +-------------------------------+
                              |    DISCORD TERMINAL CLIENT    |
                              +-------------------------------+
                              | - Slash Commands (/analyze)   |
                              | - Real-time Rich Embed Alerts |
                              | - Autonomous Background Loops |
                              +-------------------------------+
```

---

## 2. Comprehensive Feature Breakdown

### 2.1. Multi-Chain DEX Radar and Market Ingestion (`src/modules/scout/dexscreener.service.ts`)
* **Real-Time Data Feeds**: Connects to official DexScreener endpoints:
  * `/token-profiles/latest/v1`: Identifies newly validated tokens with verified community channels and social descriptions.
  * `/token-boosts/latest/v1`: Ingests tokens experiencing active marketing boosts and volume spikes.
  * `/latest/dex/tokens/{addressList}`: Performs multi-token batch lookups for high-throughput pool data retrieval.
  * `/latest/dex/search?q={chain}`: Fallback heuristic scanner for Solana, Base, Ethereum, and Binance Smart Chain pools.
* **Pool Resolution**: Ingests liquidity (USD), fully diluted valuation (FDV), 24-hour volume, price changes across multiple intervals (5m, 1h, 6h, 24h), and transaction ratios (buy/sell volume).

### 2.2. Automated Smart Contract Security and Anti-Honeypot Engine (`src/modules/scout/security.service.ts`)
Executes direct programmatic contract audits prior to consuming downstream resources:
* **EVM Networks (Ethereum, Base, BSC, Arbitrum, Polygon)**:
  * Integrated with GoPlus Security API.
  * Validates:
    * `is_honeypot`: Verifies whether sell transactions are simulated and permitted.
    * `buy_tax` and `sell_tax`: Identifies predatory transfer fees (flagged if greater than 10%).
    * `is_mintable`: Verifies if the contract owner can arbitrarily inflate token supply.
    * `is_blacklisted`: Detects if arbitrary addresses can be restricted from trading.
    * `can_take_back_ownership`: Detects if renounced ownership can be reclaimed via hidden proxy functions.
    * `cannot_sell_all`: Detects restrictions on selling entire wallet balances.
* **Solana Network**:
  * Integrated with RugCheck API.
  * Validates:
    * Mint authority revocation status (prevents unauthorized supply dilution).
    * Freeze authority revocation status (prevents wallet blacklisting).
    * Liquidity pool lock/burn score.

### 2.3. Multi-Stage Heuristic Filtering (`src/modules/scout/filter.service.ts`)
Filters out noise, illiquid pools, and market manipulation:
* **Stage 1 (Security Threshold)**: Immediate rejection if any critical vulnerability is identified by the security audit.
* **Stage 2 (Liquidity Minimum)**: Enforces `MIN_LIQUIDITY_USD` (configurable, default $10,000 USD).
* **Stage 3 (Volume Minimum)**: Enforces `MIN_VOLUME_USD_24H` (configurable, default $25,000 USD).
* **Stage 4 (Age Constraint)**: Enforces `MAX_AGE_HOURS` to focus on recent launches or trending pairs.
* **Stage 5 (FDV to Liquidity Anomaly Check)**: Rejects pairs where the FDV-to-Liquidity ratio exceeds 200:1, eliminating disproportionate capital structures prone to catastrophic dumps.

### 2.4. Artificial Intelligence Due Diligence (`src/modules/ai/gemini.service.ts`)
* **Model Integration**: Powered by Google Gemini 2.0 Flash / Pro.
* **Structured JSON Enforcement**: Requires strict adherence to a defined JSON response contract:
  ```json
  {
    "score": 85,
    "isScam": false,
    "isWinner": true,
    "sentiment": "BULLISH",
    "summary": "Executive technical summary",
    "strengths": ["Strong initial liquidity lock", "Healthy buy/sell ratio"],
    "risks": ["Short contract lifespan"],
    "recommendation": "BUY_OPPORTUNITY"
  }
  ```
* **Autonomous Quantitative Fallback**: In scenarios where the external AI provider is unreachable or API credentials are omitted, the service switches to a mathematical heuristic model evaluating buyer-to-seller pressure, liquidity distribution, and transaction momentum.

### 2.5. Historical Memory and RAG Layer (`src/modules/rag/memory.service.ts`)
* **Persistence**: Every scanned token is stored in SQLite through Prisma ORM (`prisma/schema.prisma`).
* **Pattern Recognition**: Maintains historical records of security audits, AI evaluations, prices, and outcomes (winner vs scam status).
* **Historical Retrieval**: Allows the Discord interface or background services to query previous records for identical or similar ticker symbols across networks.

### 2.6. Macro Market Intelligence (`src/modules/market/macro.service.ts`)
* **Sentiment Indicator**: Integrates with the Alternative.me Fear and Greed Index API.
* **Benchmark Pricing**: Fetches live Bitcoin (BTCUSDT) and Ethereum (ETHUSDT) prices directly from Binance market data for contextual market analysis.

### 2.7. Binance Adaptive Market Maker Engine (`src/modules/trading/market-maker.engine.ts`)
Institutional-grade quantitative market making architecture designed for maker-only execution:
* **Low-Latency WebSocket Streaming (`binance-ws.service.ts`)**:
  * Subscribes to `wss://stream.binance.com:9443/ws/<symbol>@bookTicker`.
  * Computes Best Bid, Best Ask, and Real-Time Order Book Imbalance with sub-50ms latency.
  * Completely bypasses REST rate-limit constraints (HTTP 429 prevention).
  * Includes automatic socket reconnection with exponential backoff.
* **Mathematical Volatility Modeling ("Respiro")**:
  * Measures rolling price volatility across an $N=50$ window of mid-prices:
    $$\text{Respiro} = \frac{1}{N-1} \sum_{i=1}^{N} \frac{|\text{Mid}_i - \text{Mid}_{i-1}|}{\text{Mid}_{i-1}}$$
* **Dynamic Spread Calculation**:
  * Spread expands dynamically based on volatility and order book depth imbalance:
    $$\text{TargetSpread} = \max\left(2 \times \text{feeMaker} + \text{margin},\; k_1 \times \text{Respiro},\; k_2 \times |\text{Imbalance}|\right)$$
* **Avellaneda-Stoikov Inventory Skew Model**:
  * Mitigates directional exposure when inventory deviates from the target balance (e.g., 50% base, 50% quote):
    $$\text{EffectiveMid} = \text{Mid} \times \left(1 - (\text{InventoryPct} - \text{Target}) \times \text{skewFactor}\right)$$
  * Skews quotes downward when holding excess base inventory to incentivize selling, and upward when holding excess quote currency.
* **Dynamic Exchange Rules (`exchange-info.service.ts`)**:
  * Dynamically queries Binance `exchangeInfo` on boot.
  * Resolves `PRICE_FILTER.tickSize`, `LOT_SIZE.stepSize`, and `MIN_NOTIONAL`.
  * Employs arbitrary-precision math (`bignumber.js`) to guarantee zero order rejections caused by floating-point rounding errors.
* **Execution Safety Rules**:
  * Maker-Only Orders: Places `LIMIT_MAKER` orders exclusively to guarantee zero taker fees.
  * Dynamic Time-To-Live (TTL): Orders expire after a duration proportional to current volatility (3,000ms to 10,000ms).
  * Mid-Price Drift Protection: Cancels all open orders immediately if the live mid-price moves more than `driftThreshold` (default 0.2%).
  * Daily Stop-Loss: Ceases all trading if total portfolio value experiences a daily drawdown equal to or greater than `dailyStopLoss` (default -1.5%).

### 2.8. Compound Trading Service (`src/modules/trading/compound.service.ts`)
* **Automated Capital Scaling**: Tracks net realized profits from executed maker cycles.
* **Dynamic Reinvestment**: Gradually scales base order size proportionally to cumulative profit:
  $$\text{NewOrderSize} = \text{BaseSize} + (\text{TotalProfit} \times \text{ReinvestmentRatio} \times 0.10)$$

### 2.9. Position Gain and Trailing Stop Tracker (`src/modules/tracker/gain-tracker.service.ts`)
* **Continuous Monitoring**: Tracks active token positions and computes real-time PnL against entry prices:
  $$\text{GainPct} = \frac{\text{CurrentPrice} - \text{EntryPrice}}{\text{EntryPrice}} \times 100$$
* **Trailing Stop-Loss**: Dynamically tracks peak prices; if price declines from its peak by `trailingStopPct` (default 15%), it triggers a trailing stop alert to lock in gains.
* **Milestone Alerts**: Dispatches alerts when an asset reaches key milestones (e.g., +100% / 2x, +400% / 5x, +900% / 10x).

### 2.10. Discord Alpha Terminal (`src/modules/discord/bot.ts`)
Comprehensive Discord.js v14 client with slash commands and rich embed generation:
* `/analyze <address>`: Performs on-demand security auditing and AI due diligence on any token or pair contract address across EVM and Solana.
* `/radar`: Displays aggregate database statistics on scanned tokens, identified gems, and filtered scams.
* `/market`: Displays current macro metrics, Fear & Greed index, and benchmark crypto prices.
* `/mm [action]`: Controls and monitors the Binance Adaptive Market Maker engine (`status`, `start`, `stop`).
* `/gains`: Lists all open positions, active PnL percentages, and trailing stop levels.
* **Autonomous Event Dispatching**: Dispatches color-coded cards to designated channels when verified gems (score >= 80) or trailing stop triggers occur.

---

## 3. Database Schema (Prisma / SQLite)

The data model (`prisma/schema.prisma`) is organized into four core entities:

* **`Token`**: Stores contract address, chain, DEX identifier, liquidity, FDV, price, security audit findings (honeypot, tax rates, mint authority), AI risk score, summary, and RAG metadata.
* **`TokenLog`**: Structured historical event logs associated with each token.
* **`Trade`**: Execution records from centralized exchange market making and automated strategies (symbol, side, price, quantity, fees, maker flag, spread, skew, PnL).
* **`Position`**: Tracks open investment positions with entry price, current price, peak price, trailing stop percentage, and lifecycle status (`ACTIVE`, `CLOSED`, `STOPPED_OUT`).
* **`MacroMetric`**: Historical record of macro indices (Fear & Greed, BTC Dominance, Gas).

---

## 4. Environment Configuration

Copy the template configuration and supply the appropriate credentials:

```bash
cp .env.example .env
```

### Configuration Keys:

| Variable | Type | Description | Default |
| :--- | :--- | :--- | :--- |
| `DATABASE_URL` | String | SQLite database connection string | `file:./dev.db` |
| `DISCORD_TOKEN` | String | Discord Bot application token | (Required for Discord) |
| `DISCORD_CLIENT_ID` | String | Discord Application Client ID | (Required for Slash Commands) |
| `DISCORD_GUILD_ID` | String | Discord Guild ID for immediate slash command deployment | (Optional) |
| `DISCORD_ALERT_CHANNEL_ID` | String | Target channel ID for gem discovery alerts | (Optional) |
| `DISCORD_TRADING_CHANNEL_ID` | String | Target channel ID for trading and PnL alerts | (Optional) |
| `GEMINI_API_KEY` | String | Google Gemini API key | (Optional, heuristic fallback available) |
| `GEMINI_MODEL` | String | Gemini model version | `gemini-2.0-flash` |
| `MIN_LIQUIDITY_USD` | Number | Minimum liquidity filter threshold in USD | `10000` |
| `MIN_VOLUME_USD_24H` | Number | Minimum 24h volume filter threshold in USD | `25000` |
| `MAX_AGE_HOURS` | Number | Maximum pool age in hours for radar monitoring | `72` |
| `POLL_INTERVAL_MS` | Number | Background radar polling interval in milliseconds | `30000` |
| `BINANCE_API_KEY` | String | Binance API Key (Spot Trading permission required) | (Optional for MM) |
| `BINANCE_SECRET` | String | Binance API Secret Key | (Optional for MM) |
| `MM_SYMBOL` | String | Trading pair for the market maker engine | `BTCUSDT` |
| `MM_MIN_ORDER_USD` | Number | Base order size in quote currency | `15.0` |
| `MM_MAX_POSITION_USD` | Number | Maximum position allocation for inventory management | `100.0` |
| `MM_SAFETY_MARGIN` | Number | Profit margin added above maker exchange fees | `0.0005` (0.05%) |
| `MM_ATR_MULTIPLIER` | Number | Multiplier applied to rolling volatility | `2.0` |
| `MM_IMBALANCE_MULTIPLIER`| Number | Multiplier applied to book depth imbalance | `0.5` |
| `MM_SKEW_FACTOR` | Number | Inventory deviation skew coefficient | `0.001` |
| `MM_DAILY_STOP_LOSS` | Number | Daily hard portfolio drawdown halt limit | `-0.015` (-1.5%) |
| `MM_DRIFT_THRESHOLD` | Number | Mid-price drift threshold triggering order cancellation | `0.002` (0.2%) |

---

## 5. Installation and Execution

### 5.1. Install Dependencies
```bash
npm install
```

### 5.2. Synchronize Database Schema
Generates the Prisma Client and synchronizes the local SQLite database:
```bash
npm run db:push
```

### 5.3. Development Mode (with Hot-Reloading)
```bash
npm run dev
```

### 5.4. Production Build and Execution
Compile TypeScript source to `dist/` and run:
```bash
npm run build
npm start
```

---

## 6. Remote Repository and Version Control

* **Origin URL**: `git@github.com:Andr3wGustavo/crypto-tools.git`
* **Default Branch**: `main`

To push local commits to the remote GitHub repository:
```bash
git push -u origin main
```

---

## 7. License
ISC License. Designed for quantitative analysis and institutional algorithmic automation.
