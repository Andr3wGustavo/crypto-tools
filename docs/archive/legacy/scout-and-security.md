# Scouting, Ingestion, and On-Chain Security Auditing

## 1. DexScreener Ingestion Engine (`src/modules/scout/dexscreener.service.ts`)

### 1.1. Endpoints Utilized
* **Token Profiles Feed**: `GET https://api.dexscreener.com/token-profiles/latest/v1`
  * Returns recently updated token profiles with developer descriptions, verified links (websites, telegram, x/twitter), and icons.
* **Token Boosts Feed**: `GET https://api.dexscreener.com/token-boosts/latest/v1`
  * Returns active tokens receiving community boosts, serving as an indicator of real-time trading attention.
* **Multi-Token Batch Lookup**: `GET https://api.dexscreener.com/latest/dex/tokens/{addressList}`
  * Aggregates multiple candidate contract addresses (up to 30 per call) into a single HTTP round-trip, optimizing throughput and rate-limit preservation.
* **Direct Pair Lookup**: `GET https://api.dexscreener.com/latest/dex/pairs/{chainId}/{pairAddress}`
  * Retrieves granular metrics for an explicit liquidity pool.

### 1.2. Ingested Data Attributes
For every pair, the service extracts:
* Pair and token contract addresses.
* Network identifier (`solana`, `ethereum`, `base`, `bsc`, `arbitrum`).
* Decentralized exchange identifier (`raydium`, `uniswap`, `pancakeswap`, `meteora`, `orca`).
* Current price in USD and native currency.
* Liquidity pool depth in USD, base token, and quote token.
* Fully diluted valuation (FDV).
* Buy and sell transaction volume across 5-minute, 1-hour, 6-hour, and 24-hour windows.
* Creation timestamp of the liquidity pair (`pairCreatedAt`).

---

## 2. Smart Contract Security Audit Engine (`src/modules/scout/security.service.ts`)

### 2.1. EVM Networks (GoPlus Security API)
EVM tokens are audited via GoPlus Security REST endpoint:
`GET https://api.gopluslabs.io/api/v1/token_security/{chainId}?contract_addresses={address}`

Supported chain IDs:
* Ethereum Mainnet: `1`
* Binance Smart Chain: `56`
* Polygon: `137`
* Base: `8453`
* Arbitrum One: `42161`
* Avalanche C-Chain: `43114`
* Optimism: `10`

#### Evaluated Security Parameters:
* **Honeypot (`is_honeypot`)**: Simulated transaction validation. A value of `"1"` indicates a verified honeypot (tokens cannot be sold).
* **Transfer Taxes (`buy_tax`, `sell_tax`)**: Transfer fee percentages. Fees exceeding 10% are categorized as high-risk; fees exceeding 50% are categorized as scams.
* **Supply Inflation (`is_mintable`)**: Identifies contracts where the deployer or owner retains permissions to mint additional tokens.
* **Address Restrictions (`is_blacklisted`)**: Identifies contracts containing address-level transfer restriction mechanics.
* **Ownership Recovery (`can_take_back_ownership`)**: Identifies whether ownership can be reclaimed after renouncement via administrative proxies.
* **Sell Constraints (`cannot_sell_all`)**: Identifies restrictions preventing users from liquidating their full token balance.

### 2.2. Solana Network (RugCheck API)
Solana SPL tokens are audited via RugCheck API:
`GET https://api.rugcheck.xyz/v1/tokens/{mintAddress}/report/summary`

#### Evaluated Security Parameters:
* **Mint Authority**: Verifies whether the SPL token mint authority has been set to `null` (preventing unauthorized token inflation).
* **Freeze Authority**: Verifies whether the SPL token freeze authority has been revoked (preventing wallet account freezing).
* **Liquidity Pool Burn / Lock Score**: Evaluates whether the LP tokens have been permanently burned to the dead address or locked in verified lockers.
* **Aggregate Risk Score**: Scores exceeding 1,500 points denote critical security vulnerabilities.

---

## 3. Multi-Stage Heuristic Filtering (`src/modules/scout/filter.service.ts`)

Candidates must pass five sequential validation stages before forwarding to the AI evaluation engine:

1. **Critical Security Gate**: Rejects the pair immediately if `isHoneypot === true`, or if buy/sell taxes exceed 10%.
2. **Liquidity Floor**: `liquidityUsd >= MIN_LIQUIDITY_USD` (default: $10,000 USD).
3. **Volume Floor**: `volume24h >= MIN_VOLUME_USD_24H` (default: $25,000 USD).
4. **Age Boundary**: `ageHours <= MAX_AGE_HOURS` (default: 72 hours).
5. **FDV-to-Liquidity Ratio Ceiling**:
   $$\text{Ratio} = \frac{\text{FDV}}{\text{Liquidity}_{\text{USD}}}$$
   If $\text{Ratio} > 200$, the pair is classified as an illiquid pump-and-dump candidate and rejected.
