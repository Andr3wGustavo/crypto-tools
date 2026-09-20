# Discord Alpha Terminal and Interactive Interface

## 1. Overview
The `DiscordBotService` (`src/modules/discord/bot.ts`) acts as the interactive presentation layer for the `crypto-tools` suite, supporting slash commands, rich embed notifications, interactive action buttons, and background dispatchers.

---

## 2. Slash Command Reference

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `/analyze` | `address` (Required, String) | Performs instant on-chain security audit and Gemini AI due diligence on any token or pair address across EVM and Solana networks. |
| `/ask` | `query` (Required, String) | Converts query into a vector embedding and searches SQLite database for top 3 historically similar tokens. |
| `/track` | `address` (Required, String), `entry_price` (Required, Number), `trailing_stop` (Optional, Number) | Enrolls a position into the real-time gain and trailing stop tracking engine. |
| `/swap` | `mint` (Required, String), `amount_sol` (Optional, Number) | Simulates a decentralized swap quote via Jupiter v6, outputting price impact and route hops. |
| `/market` | None | Displays macro market overview: Fear and Greed Index, Bitcoin benchmark, Ethereum benchmark. |
| `/radar` | None | Displays aggregate metrics: total scanned tokens, verified gems identified, and scams filtered. |
| `/mm` | `action` (Optional: `status`, `start`, `stop`) | Inspects or controls the Binance Adaptive Market Maker engine. |
| `/gains` | None | Displays all actively monitored positions with current PnL and peak records. |

---

## 3. Interactive Components and Button Actions

Every automated gem alert dispatched to the Discord alert channel includes an interactive `ActionRow`:

```
+-------------------------------------------------------------------------+
|                          DISCORD ALERT CARD                             |
|  Title: GEM CANDIDATE: TokenName ($SYMBOL)                              |
|  Fields: Price, Liquidity, FDV, 24h Volume, AI Score, Security Audit    |
+-------------------------------------------------------------------------+
|  [ DexScreener Chart ]  |  [ Track Position ]  |  [ Simulate Swap ]     |
+-------------------------------------------------------------------------+
```

### Button Behaviors:
1. **`[DexScreener Chart]`**: Link button directing immediately to the DexScreener interactive trading chart.
2. **`[Track Position]`**: Custom ID `track_<pairAddress>_<symbol>`. Captures current live price and creates an active position in SQLite with a 15% trailing stop.
3. **`[Simulate Swap]`**: Custom ID `swap_<mintAddress>_<symbol>`. Queries Jupiter v6 for a 0.1 SOL swap simulation and returns price impact and route hops as an ephemeral reply.

---

## 4. Channel Routing and Webhook Logic
* `DISCORD_ALERT_CHANNEL_ID`: Designates the target channel for high-conviction gem discoveries (score >= 80) and on-demand audits.
* `DISCORD_TRADING_CHANNEL_ID`: Designates the target channel for Market Maker cycle logs, order fill execution reports, and trailing stop alerts.
