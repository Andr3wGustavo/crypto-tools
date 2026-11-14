# Project Status, Checklist and Technical Roadmap

Single source of truth tracking project status, completed architectural milestones, current execution state, pending work, and upcoming deliverables for the `crypto-tools` unified platform.

---

## 1. Overall System Status

* Repository: `git@github.com:Andr3wGustavo/crypto-tools.git`
* Current Branch: `main`
* Primary Runtime: Node.js (v20+ / v24 tested) with TypeScript 5.3+ (ES2022)
* Database: SQLite via Prisma ORM (Client v5.22.0)
* Core Services: 10+ Decoupled Modular Engines
* Build: `tsc --noEmit` passes (0 errors). Production build in `dist/`.

---

## 2. Completed Milestones (19)

| ID | Phase / Milestone | Status | Details |
| :--- | :--- | :--- | :--- |
| M1 | Repository Initialization & Architecture Unification | COMPLETED | Unified 8 scattered folders into a modular monorepo, preserved legacy files, configured Git origin |
| M2 | TypeScript Environment & Prisma Schema Setup | COMPLETED | Type-safe models: `Token`, `Trade`, `Position`, `MacroMetric` |
| M3 | DexScreener Radar & Token Ingestion | COMPLETED | `/token-profiles/latest/v1`, `/token-boosts/latest/v1`, batch token lookup |
| M4 | On-Chain Security & Anti-Honeypot Audit Engine | COMPLETED | GoPlus Security (EVM) and RugCheck (Solana) programmatic audit |
| M5 | Multi-Stage Heuristic Filtering Engine | COMPLETED | Liquidity, volume, age, and FDV-to-liquidity ratio anomaly verification |
| M6 | Google Gemini 2.0 Due Diligence & Fallback | COMPLETED | Structured JSON output with quantitative mathematical fallback |
| M7 | Historical Context & RAG Ready Persistence | COMPLETED | SQLite token database persistence and historical pattern retrieval |
| M8 | Macro Market Hub (crypto-info) | COMPLETED | Fear & Greed Index + real-time BTC and ETH benchmark pricing |
| M9 | Binance Adaptive Market Maker Engine | COMPLETED | Rolling Respiro volatility, Avellaneda-Stoikov skew, Post-Only `LIMIT_MAKER` |
| M10 | Binance Low-Latency WebSocket Stream | COMPLETED | `@bookTicker` stream with sub-50ms latency and zero REST rate-limit usage |
| M11 | Dynamic LOT_SIZE and PRICE_FILTER Resolution | COMPLETED | `ExchangeInfoService` with `bignumber.js` arbitrary precision |
| M12 | Compound Trading Engine (skeleton) | COMPLETED* | Automated profit reinvestment and position sizing expansion (*see gaps below*) |
| M13 | Position Gain Tracker & Trailing Stop Loss | COMPLETED | Real-time DexScreener price polling, peak tracking, trailing stop alerts |
| M14 | Discord Alpha Terminal Client | COMPLETED | Slash commands (`/analyze`, `/radar`, `/market`, `/mm`, `/gains`) + interactive buttons |
| M15 | Production Documentation & Architecture Guides | COMPLETED | Exhaustive documentation hub inside `docs/` (8 technical guides, 0 emojis) |
| M16 | Vector RAG Engine with Embeddings | COMPLETED | Gemini text embeddings (`text-embedding-004`) and cosine similarity matching |
| M17 | DEX Automated Swap & Execution (Jupiter v6) | COMPLETED | Swap routing, price impact calculation, and dry-run simulation mode |
| M18 | Interactive Discord UI (Action Buttons) | COMPLETED | `[DexScreener Chart]`, `[Track Position]`, and `[Simulate Swap]` button components |
| M19 | Binance WebSocket User Data Stream | COMPLETED | Order fill confirmation via `listenKey` execution reports and compound routing |

---

## 3. Pending Work Checklist

### 3.1 Infrastructure / DevOps
- [ ] Commit and push pending changes (legacy removed, deps, env vars) — repo currently dirty.
- [ ] Dockerfile + PM2 / 24/7 deploy.
- [ ] Web dashboard (React/Vite) for capital curve and execution points.
- [ ] Automated tests (unit + integration) — currently none.
- [ ] CI/CD (GitHub Actions: tsc + test + build).
- [ ] Retry / circuit-breaker on external APIs (DexScreener, GoPlus, RugCheck, Gemini).
- [ ] SQLite backup / optional Postgres for scale.

### 3.2 Trading / Market Maker
- [ ] Real inventory query (Binance account) for Avellaneda-Stoikov skew — currently `skew = 0` hardcoded.
- [ ] Effective daily stop-loss (-1.5%) — env exists, not implemented.
- [ ] Multi-level order grid (`MM_GRID_LEVELS` not used).
- [ ] Multi-symbol / multi-pair (currently 1 pair).
- [ ] Order reconciliation (real fills vs expected).
- [ ] Real per-cycle PnL (buy vs sell) instead of estimate.
- [ ] Kill switch / dry-run mode for MM.

### 3.3 Compound / Capital Management (FOCUS)
- [ ] **Critical bug:** `recordProfit` returns `newOrderSize`, but the MM engine ignores the return and always uses `env.MM_MIN_ORDER_USD`. Compound does NOT affect order size.
- [ ] Profit is **estimated** (`cumulativeQuoteQty * 0.001`) instead of measured (real round-trip).
- [ ] No **cost basis** tracking per cycle (does not know buy price).
- [ ] No **persistence** of compound capital (resets on restart).
- [ ] No **position cap** (max order size) — can grow unbounded.
- [ ] No **drawdown limit** / capital protection.
- [ ] No formal **profit stacking** (stacked reserve vs reinvested).
- [ ] No formal **exponential reinvestment** (geometric formula).
- [ ] **Micro trades:** orders cancelled by TTL; if only one side fills, an open directional position remains with no hedge/reversal.
- [ ] No guaranteed ping-pong (buy and sell may not match).

### 3.4 DEX Sniper (Solana)
- [ ] Create `solana-wallet.service.ts` (keypair, RPC, signing) with `@solana/web3.js`.
- [ ] Real swap executor via Jupiter (quote -> tx -> send -> confirm).
- [ ] Configurable slippage, priority fees, retry.
- [ ] Auto-buy when gem score >= `DEX_MIN_AI_SCORE`, locked liquidity, zero taxes.
- [ ] Auto-sell / take-profit / trailing stop on-chain.
- [ ] MEV/sandwich protection (Jito bundles, optional).
- [ ] Dedup/cooldown to avoid buying the same token twice.

### 3.5 RAG / AI / Data
- [ ] Efficient vector search (in-memory cosine over SQLite does not scale).
- [ ] Embeddings for all tokens (fire-and-forget can fail silently).
- [ ] Gemini JSON schema validation with zod.
- [ ] Test heuristic fallback.

### 3.6 Discord / UX
- [ ] `/compound` command (capital stats) and `/snipe` command (auto-buy control).
- [ ] Drawdown / stop-loss alerts.
- [ ] Pagination in listings (gains, radar).
- [ ] Interaction timeout handling (Discord 3s limit).

### 3.7 Security / Risk / Quality
- [ ] Input sanitization (addresses).
- [ ] Order limits enforced in compound (min notional, max position).
- [ ] Linting (eslint) + prettier.
- [ ] Unit tests for `ExchangeInfoService`, `CompoundService`, filters, calculations.

---

## 4. Compound & Autotrade with Micro Trades: Mathematics

### 4.1 Current Implementation (Broken)

```ts
// compound.service.ts
recordProfit(realizedProfitUsd, baseOrderSize): number {
    this.currentCapital += realizedProfitUsd;
    const totalProfit = this.currentCapital - this.baseCapital;
    if (totalProfit > 0) {
        const addedOrderAllocation = totalProfit * this.reinvestmentRatio; // 0.5
        const newOrderSize = baseOrderSize + (addedOrderAllocation * 0.1); // 10% of profit
        return newOrderSize; // <-- NOBODY CONSUMES THIS RETURN
    }
    return baseOrderSize;
}
```

```ts
// binance-user-stream.service.ts
if (event.side === 'SELL') {
    const approxProfit = event.cumulativeQuoteQty * 0.001; // 0.1% of sell volume
    this.compoundService.recordProfit(approxProfit, env.MM_MIN_ORDER_USD);
}
```

**Fatal flaws:**
1. **Estimated profit, not measured.** `0.1% of sell volume` is not profit. Real profit of a round-trip is `(P_sell - P_buy) * Q - fees`, and only exists if **both** sides execute. If only the sell executes, it is a short position with risk, not profit.
2. **Computed size is discarded.** The MM engine always uses `env.MM_MIN_ORDER_USD`. Compound affects nothing.
3. **No cost basis.** Does not know the buy price to compute the corresponding sell profit.
4. **No persistence.** Capital resets on restart.
5. **No formal stacking.** Profits are summed into `currentCapital` but not split into reinvested vs protected reserve.
6. **No protection.** No position cap, no drawdown limit.

**Verdict: today the compound logic does NOT work.** It is a skeleton that adds a fictitious number and returns a value nobody consumes.

### 4.2 Correct Mathematics for Compound with Micro Trades

**Definitions:**
- Capital allocated to cycle: `C_i`
- Buy price: `P_buy`, sell price: `P_sell = P_buy * (1 + s)` where `s` = target spread
- Quantity: `Q_i = f * C_i / P_mid` (micro trade: `f` small, e.g. 0.1-0.3 of capital per order)
- Maker fee per side: `phi` (e.g. 0.0002 or 0 on promo pairs)

**Real profit of a round-trip (both sides execute):**
```
L_i = Q_i * (P_sell - P_buy) - 2 * phi * Q_i * P_mid
    = Q_i * P_mid * [s - 2*phi]
```

**Return rate per cycle:**
```
r_i = L_i / C_i = f * [s - 2*phi]
```

**Compound (profit stacking):**
```
C_{i+1} = C_i + rho * L_i       (rho = reinvestment ratio, 0 < rho <= 1)
```
The remainder `(1 - rho)` stays in a **protected reserve** (bankroll against drawdown).

**Exponential growth (if r_i ~ r constant):**
```
C_n = C_0 * (1 + rho * f * (s - 2*phi))^n
```

With **micro trades** (n large), even a small `r` produces exponential growth — the law of large numbers applied to many small-spread cycles.

**Edge condition (positive expected profit):**
```
s > 2*phi + cost_of_adverse_selection
```
If `s < 2*phi`, the edge is negative -> **ruin** (compound accelerates the loss).

**Profit stacking with protection:**
```
C_{i+1} = min(C_i + rho * L_i, C_max)          // position cap
D_i = (C_peak - C_i) / C_peak                   // drawdown
if D_i > D_max (e.g. 0.15) -> HALT             // capital stop-loss
```

**Adverse selection (the enemy of compound):**
If price drops after the buy, the stuck position becomes a loss. The Avellaneda-Stoikov skew mitigates:
```
P_eff = P_mid * (1 - (I - I_target) * skewFactor)
```
where `I` = current inventory, `I_target` = 0.5. Without real skew (as today, `skew = 0`), the MM accumulates inventory and the estimated "profits" become real losses.

### 4.3 Answer: "Does this logic work?"

**Mathematically, yes — but only if 5 conditions are met:**

1. **Positive edge:** `captured spread > 2 * fee + adverse selection`.
2. **Profit measured for real** (real round-trip), not estimated.
3. **Order size updated** with compound (fix the ignored return bug).
4. **Drawdown protection + position cap** (avoid exponential ruin).
5. **Inventory managed** (real skew, not zero).

Without these 5, the current compound is **illusory**: it adds a fictitious profit (0.1% of volume) and does not affect order size. In other words, **today it does not work** — it is a skeleton.

**The good news:** the base (WS, exchange-info, adapter, user stream) is already there. What is missing is:
- Real buy/sell pairing per cycle (track buy `orderId` to match the sell).
- Compute real `L_i`.
- Apply `C_{i+1}` to the next cycle's `Q_i` (close the loop).
- Persist `C_i` in SQLite (new `CapitalState` model or field in `Trade`).
- Add real skew by querying the Binance account.
- Add drawdown limit and cap.

---

## 5. Implementation Priority Order

1. **Close the compound loop** (1-2 days): pair buy/sell per cycle, compute real `L_i`, apply `newOrderSize` in the MM engine, persist capital. *This turns the skeleton into something that actually compounds.*
2. **Real inventory skew** (1 day): query `/api/v3/account`, compute `I`, apply Avellaneda-Stoikov. *Without this, compound accumulates losses from adverse selection.*
3. **Drawdown limit + position cap** (0.5 day): capital protection.
4. **Commit/push + Docker/PM2** (0.5 day): stabilize what already exists.
5. **Real Solana sniper** (2-3 days): auto-buy with burner wallet + Jupiter tx.
6. **Multi-level grid** (1-2 days): capture flash wicks.
7. **Tests + CI** (continuous): prevent regressions in PnL math.

---

## 6. Next Action

Starting with **Priority 1: close the compound loop**. This is the highest-impact change and the one that unlocks the mathematics of profit stacking with micro trades.
