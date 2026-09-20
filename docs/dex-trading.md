# Decentralized Exchange (DEX) Routing and Execution

## 1. Overview
The `JupiterService` (`src/modules/dex-trader/jupiter.service.ts`) provides quote resolution, routing aggregation, and simulation mechanics for decentralized tokens on Solana.

---

## 2. Routing Architecture (Jupiter v6 API)

### 2.1. Quote Discovery
* Endpoint: `GET https://quote-api.jup.ag/v6/quote`
* Parameters:
  * `inputMint`: Source token mint address (defaults to wrapped SOL: `So11111111111111111111111111111111111111112`).
  * `outputMint`: Target token mint address.
  * `amount`: Input amount denominated in integer lamports ($1\ \text{SOL} = 10^9\ \text{lamports}$).
  * `slippageBps`: Allowed slippage tolerance expressed in basis points ($100\ \text{bps} = 1.0\%$).

### 2.2. Liquidity Pool Aggregation
Jupiter splits and routes swaps across all major Solana decentralized exchanges:
* Raydium (AMM v4 & CPMM)
* Orca Whirlpools (Concentrated Liquidity)
* Meteora Dynamic Pools & DLMM
* Pump.fun Bonding Curves

The `routePlan` array is extracted and normalized to provide transparent visibility of intermediary swap hops.

---

## 3. Simulation Engine

Prior to transaction broadcasting, `JupiterService.simulateSwap` executes dry-run validation:
* **Output Token Yield**: Computes the exact gross and net token units expected.
* **Price Impact Evaluation**: Calculates expected slippage caused by order size relative to available pool depth.
* **Network Fee Estimation**: Accounts for standard base signature fees ($0.000005\ \text{SOL}$) and optional compute unit priority fees.

---

## 4. Discord Interface Integration

1. When a gem alert is dispatched to Discord, an interactive button `[Simulate Swap]` is attached.
2. Clicking the button triggers `simulateSwap` for $0.1\ \text{SOL}$ against the token mint.
3. An ephemeral message is returned directly to the user detailing price impact, expected token yield, and route hops.
4. Users can also execute the slash command:
   ```text
   /swap mint:<token_mint_address> amount_sol:0.5
   ```
