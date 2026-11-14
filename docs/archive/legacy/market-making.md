# Institutional Adaptive Market Making Engine

## 1. Overview and Core Philosophy
The `MarketMakerEngine` (`src/modules/trading/market-maker.engine.ts`) is a high-frequency, maker-only algorithmic trading framework deployed on Binance Spot. Its core objective is to capture the bid-ask spread while dynamically adapting to market volatility and managing directional inventory risk.

---

## 2. Quantitative Model Formulations

### 2.1. Rolling Volatility Window ("Respiro")
Rather than relying on static spreads that lead to adverse selection during price expansion, the engine computes rolling tick-by-tick volatility over an $N=50$ window of mid-prices:

$$\text{Mid}_t = \frac{\text{Bid}_t + \text{Ask}_t}{2}$$

$$\text{Respiro} = \frac{1}{N-1} \sum_{i=2}^{N} \frac{|\text{Mid}_i - \text{Mid}_{i-1}|}{\text{Mid}_{i-1}}$$

If $\text{Respiro} < \text{feeMaker}$ (volatility lower than exchange trading costs), the market is deemed stagnant and the engine pauses quote placement to avoid paying spread costs on flat markets.

### 2.2. Dynamic Target Spread
The target spread must guarantee fee recovery plus profit margin, while expanding with volatility and order book depth imbalance:

$$\text{TargetSpread} = \max\left(2 \times \text{feeMaker} + \text{margin},\; k_1 \times \text{Respiro},\; k_2 \times |\text{Imbalance}|\right)$$

Where:
* $\text{feeMaker}$: Maker fee tier (e.g., 0.02% or 0% on promotional pairs).
* $\text{margin}$: Configured safety profit margin (`MM_SAFETY_MARGIN`, default 0.05%).
* $k_1$: Volatility multiplier coefficient (`MM_ATR_MULTIPLIER`, default 2.0).
* $k_2$: Order book depth imbalance multiplier (`MM_IMBALANCE_MULTIPLIER`, default 0.5).

### 2.3. Order Book Depth Imbalance
Computed continuously via the `@bookTicker` WebSocket feed:

$$\text{Imbalance} = \frac{\text{BidQty} - \text{AskQty}}{\text{BidQty} + \text{AskQty}} \in [-1.0, +1.0]$$

A positive imbalance indicates heavy bid demand (likely upward pressure), prompting spread expansion or quote adjustments.

### 2.4. Avellaneda-Stoikov Inventory Skew
When the bot accumulates excess base currency (e.g., BTC) beyond the target inventory ratio ($q_{\text{target}} = 0.5$), holding inventory exposes the strategy to directional market drawdown. The engine shifts the effective mid-price downward:

$$\text{InventoryDev} = q_{\text{current}} - q_{\text{target}}$$

$$\text{Skew} = \text{InventoryDev} \times \text{skewFactor}$$

$$\text{Mid}_{\text{effective}} = \text{Mid} \times (1 - \text{Skew})$$

* **When Long Inventory ($q > q_{\text{target}}$)**: $\text{Mid}_{\text{effective}}$ shifts down. The sell order moves closer to the best ask (increasing fill probability), while the buy order moves further away from the best bid (decreasing fill probability).
* **When Short Inventory ($q < q_{\text{target}}$)**: $\text{Mid}_{\text{effective}}$ shifts up to incentivize inventory replenishment.

---

## 3. Order Pricing and Dynamic Precision Rules

Quotes are centered around the skewed mid-price:

$$\text{BuyPrice} = \text{Mid}_{\text{effective}} \times \left(1 - \frac{\text{TargetSpread}}{2}\right)$$

$$\text{SellPrice} = \text{Mid}_{\text{effective}} \times \left(1 + \frac{\text{TargetSpread}}{2}\right)$$

### Arbitrary Precision Formatting (`ExchangeInfoService`)
Before submitting orders to Binance, prices and quantities must conform to exchange filters:
* Price must be an exact multiple of `PRICE_FILTER.tickSize`.
* Quantity must be an exact multiple of `LOT_SIZE.stepSize` and exceed `minQty`.
* Total notional value ($\text{Price} \times \text{Quantity}$) must exceed `minNotional`.

All calculations utilize `bignumber.js` to eliminate IEEE-754 floating-point rounding errors.

---

## 4. Execution Safety and Risk Controls

1. **Post-Only Maker Enforcement**: Uses order type `LIMIT_MAKER`. If an order would execute immediately as a taker, Binance rejects it instantly, guaranteeing zero taker fees.
2. **Dynamic Time-To-Live (TTL)**: Order lifespan scales with volatility:
   $$\text{TTL} = \max(3000\text{ms}, \min(10000\text{ms}, \lfloor\text{Respiro} \times 50 \times 1000\rfloor))$$
3. **Mid-Price Drift Cancellation**: While orders are resting on the book, the WebSocket stream monitors the live mid-price. If:
   $$\frac{|\text{Mid}_{\text{live}} - \text{Mid}_{\text{effective}}|}{\text{Mid}_{\text{effective}}} > \text{driftThreshold}\ (0.2\%)$$
   All open orders are canceled immediately to prevent adverse execution.
4. **Daily Hard Stop Loss**: If cumulative portfolio equity falls by `dailyStopLoss` (default -1.5%), the engine halts all trading activity and alerts Discord.

---

## 5. User Data Stream and Compound Reinvestment

1. `BinanceUserDataStreamService` maintains a `listenKey` WebSocket connection.
2. Captures `executionReport` events in real time.
3. Upon receiving `orderStatus === 'FILLED'`, the trade is logged to SQLite.
4. `CompoundService` calculates net captured spread and scales the base order size proportionally:
   $$\text{OrderSize}_{\text{new}} = \text{OrderSize}_{\text{base}} + (\text{TotalProfit} \times \text{ReinvestmentRatio} \times 0.10)$$
